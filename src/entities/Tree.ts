import RAPIER from '@dimforge/rapier3d-compat';
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';
import { Logger } from '../utils/Logger';

const log = Logger.create('Tree');

// 共享几何/材质(所有树同尺寸同材质，省内存)
let sharedTrunkGeo: CylinderGeometry | null = null;
let sharedCrownGeo: ConeGeometry | null = null;
let sharedTrunkMat: MeshStandardMaterial | null = null;
let sharedCrownMat: MeshStandardMaterial | null = null;

function ensureShared(): void {
  if (sharedTrunkGeo) return;
  const cfg = CONFIG.destruction.tree;
  sharedTrunkGeo = new CylinderGeometry(cfg.trunkRadius, cfg.trunkRadius * 1.3, cfg.trunkHeight, 10);
  sharedCrownGeo = new ConeGeometry(cfg.crownRadius, cfg.crownHeight, 12);
  sharedTrunkMat = new MeshStandardMaterial({ color: 0x5a3d28, roughness: 0.95, metalness: 0 });
  sharedCrownMat = new MeshStandardMaterial({ color: 0x2f5d2a, roughness: 0.9, metalness: 0 });
}

/**
 * 树(可被炮弹击倒)
 * ------------------------------------------------------------
 * 树干 fixed 刚体 + 树冠(挂同一 group，随树干倒)。
 * 被爆炸波及(takeHit) → fixed 转 dynamic + 沿爆心方向冲量 + 上抬 + 扭矩 → 倒下。
 *
 * collider 用 cuboid(方树干)而非 cylinder：避免 rapier cylinder 默认沿 x 轴
 * 需旋转的复杂性，方柱碰撞对树干足够。
 */
export class Tree {
  state: 'intact' | 'fallen' = 'intact';

  /** 迷雾显隐:供 FogOfWarSystem 按视野格子切 visible */
  setVisibility(v: boolean): void {
    this.group.visible = v;
  }

  /** 位置(供迷雾判定格子;body 是 private,通过 getter 暴露) */
  get fogX(): number { return this.body.translation().x; }
  get fogZ(): number { return this.body.translation().z; }
  /** collider handle，供 DestructionSystem 碰撞反查 */
  readonly colliderHandle: number;
  private readonly body: RAPIER.RigidBody;
  private readonly group: Group;
  private readonly physics: PhysicsWorld;
  private readonly render: RenderScene;

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    pos: { x: number; y: number; z: number },
  ) {
    ensureShared();
    this.physics = physics;
    this.render = render;
    const cfg = CONFIG.destruction.tree;
    // body/group 中心 = 树干中心(地面 y 上方 trunkHeight/2)
    const cx = pos.x;
    const cy = pos.y + cfg.trunkHeight / 2;
    const cz = pos.z;

    // 物理：树干方柱 fixed(碰撞用 cuboid 近似圆树干，省去 cylinder 轴向旋转)
    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz),
    );
    const col = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(cfg.trunkRadius, cfg.trunkHeight / 2, cfg.trunkRadius)
        .setDensity(cfg.density)
        .setFriction(0.8)
        .setRestitution(0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    this.colliderHandle = col.handle;

    // 渲染：group(原点=树干中心) + 树干(中心) + 树冠(上方)
    this.group = new Group();
    this.group.position.set(cx, cy, cz);
    const trunk = new Mesh(sharedTrunkGeo!, sharedTrunkMat!);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    this.group.add(trunk);
    const crown = new Mesh(sharedCrownGeo!, sharedCrownMat!);
    crown.position.y = cfg.trunkHeight / 2 + cfg.crownHeight / 2 - 0.2;
    crown.castShadow = true;
    this.group.add(crown);

    render.scene.add(this.group);
    SyncBridge.bind(this.body, this.group);
  }

  /** 彻底销毁(场景重置用)：解绑+移除刚体+移除网格。共享 geo/mat 单例不释放。 */
  dispose(): void {
    SyncBridge.unbind(this.body);
    this.physics.world.removeRigidBody(this.body);
    this.render.scene.remove(this.group);
    this.state = 'fallen';
  }

  /** 被爆炸波及：fixed 转 dynamic + 沿爆心水平方向推倒 + 上抬 + 随机扭矩(翻滚倒地) */
  takeHit(epicenter: { x: number; y: number; z: number }): void {
    if (this.state !== 'intact') return;
    const cfg = CONFIG.destruction.tree;
    const t = this.body.translation();
    const dx = t.x - epicenter.x;
    const dz = t.z - epicenter.z;
    const d = Math.hypot(dx, dz);
    if (d >= cfg.hitRadius) return;

    this.state = 'fallen';
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const dl = d || 1;
    this.body.applyImpulse(
      { x: (dx / dl) * cfg.fallImpulse, y: 2.0, z: (dz / dl) * cfg.fallImpulse },
      true,
    );
    this.body.applyTorqueImpulse(
      {
        x: (Math.random() - 0.5) * 3,
        y: 0,
        z: (Math.random() - 0.5) * 3,
      },
      true,
    );
    log.info('tree fell', { x: t.x.toFixed(1), z: t.z.toFixed(1) });
  }

  /** 被坦克/物体撞击(碰撞事件触发)：无方向信息，随机水平方向翻倒 */
  takeHitByContact(): void {
    if (this.state !== 'intact') return;
    this.state = 'fallen';
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const imp = CONFIG.destruction.tree.fallImpulse;
    const ang = Math.random() * Math.PI * 2;
    this.body.applyImpulse(
      { x: Math.cos(ang) * imp, y: 2.5, z: Math.sin(ang) * imp },
      true,
    );
    this.body.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * 4, y: 0, z: (Math.random() - 0.5) * 4 },
      true,
    );
    log.info('tree knocked by collision');
  }
}
