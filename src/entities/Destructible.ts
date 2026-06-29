import RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';
import { gridFracture } from '../effects/VoronoiFracture';
import { Logger } from '../utils/Logger';

const log = Logger.create('Destructible');

// 弹坑几何/材质(焦黑扁圆台，模块级共享)
const craterGeo = new CylinderGeometry(0.3, 0.2, 0.14, 16);
const craterMat = new MeshStandardMaterial({ color: 0x0d0d0d, roughness: 1 });
const UP = new Vector3(0, 1, 0);

/**
 * 可破坏物
 * ============================================================
 * 三种破坏模型由 HP 统一：
 *  - hp=1（箱子）：一击碎裂(网格切块飞溅)
 *  - hp=N（水泥塔楼）：累积伤害，每次出弹坑，hp<=0 才倒塌
 *
 * 倒塌用【网格切割】(非 Voronoi)：沿三轴确定性切块，
 * 对细长塔楼可靠(2×6×2=24块)，避免 Voronoi 退化成 1-2 块导致"整体倒"。
 */
export class Destructible {
  state: 'intact' | 'destroyed' = 'intact';
  readonly body: RAPIER.RigidBody;
  private readonly mesh: Mesh;
  private readonly physics: PhysicsWorld;
  private readonly render: RenderScene;
  private readonly size: { x: number; y: number; z: number };
  private readonly maxHp: number;
  hp: number;
  private craters: Mesh[] = [];
  private baseBody?: RAPIER.RigidBody; // 地基刚体(建筑类，倒塌后保留)
  private baseMesh?: Mesh;

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    pos: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    maxHp = 1,
    color = 0x8a6d3b,
    baseSize?: { x: number; y: number; z: number },
  ) {
    this.physics = physics;
    this.render = render;
    this.size = size;
    this.maxHp = maxHp;
    this.hp = maxHp;
    const hx = size.x / 2,
      hy = size.y / 2,
      hz = size.z / 2;
    // 建筑类(maxHp>1)用 fixed：炮弹打不动，只出坑扣血，hp 耗尽才倒塌
    const isStructure = maxHp > 1;
    const bodyDesc = (
      isStructure
        ? RAPIER.RigidBodyDesc.fixed()
        : RAPIER.RigidBodyDesc.dynamic()
            .setLinearDamping(0.3)
            .setAngularDamping(0.3)
    ).setTranslation(pos.x, pos.y, pos.z);
    this.body = physics.world.createRigidBody(bodyDesc);
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setDensity(isStructure ? 8 : 4)
        .setFriction(0.8)
        .setRestitution(0.1)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );

    this.mesh = new Mesh(
      new BoxGeometry(size.x, size.y, size.z),
      new MeshStandardMaterial({
        color,
        roughness: isStructure ? 0.95 : 0.85,
        metalness: 0.05,
      }),
    );
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    render.scene.add(this.mesh);
    SyncBridge.bind(this.body, this.mesh);

    // 地基底座(仅建筑类)：独立 fixed，永远稳固、倒塌后保留
    if (isStructure && baseSize) {
      const baseY = pos.y - size.y / 2 - baseSize.y / 2;
      this.baseBody = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, baseY, pos.z),
      );
      physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(baseSize.x / 2, baseSize.y / 2, baseSize.z / 2)
          .setFriction(0.9)
          .setRestitution(0.0),
        this.baseBody,
      );
      this.baseMesh = new Mesh(
        new BoxGeometry(baseSize.x, baseSize.y, baseSize.z),
        new MeshStandardMaterial({ color: 0x6f6f6f, roughness: 1, metalness: 0.05 }),
      );
      this.baseMesh.position.set(pos.x, baseY, pos.z);
      this.baseMesh.castShadow = true;
      this.baseMesh.receiveShadow = true;
      render.scene.add(this.baseMesh);
    }
  }

  /** 受击：扣血 + 出弹坑，hp<=0 触发倒塌(返回碎片) */
  takeHit(epicenter: { x: number; y: number; z: number }, damage: number): Fragment[] {
    if (this.state !== 'intact') return [];
    this.hp -= damage;
    this.addCrater(epicenter);
    log.debug('takeHit', {
      hp: Math.max(0, this.hp).toFixed(0),
      maxHp: this.maxHp,
      dmg: damage.toFixed(1),
    });
    if (this.hp <= 0) return this.destroy(epicenter);
    return [];
  }

  /** 在朝爆心方向的表面贴一个焦黑弹坑 */
  private addCrater(epicenter: { x: number; y: number; z: number }): void {
    const c = this.body.translation();
    let dx = epicenter.x - c.x,
      dy = epicenter.y - c.y,
      dz = epicenter.z - c.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    dx /= len;
    dy /= len;
    dz /= len;

    const hx = this.size.x / 2,
      hy = this.size.y / 2,
      hz = this.size.z / 2;
    const tx = Math.abs(dx) > 0.01 ? hx / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > 0.01 ? hy / Math.abs(dy) : Infinity;
    const tz = Math.abs(dz) > 0.01 ? hz / Math.abs(dz) : Infinity;
    const sd = Math.min(tx, ty, tz);
    // 爆心≈箱体几何中心时三轴分量都极小 → sd=Infinity → 弹坑退化为 NaN/无限远，
    // 此种退化情形直接跳过贴弹坑(视觉上可忽略，且避免脏矩阵)。
    if (!Number.isFinite(sd)) return;
    const sx = c.x + dx * sd,
      sy = c.y + dy * sd,
      sz = c.z + dz * sd;

    const crater = new Mesh(craterGeo, craterMat);
    crater.position.set(sx - dx * 0.06, sy - dy * 0.06, sz - dz * 0.06);
    crater.quaternion.copy(new Quaternion().setFromUnitVectors(UP, new Vector3(dx, dy, dz)));
    this.render.scene.add(crater);
    this.craters.push(crater);
  }

  /** 倒塌：销毁整体 + 清弹坑 + 网格切块飞溅 */
  destroy(epicenter: { x: number; y: number; z: number }): Fragment[] {
    if (this.state !== 'intact') return [];
    this.state = 'destroyed';

    const boxPos = this.body.translation();
    const boxRot = this.body.rotation();
    const q = new Quaternion(boxRot.x, boxRot.y, boxRot.z, boxRot.w);

    SyncBridge.unbind(this.body);
    this.physics.world.removeRigidBody(this.body);
    this.render.scene.remove(this.mesh);
    // 释放主体独有几何/材质(防止每次破碎泄漏 GPU 资源)
    this.mesh.geometry.dispose();
    (this.mesh.material as MeshStandardMaterial).dispose();
    for (const cr of this.craters) this.render.scene.remove(cr);
    this.craters = [];

    // 网格切割：塔楼 2×6×2=24 块，箱子 2×2×2=8 块(确定性，不退化)
    const gy = this.maxHp > 1 ? 6 : 2;
    const pieces = gridFracture(this.size, 2, gy, 2);
    const imp = CONFIG.destruction.fragmentImpulse;
    const density = this.maxHp > 1 ? 6 : 4; // 塔楼水泥碎片更重
    const fragments: Fragment[] = [];

    for (const piece of pieces) {
      const worldOffset = piece.center.clone().applyQuaternion(q);
      const worldPos = {
        x: boxPos.x + worldOffset.x,
        y: boxPos.y + worldOffset.y,
        z: boxPos.z + worldOffset.z,
      };

      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(worldPos.x, worldPos.y, worldPos.z)
        .setRotation(boxRot)
        .setLinearDamping(0.1)
        .setAngularDamping(0.2);
      const fbody = this.physics.world.createRigidBody(bodyDesc);
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(piece.half.x, piece.half.y, piece.half.z)
          .setDensity(density)
          .setFriction(0.7)
          .setRestitution(0.2),
        fbody,
      );

      const geo = new BoxGeometry(piece.half.x * 2, piece.half.y * 2, piece.half.z * 2);
      const mat = new MeshStandardMaterial({
        color: this.maxHp > 1 ? 0x8a8a8a : 0x8a6d3b,
        roughness: 0.95,
        metalness: 0.05,
        transparent: true,
        opacity: 1,
      });
      const fmesh = new Mesh(geo, mat);
      fmesh.castShadow = true;
      fmesh.receiveShadow = true;
      this.render.scene.add(fmesh);
      SyncBridge.bind(fbody, fmesh);

      // 裂开冲量：从塔身中心向外(四分五裂) + 向上飞溅 + 被击中方向额外推
      const cdx = worldPos.x - boxPos.x;
      const cdy = worldPos.y - boxPos.y;
      const cdz = worldPos.z - boxPos.z;
      const cdlen = Math.hypot(cdx, cdy, cdz) || 1;
      const burst = imp * (this.maxHp > 1 ? 2.6 : 1.2);
      const edx = worldPos.x - epicenter.x;
      const edz = worldPos.z - epicenter.z;
      const elen = Math.hypot(edx, edz) || 1;
      fbody.applyImpulse(
        {
          x: (cdx / cdlen) * burst + (edx / elen) * imp * 0.6,
          y: Math.max(0, cdy / cdlen) * burst * 0.4 + (this.maxHp > 1 ? 3.5 : 1.5),
          z: (cdz / cdlen) * burst + (edz / elen) * imp * 0.6,
        },
        true,
      );
      fbody.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * 2,
          y: (Math.random() - 0.5) * 2,
          z: (Math.random() - 0.5) * 2,
        },
        true,
      );

      fragments.push(new Fragment(fbody, fmesh, geo, mat));
    }

    log.info('COLLAPSED', { fragments: fragments.length, at: boxPos });
    return fragments;
  }

  /**
   * 彻底销毁(场景重置用)：移除地基刚体/网格并释放其独有几何/材质。
   * 与 destroy() 的区别：destroy() 触发倒塌并保留地基；dispose() 连地基一起清。
   * 倒塌前(仍 intact)调用会一并移除主体(body/mesh)。
   */
  dispose(): void {
    if (this.state === 'intact') {
      // 未倒塌：主体还在，先解绑移除并释放
      SyncBridge.unbind(this.body);
      this.physics.world.removeRigidBody(this.body);
      this.render.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as MeshStandardMaterial).dispose();
      for (const cr of this.craters) this.render.scene.remove(cr);
      this.craters = [];
      this.state = 'destroyed';
    }
    // 地基(建筑类)：独立移除并释放独有 geo/mat
    if (this.baseBody) {
      SyncBridge.unbind(this.baseBody);
      this.physics.world.removeRigidBody(this.baseBody);
      this.baseBody = undefined;
    }
    if (this.baseMesh) {
      this.render.scene.remove(this.baseMesh);
      this.baseMesh.geometry.dispose();
      (this.baseMesh.material as MeshStandardMaterial).dispose();
      this.baseMesh = undefined;
    }
  }
}

/** 碎片：带寿命与淡出 */
export class Fragment {
  alive = true;
  private life: number;
  private readonly maxLife: number;
  private readonly fadeStart: number;
  constructor(
    private readonly body: RAPIER.RigidBody,
    private readonly mesh: Mesh,
    private readonly geo: BoxGeometry,
    private readonly mat: MeshStandardMaterial,
  ) {
    this.maxLife = CONFIG.destruction.fragmentLifetime;
    this.fadeStart = CONFIG.destruction.fragmentFadeStart;
    this.life = this.maxLife;
  }

  update(dt: number): boolean {
    this.life -= dt;
    if (this.life <= 0) return false;
    const elapsed = this.maxLife - this.life;
    if (elapsed > this.fadeStart) {
      const fadeDur = this.maxLife - this.fadeStart;
      this.mat.opacity = Math.max(0, 1 - (elapsed - this.fadeStart) / fadeDur);
    }
    return true;
  }

  dispose(physics: PhysicsWorld, render: RenderScene): void {
    SyncBridge.unbind(this.body);
    physics.world.removeRigidBody(this.body);
    render.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
    this.alive = false;
  }
}
