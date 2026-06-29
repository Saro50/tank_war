import RAPIER from '@dimforge/rapier3d-compat';
import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';
import { gridFracture } from '../effects/VoronoiFracture';
import { Logger } from '../utils/Logger';

const log = Logger.create('Tower');

/**
 * 水泥塔楼 —— 弹坑式渐进破坏
 * ============================================================
 * 塔身预切成 gridX×gridY×gridZ 个细小 fixed 块(网格切割，确定性不退化)。
 * 块切得细(默认 3×9×3=81，单块体积仅旧的 ~30%)，命中时只崩落一小片
 * → 视觉上像水泥被炸出"弹坑凹陷"，而非整块砖头脱落飞溅。
 *
 * 每炮命中(takeHit)：
 *  - 弹着点 hitRadius(≈1m) 内的表面块 → fixed 切 dynamic + 弱冲量塌落
 *  - 冲量刻意压低且"塌落式"(水平轻散 + 上方微弹)，碎渣散开不飞溅
 *  - 塔身留下凹陷缺口(弹坑)，剩余块继续 fixed 稳固
 *
 * 累积掉块比例 > collapseRatio → 剩余所有块活化(整体坍塌，建筑倒塌感)。
 *
 * 与 Destructible(单体 Voronoi/网格) 的区别：
 *  Tower 是"多块拼成"，可逐块剥离，渐进损坏可视化。
 */
interface Block {
  body: RAPIER.RigidBody;
  mesh: Mesh;
  alive: boolean;
}

export class Tower {
  state: 'intact' | 'destroyed' = 'intact';
  private readonly center: { x: number; y: number; z: number };
  private readonly blocks: Block[] = [];
  private readonly totalBlocks: number;
  private lostBlocks = 0;

