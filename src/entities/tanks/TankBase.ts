import RAPIER from '@dimforge/rapier3d-compat';
import {
  BufferGeometry,
  CanvasTexture,
  Group,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  Texture,
  Vector3,
} from 'three';
import { CONFIG, type NpcTier, type Team } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import { SyncBridge } from '../../core/SyncBridge';
import { Explosion } from '../../effects/Explosion';
import { Smoke } from '../../effects/Smoke';
import type { IControllableTank, DriveConfig } from '../IControllableTank';
import type { Fragment } from '../Destructible';
import { TankStatus, type TankPart } from '../TankStatus';
import { nextTankId } from '../TankId';
import { Logger } from '../../utils/Logger';

const log = Logger.create('TankBase');

/** 坦克物理规格 */
export interface TankSpec {
  name: string;
  bodyHalf: { x: number; y: number; z: number };
  mass?: number;
  initialBodyType: RAPIER.RigidBodyType;
  colliderOffset?: { x: number; y: number; z: number };
  colliderDensity?: number;
  lockRotations?: boolean;
  damage: {
    maxHp: number;
    smokeThreshold: number;
    destroyExplosionScale: number;
    destroySmokeScale: number;
    /** 脱战回血:最后一次受击后多少秒开始回血(可选,不设=不回血)。1VN 续战力 */
    regenDelay?: number;
    /** 回血速率(HP/秒) */
    regenRate?: number;
  };
  smokeOffset: { x: number; y: number; z: number };
}

/** 子类 buildVisuals 返回的视觉对象 */
export interface TankVisuals {
  group: Group;
  hullSway?: Group;
  turret: Group;
  barrel: Group;
  muzzle: Object3D;
  leftTrackTex: CanvasTexture;
  rightTrackTex: CanvasTexture;
  barrelBaseZ: number;
}

/**
 * 坦克抽象基类
 * ============================================================
 * 所有车型的公共逻辑：物理创建、HP、履带纹理、炮口计算、受伤、冒烟/爆炸、
 * 附身/释放、资源释放。子类只需实现外形构造、驾驶参数、击毁表现。
 */
export abstract class TankBase implements IControllableTank {
  readonly body: RAPIER.RigidBody;
  readonly colliderHandle: number;
  readonly group: Group;
  readonly turret: Group;
  readonly barrel: Group;
  readonly muzzle: Object3D;
  readonly hullSway?: Group;
  /** 实例唯一 ID(自增,从 1 开始),区分同型号多辆 */
  readonly id = nextTankId();

  state: 'intact' | 'destroyed' = 'intact';

  /**
   * 运行时状态聚合层(履带 debuff / 引擎过载 / 装甲倾斜 等临时状态统一聚合)。
   * 所有车型共享,字段初始化器构造即建。TankController/DestructionSystem 只读其系数。
   */
  readonly status = new TankStatus();

  /**
   * 弱点部位 sensor collider 列表(M2):构造时填充(炮塔 + 左右履带)。
   * sensor 不参与物理碰撞(不挡坦克/炮弹),只报碰撞事件供 AP 直击判定部位。
   * DestructionSystem 据此构建 partByCollider 反查表。
   */
  readonly partColliders: ReadonlyArray<{ handle: number; part: TankPart }>;

  /** NPC 难度档位(仅 NPC 有;undefined=玩家/中立,走原配色)。构造注入,director 决定。 */
  readonly tier?: NpcTier;

  /** 阵营(构造注入,所有坦克必有)。迷雾系统据此判定显隐(只隐藏 enemy)。 */
  readonly team: Team;

  protected readonly spec: TankSpec;
  protected readonly physics: PhysicsWorld;
  protected readonly render: RenderScene;
  protected readonly leftTrackTex: CanvasTexture;
  protected readonly rightTrackTex: CanvasTexture;

