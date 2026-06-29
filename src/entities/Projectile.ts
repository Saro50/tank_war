import RAPIER from '@dimforge/rapier3d-compat';
import { Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';

/**
 * 炮弹
 * ------------------------------------------------------------
 * 从炮口生成的高速小球刚体：
 *  - CCD 开启：高速(60m/s)防穿透
 *  - maxLifetime：超时销毁防丢失
 *  - 开启碰撞事件：供 WeaponSystem 检测命中
 * 命中/超时由 WeaponSystem 调用 dispose 清理。
 */
// 几何/材质模块级共享(所有炮弹复用，dispose 不释放)
const sphereGeo = new SphereGeometry(CONFIG.weapon.projectile.radius, 16, 12);
const sphereMat = new MeshStandardMaterial({
  color: 0x1c1e22,
  roughness: 0.4,
  metalness: 0.7,
  emissive: 0x3a2200,
  emissiveIntensity: 0.6,
});

export class Projectile {
  readonly body: RAPIER.RigidBody;
  readonly mesh: Mesh;
  /** collider handle，供碰撞事件反查 */
  readonly colliderHandle: number;
  /** 剩余寿命(s) */
  life: number;
  /** 是否存活(命中/超时后置 false，待清理) */
  alive = true;

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    pos: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
  ) {
    const cfg = CONFIG.weapon.projectile;
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

    this.mesh = new Mesh(sphereGeo, sphereMat);
    this.mesh.castShadow = true;
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