  // 共享几何/材质(所有块同尺寸)
  private readonly blockGeo: BoxGeometry;
  private readonly blockMat: MeshStandardMaterial;

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    pos: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    baseSize: { x: number; y: number; z: number },
  ) {
    this.center = { ...pos };
    const cfg = CONFIG.destruction.tower;

    // 地基底座(fixed，永远稳固)
    const baseY = pos.y - size.y / 2 - baseSize.y / 2;
    const baseBody = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, baseY, pos.z),
    );
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(baseSize.x / 2, baseSize.y / 2, baseSize.z / 2)
        .setFriction(0.9)
        .setRestitution(0),
      baseBody,
    );
    const baseMesh = new Mesh(
      new BoxGeometry(baseSize.x, baseSize.y, baseSize.z),
      new MeshStandardMaterial({ color: 0x6f6f6f, roughness: 1, metalness: 0.05 }),
    );
    baseMesh.position.set(pos.x, baseY, pos.z);
    baseMesh.castShadow = true;
    baseMesh.receiveShadow = true;
    render.scene.add(baseMesh);

    // 网格切块(全 fixed)：三轴细分，块越小弹坑越细腻
    const pieces = gridFracture(size, cfg.gridX, cfg.gridY, cfg.gridZ);
    this.totalBlocks = pieces.length;
    this.blockGeo = new BoxGeometry(
      pieces[0].half.x * 2,
      pieces[0].half.y * 2,
      pieces[0].half.z * 2,
    );
    this.blockMat = new MeshStandardMaterial({
      color: 0x9a9a9a,
      roughness: 0.95,
      metalness: 0.05,
    });

    for (const piece of pieces) {
      const wp = {
        x: pos.x + piece.center.x,
        y: pos.y + piece.center.y,
        z: pos.z + piece.center.z,
      };
      const body = physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(wp.x, wp.y, wp.z),
      );
      // collider 略缩(0.94)避免相邻块共面重叠导致切 dynamic 时炸飞
      // 块变多变小后多留间隙，保持与旧大块相同的绝对缝隙防共面
      physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(
          piece.half.x * 0.94,
          piece.half.y * 0.94,
          piece.half.z * 0.94,
        )
          .setDensity(cfg.density)
          .setFriction(0.8)
          .setRestitution(0.1)
          .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
        body,
      );
      const mesh = new Mesh(this.blockGeo, this.blockMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      render.scene.add(mesh);
      SyncBridge.bind(body, mesh);
      this.blocks.push({ body, mesh, alive: true });
    }

    log.info('tower built', { blocks: this.totalBlocks });
  }

  /** 受击：命中半径内块活化掉落；累积超阈值则整体倒塌 */
  takeHit(epicenter: { x: number; y: number; z: number }): void {
    if (this.state !== 'intact') return;
    const cfg = CONFIG.destruction.tower;
    // 用塔楼专属弹坑冲量(远小于砖块飞溅冲量)，碎渣塌落不飞溅
    const imp = cfg.hitImpulse;
    let lost = 0;

    for (const b of this.blocks) {
      if (!b.alive) continue;
      const t = b.body.translation();
      const dx = t.x - epicenter.x,
        dy = t.y - epicenter.y,
        dz = t.z - epicenter.z;
      const d = Math.hypot(dx, dy, dz);
      if (d >= cfg.hitRadius) continue;
      this.activateBlock(b, imp, dx, dy, dz, d);
      lost++;
    }
    this.lostBlocks += lost;

    log.info(
      'tower hit',
      `本炮掉落 ${lost} 块 | 累计 ${this.lostBlocks}/${this.totalBlocks} (${((this.lostBlocks / this.totalBlocks) * 100).toFixed(0)}%)`,
    );

    if (this.lostBlocks / this.totalBlocks >= cfg.collapseRatio) {
      this.collapse();
    }
  }

  /**
   * 活化单块：fixed→dynamic + 弹坑式塌落冲量
   * ------------------------------------------------------------
   * 设计要点(区别于砖块的"飞溅")：
   *  - 水平径向：全速向外(碎渣向弹坑四周抛洒)
   *  - 垂直：爆心上方块半速上推(微弹)，下方块不额外下沉、仅 +0.4 抗钻地
   *  - 扭矩压到 ±0.35：碎渣散落不乱转，避免像砖头翻飞
   *  冲量来源 hitImpulse(~2.2) 已按小块质量校准，塌落速度 ~1.5m/s
   */
  private activateBlock(
    b: Block,
    imp: number,
    dx: number,
    dy: number,
    dz: number,
    d: number,
  ): void {
    b.alive = false;
    b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const dl = d || 1;
    const ny = dy / dl;
    b.body.applyImpulse(
      {
        x: (dx / dl) * imp,
        y: Math.max(0, ny) * imp * 0.5 + 0.4,
        z: (dz / dl) * imp,
      },
      true,
    );
    b.body.applyTorqueImpulse(
      {
        x: (Math.random() - 0.5) * 0.7,
        y: (Math.random() - 0.5) * 0.7,
        z: (Math.random() - 0.5) * 0.7,
      },
      true,
    );
  }

  /**
   * 整体坍塌：剩余块全部活化 + 建筑倒塌式冲量
   * ------------------------------------------------------------
   * 设计要点(区别于旧版"从塔心炸散")：
   *  - 水平径向：从塔心向外散(建筑物倾倒外扩)
   *  - 垂直：上部块微抬(0.5)顺势外抛，下部块微沉(-0.2)向下坐塌
   *  - 扭矩 ±1.0：略大于弹坑碎渣，让大块倒塌时翻滚，但仍小于旧版乱飞
   *  冲量 collapseImpulse(~3.5) 配合小块质量 → 外散速度 ~2.4m/s，坍塌感
   */
  private collapse(): void {
    this.state = 'destroyed';
    const imp = CONFIG.destruction.tower.collapseImpulse;
    let n = 0;
    for (const b of this.blocks) {
      if (!b.alive) continue;
      b.alive = false;
      b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      const t = b.body.translation();
      const dx = t.x - this.center.x,
        dy = t.y - this.center.y,
        dz = t.z - this.center.z;
      const d = Math.hypot(dx, dy, dz) || 1;
      const ny = dy / d;
      b.body.applyImpulse(
        {
          x: (dx / d) * imp,
          y: (ny > 0 ? 0.5 : -0.2) * imp,
          z: (dz / d) * imp,
        },
        true,
      );
      b.body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * 2,
          y: (Math.random() - 0.5) * 2,
          z: (Math.random() - 0.5) * 2,
        },
        true,
      );
      n++;
    }
    log.info('tower COLLAPSED', { remaining: n });
  }

  /** 诊断 */
  get integrity(): number {
    return this.totalBlocks === 0
      ? 0
      : 1 - this.lostBlocks / this.totalBlocks;
  }
}