  private hp: number;
  private readonly startHp: number;
  /** 最后受击时刻(performance.now 毫秒),脱战回血计时基准。
   *  初始 -1(哨兵):未受击时不触发脱战回血(避免 lastHitTime=0 时 performance.now()-0 为极大值导致立即回血) */
  private lastHitTime = -1;
  private smoke?: Smoke;
  /** scorch 前收集的纹理引用(scorch 会将 material.map 置 null,dispose 遍历 group 收集不到,需单独保存) */
  private scorchTextures: Texture[] = [];
  private readonly explosions: Explosion[] = [];

  // —— 技能视觉特效 ——
  /** 装甲倾斜:蓝色半透能量护盾(opacity 呼吸)。
   *  boost(过载)无车体特效——靠扬尘增强反馈(TankController.updateDust)。
   *  scout(侦查)无车体特效——静默生效。 */
  private armorVfx?: Mesh;
  /** 特效动画时间累积(armor 呼吸用) */
  private vfxTime = 0;
  /**
   *  子类设为 true 表示 geometry/texture 由外部(如 GltfTankAsset)共享管理,
   *  dispose 时只释放独立 clone 的 material 和占位纹理,不释放共享的 geometry/glb 纹理。
   *  修复:GltfTank 实例间共享 glb 几何/纹理,一个 dispose 释放会破坏其他实例渲染。
   */
  protected geometryIsShared = false;
  protected turretBody?: RAPIER.RigidBody;
  private readonly _barrelBaseZ: number;
  /** 调试命令 tw.hp 的安全上限:允许远超正常 maxHp,但拦截 Infinity/NaN/过大值避免日志 toFixed 异常 */
  private static readonly DEBUG_HP_CEILING = 1_000_000;

  // 复用临时对象
  private readonly _muzzleWorld = new Vector3();
  private static readonly _mDirA = new Vector3();
  private static readonly _mDirB = new Vector3();

  abstract get driveConfig(): DriveConfig;
  protected abstract getSpec(): TankSpec;
  protected abstract buildVisuals(): TankVisuals;
  protected abstract onDestroy(epicenter: { x: number; y: number; z: number }): Fragment[];

  get name(): string {
    return this.spec.name;
  }

  /** 展示名 = 型号 + #id,HUD/日志统一用此避免重名 */
  get displayName(): string {
    return `${this.name} #${this.id}`;
  }

  get barrelBaseZ(): number {
    return this._barrelBaseZ;
  }

