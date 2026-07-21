import RAPIER from '@dimforge/rapier3d-compat';
import { BoxGeometry, CircleGeometry, Group, Mesh, MeshStandardMaterial, TorusGeometry } from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import type { Damageable } from './Damageable';
import type { Fragment } from './Destructible';
import { Explosion } from '../effects/Explosion';
import { Logger } from '../utils/Logger';

const log = Logger.create('Resupply');

/**
 * 补给点 —— 可摧毁、定时再生的弹药装填点
 * ============================================================
 * 职责:
 *  - 提供"装填区域"(地面圆盘半径内):坦克驶入由 ResupplySystem 装填弹药。
 *  - 实现 Damageable 接口,无缝融入 DestructionSystem.applyDamage 伤害链:
 *    炮弹爆炸 / 坦克撞击都会扣 HP;HP 归零 → destroyed,倒计时 regenTime 后原位复活。
 *
 * 状态机:
 *  - intact   : 可用(圆盘亮绿 + 建筑可见 + 标识旋转)。可受击、可装填。
 *  - destroyed: 被毁(圆盘暗红 + 建筑隐藏)。不装填、不再受击;倒计时到自动复活。
 *
 * 物理:中央补给站是 fixed 实心 collider(坦克撞不上,需绕行至半径内装填;
 *       炮弹/撞击命中经 applyDamage 伤害它)。地面圆盘无物理(纯视觉标识)。
 *
 * 视觉引导(用视觉而非文字):发光圆盘一眼可辨"这是个区域",顶部旋转环引导视线,
 *   摧毁时圆盘转暗红+大爆炸,再生时自动恢复——玩家无需任何文字说明即可理解。
 */
export class ResupplyPoint implements Damageable {
  state: 'intact' | 'destroyed' = 'intact';
  private readonly physics: PhysicsWorld;
  private readonly render: RenderScene;
  private readonly center: { x: number; y: number; z: number };
  private readonly maxHp: number;
  private hp: number;
  /** destroyed 状态下的再生倒计时(s),由 update 递减 */
  private regenTimer = 0;

  // 物理(中央补给站建筑)——body public readonly 以满足 Damageable.body 接口契约
  readonly body: RAPIER.RigidBody;
  readonly colliderHandle: number;
  /** 物理 collider 引用:摧毁时 setEnabled(false) 让坦克穿过残骸,再生时恢复 */
  private readonly collider: RAPIER.Collider;
  /** 摧毁爆炸等特效(本实体自管 update/dispose,避免无人推进导致粒子停滞+泄漏) */
  private effects: Explosion[] = [];

  // 视觉
  private readonly disk: Mesh; // 地面发光圆盘(标识装填区)
  private readonly diskMat: MeshStandardMaterial; // 独立材质(摧毁/再生时改色)
  private readonly station: Mesh; // 中央补给站建筑(弹药箱)
  private readonly markerGroup: Group; // 顶部旋转标识(引导视线)

