import RAPIER from '@dimforge/rapier3d-compat';
import { ConeGeometry, CylinderGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';
import { Logger } from '../utils/Logger';

const log = Logger.create('Fence');

// 共享几何/材质
let sharedPostGeo: CylinderGeometry | null = null;
let sharedTipGeo: ConeGeometry | null = null;
let sharedMat: MeshStandardMaterial | null = null;

function ensureShared(): void {
  if (sharedPostGeo) return;
  const cfg = CONFIG.destruction.fence;
  sharedPostGeo = new CylinderGeometry(cfg.postRadius, cfg.postRadius * 1.3, cfg.postHeight, 8);
  sharedTipGeo = new ConeGeometry(cfg.postRadius * 1.6, 0.22, 8);
  sharedMat = new MeshStandardMaterial({ color: 0x6b4a2e, roughness: 0.95, metalness: 0 });
}

/**
 * 栅栏立柱(可被坦克推倒)
 * ------------------------------------------------------------
 * 木质尖桩，fixed 站立，被坦克/物体碰撞(knockDown) → 转 dynamic 翻倒。
 * 通常由 DestructionSystem.addFenceRow 成排创建。
 */
export class FencePost {
  state: 'intact' | 'knocked' = 'intact';
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
    const cfg = CONFIG.destruction.fence;
    const cx = pos.x;
    const cy = pos.y + cfg.postHeight / 2;
    const cz = pos.z;

    this.body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(cx, cy, cz),
    );
    const col = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(cfg.postRadius, cfg.postHeight / 2, cfg.postRadius)
        .setDensity(cfg.density)
        .setFriction(0.8)
        .setRestitution(0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    this.colliderHandle = col.handle;

    const group = new Group();
    group.position.set(cx, cy, cz);
    const post = new Mesh(sharedPostGeo!, sharedMat!);
    post.castShadow = true;
    group.add(post);
    const tip = new Mesh(sharedTipGeo!, sharedMat!);
    tip.position.y = cfg.postHeight / 2 + 0.11;
    tip.castShadow = true;
    group.add(tip);
    this.group = group;

    render.scene.add(this.group);
    SyncBridge.bind(this.body, this.group);
  }

  /** 彻底销毁(场景重置用)：解绑+移除刚体+移除网格。共享 geo/mat 单例不释放。 */
  dispose(): void {
    SyncBridge.unbind(this.body);
    this.physics.world.removeRigidBody(this.body);
    this.render.scene.remove(this.group);
    this.state = 'knocked';
  }

  /** 被坦克/物体撞击 → 转 dynamic + 随机水平方向翻倒 */
  knockDown(): void {
    if (this.state !== 'intact') return;
    this.state = 'knocked';
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const imp = CONFIG.destruction.fence.knockImpulse;
    const ang = Math.random() * Math.PI * 2;
    this.body.applyImpulse(
      { x: Math.cos(ang) * imp, y: 1.5, z: Math.sin(ang) * imp },
      true,
    );
    this.body.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * 3, y: 0, z: (Math.random() - 0.5) * 3 },
      true,
    );
    log.info('fence knocked');
  }
}