  constructor(physics: PhysicsWorld, render: RenderScene, spawn: { x: number; y: number; z: number }, team: Team, tier?: NpcTier) {
    this.physics = physics;
    this.render = render;
    this.spec = this.getSpec();
    this.startHp = this.spec.damage.maxHp;
    this.hp = this.startHp;
    this.team = team;
    this.tier = tier;

    // ---- 物理车身 ----
    const bodyDesc =
      this.spec.initialBodyType === RAPIER.RigidBodyType.Dynamic
        ? RAPIER.RigidBodyDesc.dynamic()
            .setLinearDamping(0.6)
            .setAngularDamping(2.5)
            .enabledRotations(false, true, false)
            .setCcdEnabled(true)
        : RAPIER.RigidBodyDesc.fixed();
    bodyDesc.setTranslation(spawn.x, spawn.y, spawn.z);
    this.body = physics.world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.cuboid(
      this.spec.bodyHalf.x,
      this.spec.bodyHalf.y,
      this.spec.bodyHalf.z,
    )
      .setFriction(0.8)
      .setRestitution(0.0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (this.spec.mass !== undefined) colDesc.setMass(this.spec.mass);
    if (this.spec.colliderDensity !== undefined) colDesc.setDensity(this.spec.colliderDensity);
    if (this.spec.colliderOffset) {
      colDesc.setTranslation(this.spec.colliderOffset.x, this.spec.colliderOffset.y, this.spec.colliderOffset.z);
    }
    const col = physics.world.createCollider(colDesc, this.body);
    this.colliderHandle = col.handle;

    // ---- 部位 sensor collider(M2 弱点部位)----
    // 挂在 body 上,sensor=true 不参与物理推挤(不改变坦克碰撞体/不挡炮弹),
    // 只开启碰撞事件供 AP 直击管线按命中部位注入 debuff。
    // 位置基于主 collider 中心(spec.colliderOffset)推导,适配各车型(T-14 无 offset,
    // 静态坦克 colliderOffset.y=bodyHalf.y 上移到车体)。
    this.partColliders = this.buildPartColliders(physics);

    // ---- 视觉构造 ----
    const visuals = this.buildVisuals();
    this.group = visuals.group;
    this.hullSway = visuals.hullSway;
    this.turret = visuals.turret;
    this.barrel = visuals.barrel;
    this.muzzle = visuals.muzzle;
    this.leftTrackTex = visuals.leftTrackTex;
    this.rightTrackTex = visuals.rightTrackTex;
    this._barrelBaseZ = visuals.barrelBaseZ;

    render.scene.add(this.group);
    SyncBridge.bind(this.body, this.group);

    // 技能视觉特效(boost/armor/scout),初始隐藏,update 中按 status 显隐
    this.buildSkillVfx();

    log.info('tank spawned', { name: this.name, spawn });
  }

  getHp(): number {
    return this.hp;
  }

  getMaxHp(): number {
    return this.startHp;
  }

  /** 回血(M3 维修技能):clamp 到 maxHp;不影响脱战回血计时。被击毁无效。
   * 若已通过调试命令将 HP 设到超过 maxHp,维修不会把 HP 降回来。 */
  heal(amount: number): void {
    if (this.state !== 'intact') return;
    if (this.hp < this.startHp) {
      this.hp = Math.min(this.startHp, this.hp + amount);
    }
    log.debug('tank heal', { name: this.name, hp: this.hp.toFixed(1), amount: amount.toFixed(1) });
  }

  /**
   * 调试用:复活被毁坦克(DebugConsole.revive)。
   * T-14 被毁后保留焦黑车体(不翻倒),复活仅需重置状态+清冒烟,焦黑视觉残留不影响驾驶。
   * StaticTankBase 被毁后翻倒转 dynamic,复活不逆转翻倒(调试用,够开炮测试即可)。
   */
  revive(): void {
    if (this.state !== 'destroyed') return;
    this.state = 'intact';
    this.hp = this.startHp;
    this.lastHitTime = performance.now();
    if (this.smoke) {
      this.smoke.dispose();
      this.smoke = undefined;
    }
    log.info('tank REVIVE', { name: this.name });
  }

  /** 调试用:直接设置 HP(下限 0,不限制正常 maxHp,不触发被毁/冒烟逻辑)。
   * 为安全起见,拦截非有限值并用 DEBUG_HP_CEILING 做硬上限,避免 Infinity 导致 toFixed 异常。 */
  setDebugHp(value: number): void {
    if (!Number.isFinite(value)) {
      log.warn('debug setHp rejected: non-finite value', { name: this.name, value });
      console.warn(`[tw] HP 必须是有限数值,收到 ${value}`);
      return;
    }
    const clamped = Math.max(0, Math.min(TankBase.DEBUG_HP_CEILING, value));
    if (clamped !== value) {
      log.warn('debug setHp ceiling clamped', { name: this.name, requested: value, clamped });
      console.warn(`[tw] HP ${value} 超过安全上限 ${TankBase.DEBUG_HP_CEILING},已限制为 ${clamped}`);
    }
    if (this.state !== 'intact') {
      log.warn('debug setHp on destroyed tank', { name: this.name });
      console.warn('[tw] 坦克已击毁,HP 修改不会复活;如需复活请先执行 tw.revive()');
    }
    this.hp = clamped;
    log.debug('debug setHp', { name: this.name, hp: this.hp.toFixed(0), maxHp: this.startHp });
  }

  /**
   * 构建弱点部位 sensor collider(M2):炮塔 + 左右履带。
   * ------------------------------------------------------------
   * sensor=true 不参与物理碰撞(不改变坦克外形/撞击判定),仅上报碰撞事件。
   * AP 直击命中部位 sensor 时,DestructionSystem 据 handle 反查部位并注入 debuff。
   *
   * 位置/尺寸基于主 collider 中心(spec.colliderOffset)+ bodyHalf 推导:
   *  - 炮塔 sensor:主 collider 上方,包络炮塔区域(比车体小、矮、短)
   *  - 履带 sensor:车身左右两侧,覆盖履带(薄长)
   * 各车型(T-14/虎式/M1)统一逻辑,无需子类覆盖。
   */
  private buildPartColliders(physics: PhysicsWorld): { handle: number; part: TankPart }[] {
    const cx = this.spec.colliderOffset?.x ?? 0;
    const cy = this.spec.colliderOffset?.y ?? 0;
    const cz = this.spec.colliderOffset?.z ?? 0;
    const bh = this.spec.bodyHalf;
    const parts: { handle: number; part: TankPart }[] = [];

    // 炮塔 sensor:主 collider 上方 0.4m,包络炮塔
    const turretDesc = RAPIER.ColliderDesc.cuboid(bh.x * 0.7, bh.y * 0.6, bh.z * 0.4)
      .setTranslation(cx, cy + bh.y + 0.4, cz)
      .setSensor(true)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const tc = physics.world.createCollider(turretDesc, this.body);
    parts.push({ handle: tc.handle, part: 'turret' });

    // 左右履带 sensor:车身两侧(±0.85×halfX),覆盖履带
    const trackOffX = bh.x * 0.85;
    for (const side of [-1, 1] as const) {
      const trackDesc = RAPIER.ColliderDesc.cuboid(bh.x * 0.25, bh.y * 0.8, bh.z * 0.9)
        .setTranslation(cx + side * trackOffX, cy, cz)
        .setSensor(true)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const trc = physics.world.createCollider(trackDesc, this.body);
      parts.push({ handle: trc.handle, part: 'track' });
    }
    return parts;
  }

  muzzleWorldPosition(): { x: number; y: number; z: number } {
    this.group.updateMatrixWorld(true);
    this.muzzle.getWorldPosition(this._muzzleWorld);
    return { x: this._muzzleWorld.x, y: this._muzzleWorld.y, z: this._muzzleWorld.z };
  }

  muzzleWorldDirection(): { x: number; y: number; z: number } {
    this.group.updateMatrixWorld(true);
    this.muzzle.getWorldPosition(TankBase._mDirA);
    this.barrel.getWorldPosition(TankBase._mDirB);
    TankBase._mDirA.sub(TankBase._mDirB).normalize();
    return { x: TankBase._mDirA.x, y: TankBase._mDirA.y, z: TankBase._mDirA.z };
  }

  updateTracks(leftVel: number, rightVel: number, dt: number): void {
    const f = CONFIG.tank.track.rollScale;
    this.leftTrackTex.offset.x += leftVel * dt * f;
    this.rightTrackTex.offset.x += rightVel * dt * f;
  }

  /** 玩家附身：静态坦克 fixed → dynamic，dynamic 车型无需操作 */
  possess(): void {
    if (this.state !== 'intact') return;
    if (this.spec.initialBodyType === RAPIER.RigidBodyType.Dynamic) return;
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.body.setEnabledRotations(false, true, false, true);
    this.body.setLinearDamping(0.6);
    this.body.setAngularDamping(2.5);
    log.info('tank possessed', { name: this.name });
  }

  /** 取消附身：静态坦克恢复 fixed */
  release(): void {
    if (this.state !== 'intact') return;
    if (this.spec.initialBodyType === RAPIER.RigidBodyType.Dynamic) return;
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    log.info('tank released', { name: this.name });
  }

  /**
   * 受击：扣 HP、冒烟阈值、击毁时调用子类 onDestroy。
   */
  takeHit(epicenter: { x: number; y: number; z: number }, damage: number): Fragment[] {
    if (this.state !== 'intact') return [];
    this.hp -= damage;
    this.lastHitTime = performance.now(); // 记录受击时刻,脱战回血计时基准
    const ratio = this.hp / this.startHp;
    if (ratio <= this.spec.damage.smokeThreshold) {
      this.ensureSmoke();
      const intensity = Math.min(1, 0.3 + 0.7 * (1 - ratio / this.spec.damage.smokeThreshold));
      this.smoke!.setIntensity(intensity);
    }
    log.debug('tank hit', { name: this.name, hp: this.hp.toFixed(1), damage: damage.toFixed(1) });
    if (this.hp <= 0) {
      this.state = 'destroyed';
      this.scorch();
      const t = this.body.translation();
      this.explosions.push(new Explosion(this.render, t, this.spec.damage.destroyExplosionScale));
      if (this.smoke) this.smoke.dispose();
      this.smoke = new Smoke(
        new Vector3(this.spec.smokeOffset.x, this.spec.smokeOffset.y, this.spec.smokeOffset.z),
        this.spec.damage.destroySmokeScale,
      );
      this.group.add(this.smoke.group);
      this.smoke.setIntensity(1);
      log.info('tank DESTROYED', { name: this.name, at: t });
      return this.onDestroy(epicenter);
    }
    return [];
  }

  private ensureSmoke(): void {
    if (this.smoke) return;
    this.smoke = new Smoke(new Vector3(
      this.spec.smokeOffset.x,
      this.spec.smokeOffset.y,
      this.spec.smokeOffset.z,
    ));
    this.group.add(this.smoke.group);
  }

  /** 烧焦变黑：遍历 group 中所有 MeshStandardMaterial。
   *  修复:置 map=null 前先将纹理引用收集到 scorchTextures,供 dispose 释放(否则 dispose 遍历 group 时 map 已是 null,纹理全部泄漏) */
  protected scorch(): void {
    // 被毁后隐藏护盾特效(焦黑车体上不应显示蓝色护盾)
    if (this.armorVfx) this.armorVfx.visible = false;
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material;
      const scorchOne = (mm: Material): void => {
        const sm = mm as MeshStandardMaterial;
        if (!sm.isMaterial) return;
        if ((sm as unknown as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) {
          // 置 null 前保存纹理引用,供 dispose 释放
          if (sm.map) this.scorchTextures.push(sm.map);
          sm.map = null;
          sm.color.setHex(0x141414);
          sm.roughness = 0.98;
          sm.metalness = 0.15;
          sm.transparent = false;
          sm.alphaTest = 0;
          sm.needsUpdate = true;
        }
      };
      if (Array.isArray(m)) for (const mm of m) scorchOne(mm);
      else if (m) scorchOne(m);
    });
  }