  /** 单位圆几何(所有补给点共享,scale 到各自半径) */
  private static readonly diskGeo = new CircleGeometry(1, 48);

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    pos: { x: number; y?: number; z: number },
  ) {
    this.physics = physics;
    this.render = render;
    const cfg = CONFIG.resupplyPoint;
    const groundY = pos.y ?? 0; // 地形高度(贴地;不传=0 兼容平面)
    this.center = { x: pos.x, y: groundY, z: pos.z };
    this.maxHp = cfg.hp;
    this.hp = cfg.hp;

    // —— 中央补给站(fixed 实心 collider) ——
    const sh = cfg.stationHalf;
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, groundY + sh.y, pos.z),
    );
    const col = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(sh.x, sh.y, sh.z)
        .setFriction(0.8)
        .setRestitution(0.1)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), // 坦克撞击需事件上报(handleCollision 才能伤害)
      this.body,
    );
    this.colliderHandle = col.handle;
    this.collider = col;

    // —— 地面发光圆盘(标识装填区域,半径=resupplyRadius) ——
    this.diskMat = new MeshStandardMaterial({
      color: 0x1a4a2a,
      emissive: 0x2a8a3a,
      emissiveIntensity: 0.8,
      roughness: 0.6,
      metalness: 0,
      transparent: true,
      opacity: 0.55,
    });
    this.disk = new Mesh(ResupplyPoint.diskGeo, this.diskMat);
    this.disk.rotation.x = -Math.PI / 2; // 平铺地面
    this.disk.position.set(pos.x, groundY + 0.06, pos.z); // 略离地面防 z-fighting
    this.disk.scale.setScalar(CONFIG.ammo.resupplyRadius);
    render.scene.add(this.disk);

    // —— 中央补给站建筑(弹药箱,军事黄绿警示色) ——
    const stationGeo = new BoxGeometry(sh.x * 2, sh.y * 2, sh.z * 2);
    const stationMat = new MeshStandardMaterial({
      color: 0x6a5a2a,
      roughness: 0.8,
      metalness: 0.1,
    });
    this.station = new Mesh(stationGeo, stationMat);
    this.station.position.set(pos.x, groundY + sh.y, pos.z);
    this.station.castShadow = true;
    this.station.receiveShadow = true;
    render.scene.add(this.station);

    // —— 顶部旋转标识(发光细环,缓慢自转引导"这里是补给点") ——
    // 用 Group 包裹:绕 Group 的 y 轴旋转,轴明确无欧拉顺序歧义。
    this.markerGroup = new Group();
    this.markerGroup.position.set(pos.x, groundY + sh.y * 2 + 0.6, pos.z);
    const markerGeo = new TorusGeometry(sh.x * 1.4, 0.06, 8, 32);
    const markerMat = new MeshStandardMaterial({
      color: 0xffe066,
      emissive: 0xffcc33,
      emissiveIntensity: 1.0,
      roughness: 0.4,
    });
    const marker = new Mesh(markerGeo, markerMat);
    marker.rotation.x = Math.PI / 2; // 环面水平
    this.markerGroup.add(marker);
    render.scene.add(this.markerGroup);

    log.info('resupply point built', { at: `${pos.x},${pos.z}`, hp: this.maxHp });
  }

  /**
   * 受击(由 DestructionSystem.applyDamage 统一调用)。
   * HP 归零 → destroyed + 强化爆炸反馈。不返回碎片(炮弹自身爆炸已足够)。
   */
  takeHit(_epicenter: { x: number; y: number; z: number }, damage: number): Fragment[] {
    if (this.state !== 'intact') return [];
    this.hp -= damage;
    log.info('resupply hit', { hp: this.hp.toFixed(0), dmg: damage.toFixed(0) });
    if (this.hp <= 0) this.destroy();
    return [];
  }

  /** 摧毁:切换 destroyed 态 + 视觉转暗 + 强化爆炸 */
  private destroy(): void {
    this.state = 'destroyed';
    this.hp = 0;
    this.regenTimer = CONFIG.resupplyPoint.regenTime;
    // 视觉:圆盘暗红、建筑/标识隐藏(表示"已毁,不可用")
    this.diskMat.emissive.setHex(0x6a2a2a);
    this.diskMat.color.setHex(0x4a1a1a);
    this.station.visible = false;
    this.markerGroup.visible = false;
    // 禁用物理 collider:摧毁后坦克可穿过残骸(否则视觉隐藏但碰撞体仍在 = 空气墙)
    this.collider.setEnabled(false);
    // 强化爆炸(scale=2.5 放大粒子数/大小/寿命,震撼反馈);由本实体 update 自管回收
    const t = this.body.translation();
    this.effects.push(new Explosion(this.render, { x: t.x, y: t.y + 0.5, z: t.z }, 2.5));
    log.warn('resupply DESTROYED', { at: `${this.center.x},${this.center.z}`, regen: `${this.regenTimer}s` });
  }

  /** 每帧更新:特效回收 + destroyed 倒计时再生 + intact 标识旋转。由 ResupplySystem 调用 */
  update(dt: number): void {
    // 特效推进+回收(无论状态:确保摧毁爆炸能播完,避免无人 update 导致粒子停滞+泄漏)
    this.effects = this.effects.filter((e) => {
      if (e.update(dt)) return true;
      e.dispose(this.render);
      return false;
    });
    if (this.state === 'destroyed') {
      this.regenTimer -= dt;
      if (this.regenTimer <= 0) this.regen();
      return;
    }
    // 标识缓慢自转(引导视线,仅 intact 时可见)
    this.markerGroup.rotation.y += dt * 1.2;
  }

  /** 再生:复活为 intact + 视觉恢复 */
  private regen(): void {
    this.state = 'intact';
    this.hp = this.maxHp;
    this.regenTimer = 0;
    this.diskMat.emissive.setHex(0x2a8a3a);
    this.diskMat.color.setHex(0x1a4a2a);
    this.station.visible = true;
    this.markerGroup.visible = true;
    // 重新启用物理 collider:复活后建筑恢复碰撞(坦克又撞不上,需绕行至半径内装填)
    this.collider.setEnabled(true);
    log.info('resupply REGENERATED', { at: `${this.center.x},${this.center.z}` });
  }

  /** 坦克是否在装填范围内(水平距离)。仅 intact 有效;destroyed 返回 false */
  contains(pos: { x: number; z: number }): boolean {
    if (this.state !== 'intact') return false;
    const dx = pos.x - this.center.x;
    const dz = pos.z - this.center.z;
    const r = CONFIG.ammo.resupplyRadius;
    return dx * dx + dz * dz <= r * r;
  }

  /** 中心水平位置(NPC 导航目标用) */
  get position(): { x: number; z: number } {
    return { x: this.center.x, z: this.center.z };
  }

  /** 诊断:耐久比例 */
  get integrity(): number {
    return this.maxHp > 0 ? this.hp / this.maxHp : 0;
  }

  dispose(): void {
    this.physics.world.removeRigidBody(this.body);
    this.render.scene.remove(this.disk, this.station, this.markerGroup);
    this.diskMat.dispose();
    this.station.geometry.dispose();
    (this.station.material as MeshStandardMaterial).dispose();
    this.markerGroup.children.forEach((c) => {
      if (c instanceof Mesh) {
        c.geometry.dispose();
        (c.material as MeshStandardMaterial).dispose();
      }
    });
    // 残留特效清理
    for (const e of this.effects) e.dispose(this.render);
    this.effects = [];
    // diskGeo 是 static 共享,不在此释放
  }
}
