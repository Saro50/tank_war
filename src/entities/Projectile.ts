import RAPIER from '@dimforge/rapier3d-compat';
import { Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { CONFIG, type AmmoType } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import type { IControllableTank } from './IControllableTank';
import { SyncBridge } from '../core/SyncBridge';

/**
 * 炮弹
 * ------------------------------------------------------------
 * 从炮口生成的高速小球刚体,按弹种(AP/HE)区分物理参数与命中结算管线:
 *  - CCD 开启:高速防穿透
 *  - maxLifetime:超时销毁防丢失
 *  - 开启碰撞事件:供 WeaponSystem 检测命中
 *  - damageType:AP 走直击管线(DestructionSystem.applyDirectHit),
 *               HE 走 AOE(onExplosion)。分发在 WeaponSystem.detonate。
 * 命中/超时由 WeaponSystem 调用 dispose 清理。
 */
// 几何/材质按弹种缓存(模块级共享,所有炮弹复用,dispose 不释放)
const geoByType: Record<AmmoType, SphereGeometry> = {
  ap: new SphereGeometry(CONFIG.weapon.ammoTypes.ap.radius, 16, 12),
  he: new SphereGeometry(CONFIG.weapon.ammoTypes.he.radius, 16, 12),
};
const matByType: Record<AmmoType, MeshStandardMaterial> = {
  // AP:暗色尖头穿甲感(沿用原炮弹视觉,玩家熟悉)
  ap: new MeshStandardMaterial({
    color: CONFIG.weapon.ammoTypes.ap.color,
    roughness: 0.4,
    metalness: 0.7,
    emissive: 0x3a2200,
    emissiveIntensity: 0.6,
  }),
  // HE:橄榄色圆钝高爆感(与 AP 视觉区分,玩家可从弹色判断来袭弹种)
  he: new MeshStandardMaterial({
    color: CONFIG.weapon.ammoTypes.he.color,
    roughness: 0.5,
    metalness: 0.5,
    emissive: 0x2a3a00,
    emissiveIntensity: 0.5,
  }),
};

export class Projectile {
  readonly body: RAPIER.RigidBody;
  readonly mesh: Mesh;
  /** collider handle，供碰撞事件反查 */
  readonly colliderHandle: number;
  /** 弹种(决定命中结算走 AP 直击管线还是 HE AOE 管线) */
  readonly damageType: AmmoType;
  /** 剩余寿命(s) */
  life: number;
  /** 是否存活(命中/超时后置 false，待清理) */
  alive = true;
  /** 发射者坦克:爆炸时 exclude 此坦克防自伤(友伤基础)。undefined=无主(伤害所有人) */
  ownerTank?: IControllableTank;
  /**
   * 本帧碰撞收集的【被击方】collider handle 列表(M2 部位优先修正)。
   * ------------------------------------------------------------
   * AP 高速炮弹一帧内可能同时接触主 collider + 部位 sensor(部位在主 collider 内部)。
   * 若逐事件立即引爆,主 collider(外表面)总是先触发 → 部位 collider 永不生效。
   * 故 handleCollision 只收集,由 WeaponSystem.update 调 DestructionSystem.pickPartHandle
   * 选"部位优先"的 handle 后再引爆,保证 turret/track debuff 判定可靠。
   * HE 不用(AOE 无视具体 collider)。每帧 update 处理后清空。
   */
  pendingHitHandles: number[] = [];

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    pos: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
    type: AmmoType,
  ) {
    this.damageType = type;
    const cfg = CONFIG.weapon.ammoTypes[type];
    this.life = cfg.maxLifetime;

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(0.0)
      .setCcdEnabled(true);
    this.body = physics.world.createRigidBody(bodyDesc);
    const col = physics.world.createCollider(
      RAPIER.ColliderDesc.ball(cfg.radius)
        .setMass(cfg.mass)
        .setRestitution(0.3)
        .setFriction(0.5)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    this.colliderHandle = col.handle;

    // 初速度沿炮口朝向
    const v = cfg.muzzleVelocity;
    this.body.setLinvel({ x: dir.x * v, y: dir.y * v, z: dir.z * v }, true);

    this.mesh = new Mesh(geoByType[type], matByType[type]);
    this.mesh.castShadow = true;
    // 先同步到刚体位姿，避免创建帧显示在原点(0,0,0)导致"幽灵炮弹"视觉
    const t = this.body.translation();
    const r = this.body.rotation();
    this.mesh.position.set(t.x, t.y, t.z);
    this.mesh.quaternion.set(r.x, r.y, r.z, r.w);
    render.scene.add(this.mesh);
    SyncBridge.bind(this.body, this.mesh);
  }

  /** 销毁：解绑同步 + 移除刚体 + 移除网格 */
  dispose(physics: PhysicsWorld, render: RenderScene): void {
    SyncBridge.unbind(this.body);
    physics.world.removeRigidBody(this.body);
    render.scene.remove(this.mesh);
    this.alive = false;
  }
}