  /**
   * 构建技能视觉特效(仅 armor)。
   * ------------------------------------------------------------
   * boost(过载)无车体特效——靠扬尘增强反馈(TankController.updateDust 加大 spawnPerMeter)。
   * scout(侦查)无车体特效——静默生效(仅 FogOfWarSystem 视野扩大)。
   * armor(装甲):蓝色半透球壳,激活时 opacity 呼吸波动(能量护盾感)。
   */
  private buildSkillVfx(): void {
    const bh = this.spec.bodyHalf;
    // armor: 蓝色半透球壳(包裹车身,能量护盾)
    const armorR = Math.max(bh.x, bh.z) + 0.4;
    const armorGeo = new SphereGeometry(armorR, 16, 10);
    const armorMat = new MeshBasicMaterial({
      color: 0x4a8aff, transparent: true, opacity: 0.12, depthWrite: false,
    });
    this.armorVfx = new Mesh(armorGeo, armorMat);
    this.armorVfx.visible = false;
    this.group.add(this.armorVfx);
  }

  /** 每帧更新：状态聚合层推进 + 技能特效 + 烟 + 击毁爆炸粒子 */
  update(dt: number): void {
    // 状态层推进(无论 intact/destroyed:destroyed 后 effect 自然到期清空,无副作用且代码最简)
    this.status.update(dt);
    // 脱战回血:最后受击超 regenDelay 秒后,按 regenRate 缓慢回血(仅 intact 且未满血)
    const reg = this.spec.damage;
    if (
      reg.regenDelay !== undefined &&
      reg.regenRate !== undefined &&
      this.state === 'intact' &&
      this.hp < this.startHp &&
      this.lastHitTime > 0 && // 未受击(lastHitTime=-1 哨兵)不触发回血
      performance.now() - this.lastHitTime > reg.regenDelay * 1000
    ) {
      this.hp = Math.min(this.startHp, this.hp + reg.regenRate * dt);
    }
    // 技能视觉特效(仅 armor:蓝色护盾呼吸)
    this.vfxTime += dt;
    if (this.armorVfx) {
      const on = this.status.hasEffect('armor');
      this.armorVfx.visible = on;
      if (on) {
        // opacity 呼吸波动(能量护盾呼吸感)
        (this.armorVfx.material as MeshBasicMaterial).opacity = 0.10 + 0.06 * Math.sin(this.vfxTime * 4);
      }
    }

    if (this.smoke) this.smoke.update(dt);
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      if (e.update(dt)) continue;
      e.dispose(this.render);
      this.explosions.splice(i, 1);
    }
  }

  /** 彻底销毁：解绑刚体、移除场景、释放 GPU 资源 */
  dispose(): void {
    SyncBridge.unbind(this.body);
    this.physics.world.removeRigidBody(this.body);
    this.render.scene.remove(this.group);

    // 如果炮塔被 blowTurret 移到了 render.scene(StaticTankBase 被毁时),
    // 需要单独遍历 turret 子树收集资源(group.traverse 不含已移出的 turret)
    const geos = new Set<BufferGeometry>();
    const mats = new Set<Material>();
    const texs = new Set<Texture>();
    const collectSubtree = (root: Object3D): void => {
      root.traverse((obj) => {
        const mesh = obj as Mesh;
        if (!mesh.isMesh) return;
        if (mesh.geometry) geos.add(mesh.geometry);
        const m = mesh.material;
        const collect = (mm: Material): void => {
          mats.add(mm);
          const map = (mm as { map?: Texture }).map;
          if (map) texs.add(map);
        };
        if (Array.isArray(m)) for (const mm of m) collect(mm);
        else if (m) collect(m);
      });
    };
    collectSubtree(this.group);

    if (this.turretBody) {
      SyncBridge.unbind(this.turretBody);
      this.physics.world.removeRigidBody(this.turretBody);
      this.turretBody = undefined;
      // turret 已被 blowTurret 移出 group,单独遍历其子树收集资源
      collectSubtree(this.turret);
      this.render.scene.remove(this.turret);
    }

    for (const e of this.explosions) e.dispose(this.render);
    this.explosions.length = 0;
    if (this.smoke) {
      this.smoke.dispose();
      this.smoke = undefined;
    }

    // 释放 scorch 前收集的纹理(scorch 已将 map 置 null,group 遍历收集不到)
    for (const t of this.scorchTextures) texs.add(t);
    this.scorchTextures.length = 0;
    // 释放履带纹理(实例字段,可能不在 mesh.material.map 上——如 GltfTank 占位纹理)
    texs.add(this.leftTrackTex);
    texs.add(this.rightTrackTex);

    // material 总是独立 clone(GltfTankAsset.cloneWithIndependentMaterials),可安全释放
    for (const m of mats) m.dispose();
    // geometry/texture:共享资源(GltfTankAsset 的 glb 几何/纹理)由 Asset 统一管理,不释放
    if (!this.geometryIsShared) {
      for (const t of texs) t.dispose();
      for (const g of geos) g.dispose();
    } else {
      // GltfTank:只释放独立的占位纹理(履带 placeholder),不释放共享的 glb 纹理
      this.leftTrackTex.dispose();
      this.rightTrackTex.dispose();
    }
  }
}
