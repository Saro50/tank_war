import RAPIER from '@dimforge/rapier3d-compat';
import { BoxGeometry, DoubleSide, Mesh, MeshStandardMaterial, Shape, ShapeGeometry } from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';
import { Destructible, Fragment } from '../entities/Destructible';
import { Tower } from '../entities/Tower';
import { Tree } from '../entities/Tree';
import { FencePost } from '../entities/FencePost';
import { StaticTank } from '../entities/StaticTank';
import { Logger } from '../utils/Logger';

const log = Logger.create('Destruction');

// 砖块几何/材质(模块级共享，基于 config 尺寸)
const brickGeoA = new BoxGeometry(
  CONFIG.destruction.brick.size.x,
  CONFIG.destruction.brick.size.y,
  CONFIG.destruction.brick.size.z,
); // 前后墙砖(长沿 x)
const brickGeoB = new BoxGeometry(
  CONFIG.destruction.brick.size.z,
  CONFIG.destruction.brick.size.y,
  CONFIG.destruction.brick.size.x,
); // 左右墙砖(长沿 z, x/z 互换)
const brickMat = new MeshStandardMaterial({
  color: 0x9c4a2a,
  roughness: 0.95,
  metalness: 0.0,
});

interface Brick {
  body: RAPIER.RigidBody;
  mesh: Mesh;
}

/**
 * 房屋：整体结构耐久 + 屋顶瓦块。
 * ------------------------------------------------------------
 * 屋顶是 fixed 刚体、物理上"焊死"，与墙砖无支撑关系。
 * 故用「结构 HP 累积伤害」模型(与塔楼 collapse 同思路)：
 *  爆炸落在墙身范围内 → 按距离衰减扣结构 HP；
 *  HP ≤ 0 → 整栋屋顶活化塌落(否则永远浮空)。
 * 砖块只是视觉碎片(各自受冲击飞溅)，与结构 HP 是两条独立通道。
 */
interface House {
  /** 本栋屋顶瓦块/屋脊(塌落时整体活化) */
  tiles: { body: RAPIER.RigidBody; mesh: Mesh; alive: boolean }[];
  /** 房屋中心 x/z */
  centerX: number;
  centerZ: number;
  /** 墙体半宽/半深(判定爆炸是否落在墙身水平范围内) */
  halfX: number;
  halfZ: number;
  /** 墙体顶/底 y(判定爆炸是否打在墙身高度内) */
  topY: number;
  bottomY: number;
  /** 结构耐久(累积伤害用) */
  hp: number;
  maxHp: number;
  /** 屋顶是否已塌(塌过一次就不再判定) */
  collapsed: boolean;
}

/**
 * 破坏系统
 * ============================================================
 * 管理两类可破坏物：
 *  1. Destructible 箱子 —— Voronoi 整体炸碎
 *  2. Brick 砖墙房子 —— 独立砖块预砌堆叠，爆炸后逐块受力脱落、
 *     上方砖块因失去支撑自然坍塌("逐渐碎开落地"由物理模拟自然产生)
 *
 * 爆炸响应(onExplosion)：
 *  - 半径内箱子 → 触发 Voronoi 破碎
 *  - 半径内砖块 → 按距离衰减施加径向冲量(+上扰+随机扭矩)
 *    砖块默认 sleep，受力自动唤醒；坍塌时碰撞唤醒上方 sleep 砖块
 */
export class DestructionSystem {
  private readonly physics: PhysicsWorld;
  private readonly render: RenderScene;
  private destructibles: Destructible[] = [];
  private bricks: Brick[] = [];
  private towers: Tower[] = [];
  private trees: Tree[] = [];
  private readonly treeByCollider = new Map<number, Tree>();
  private fences: FencePost[] = [];
  private readonly fenceByCollider = new Map<number, FencePost>();
  /** 静态展示坦克(可破坏目标：HP 归零被炸翻) */
  private staticTanks: StaticTank[] = [];
  /** 屋顶瓦块(被爆炸活化掉落 = 破洞) */
  private roofTiles: { body: RAPIER.RigidBody; mesh: Mesh; alive: boolean }[] = [];
  /** 房屋(结构 HP + 屋顶瓦块，HP 归零屋顶塌落) */
  private houses: House[] = [];
  private fragments: Fragment[] = [];
  /** 坦克 collider handle(识别坦克参与碰撞) + 刚体(读速度算撞击伤害) */
  private tankCollider = -1;
  private tankBody?: RAPIER.RigidBody;
  /** 撞击冷却(秒)：连续碰撞不重复扣血，避免一帧多次 applyDamage */
  private ramCooldown = 0;

  constructor(physics: PhysicsWorld, render: RenderScene) {
    this.physics = physics;
    this.render = render;
    log.info('destruction system ready');
  }

  /** 注册坦克 collider handle(撞击破坏判定用)。由 main 创建坦克后调用。 */
  setTankCollider(handle: number): void {
    this.tankCollider = handle;
    this.tankBody = this.physics.world.getCollider(handle).parent() ?? undefined;
  }

  /** 创建可破坏物：箱子(hp=1)或塔楼(hp=100)，统一机制 */
  addBox(
    pos: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    maxHp = 1,
    color = 0x8a6d3b,
    baseSize?: { x: number; y: number; z: number },
  ): Destructible {
    const d = new Destructible(this.physics, this.render, pos, size, maxHp, color, baseSize);
    this.destructibles.push(d);
    return d;
  }

  /**
   * 创建砖墙房子(四面墙，砖块独立堆叠，错缝砌筑)
   * @param center 房子中心(地面层 y)
   * @param house  {x:宽, y:高, z:深}
   * @returns 砖块总数
   */
  addBrickHouse(
    center: { x: number; y: number; z: number },
    house: { x: number; y: number; z: number },
  ): number {
    const bx = CONFIG.destruction.brick.size.x;
    const by = CONFIG.destruction.brick.size.y;
    const w = house.x;
    const h = house.y;
    const d = house.z;

    const colsA = Math.floor(w / bx); // 前后墙列数
    const colsB = Math.floor(d / bx); // 左右墙列数(砖长沿 z)
    const rows = Math.floor(h / by);

    const xMin = center.x - w / 2 + bx / 2;
    const xMax = center.x + w / 2 - bx / 2;
    const zMin = center.z - d / 2 + bx / 2;
    const zMax = center.z + d / 2 - bx / 2;

    let count = 0;
    for (let j = 0; j < rows; j++) {
      const off = (j % 2) * (bx / 2); // 错缝
      const py = center.y + (j + 0.5) * by;
      // 前后墙(砖长沿 x)
      for (let i = 0; i < colsA; i++) {
        const px = center.x - w / 2 + (i + 0.5) * bx + off;
        if (px < xMin || px > xMax) continue;
        this.createBrick(px, py, center.z + d / 2, brickGeoA, bx / 2, by / 2, CONFIG.destruction.brick.size.z / 2);
        this.createBrick(px, py, center.z - d / 2, brickGeoA, bx / 2, by / 2, CONFIG.destruction.brick.size.z / 2);
        count += 2;
      }
      // 左右墙(砖长沿 z)
      for (let i = 0; i < colsB; i++) {
        const pz = center.z - d / 2 + (i + 0.5) * bx + off;
        if (pz < zMin || pz > zMax) continue;
        this.createBrick(center.x - w / 2, py, pz, brickGeoB, CONFIG.destruction.brick.size.z / 2, by / 2, bx / 2);
        this.createBrick(center.x + w / 2, py, pz, brickGeoB, CONFIG.destruction.brick.size.z / 2, by / 2, bx / 2);
        count += 2;
      }
    }

    log.info('brick house built', { bricks: count, house });
    return count;
  }

  /** 创建水泥塔楼(块状渐进破坏) */
  addTower(
    pos: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    baseSize: { x: number; y: number; z: number },
  ): Tower {
    const t = new Tower(this.physics, this.render, pos, size, baseSize);
    this.towers.push(t);
    return t;
  }

  /** 创建树(被炮弹击中或坦克撞击都会倒) */
  addTree(pos: { x: number; y: number; z: number }): Tree {
    const tr = new Tree(this.physics, this.render, pos);
    this.trees.push(tr);
    this.treeByCollider.set(tr.colliderHandle, tr);
    return tr;
  }

  /** 创建一排栅栏(沿 start→end 均匀 count 根立柱，被坦克撞各自倒) */
  addFenceRow(
    start: { x: number; z: number },
    end: { x: number; z: number },
    count: number,
  ): void {
    for (let i = 0; i < count; i++) {
      const t = count === 1 ? 0.5 : i / (count - 1);
      const x = start.x + (end.x - start.x) * t;
      const z = start.z + (end.z - start.z) * t;
      const p = new FencePost(this.physics, this.render, { x, y: 0, z });
      this.fences.push(p);
      this.fenceByCollider.set(p.colliderHandle, p);
    }
  }

  /** 创建房屋 = 砖墙(可坍塌) + 人字屋顶瓦块(被炮弹打破洞) */
  addHouse(
    center: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
  ): void {
    this.addBrickHouse(center, size);
    const tiles = this.buildRoof(center, size);
    // 结构耐久按房屋体积标定(越大越抗揍)：6×5×6≈22HP, 5×4×5≈12HP
    const maxHp = Math.max(8, Math.round((size.x * size.y * size.z) / 8));
    this.houses.push({
      tiles,
      centerX: center.x,
      centerZ: center.z,
      halfX: size.x / 2,
      halfZ: size.z / 2,
      topY: center.y + size.y,
      bottomY: center.y,
      hp: maxHp,
      maxHp,
      collapsed: false,
    });
  }

  /** 注册静态展示坦克(可破坏目标),由 main 创建后调用 */
  addStaticTank(tank: StaticTank): void {
    this.staticTanks.push(tank);
  }

  /**
   * 人字坡屋顶(南方农家风)
   * ------------------------------------------------------------
   * - 陡坡(roofHeightRatio 大)：脊高高，利于雨水快速滑落
   * - 屋檐外延(eave)：瓦块四面超出墙体一截，遮雨遮阳(屋檐挑出是农家标志)
   * - 屋脊：顶部沿 z 轴的长条(可破坏)
   * 瓦块沿 z 分段，被爆炸活化掉落 = 破洞。
   */
  private buildRoof(
    center: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
  ): { body: RAPIER.RigidBody; mesh: Mesh; alive: boolean }[] {
    const cfg = CONFIG.destruction.house;
    const top = center.y + size.y;
    const eave = cfg.eave;
    const halfSpan = size.x / 2 + eave; // 半跨度(含 x 方向屋檐)
    const fullZ = size.z + eave * 2; // z 方向也外延屋檐
    const roofH = size.x * cfg.roofHeightRatio; // 脊高(陡坡)
    const slope = Math.atan2(roofH, halfSpan);
    const slopeLen = Math.hypot(halfSpan, roofH); // 坡面斜长(含屋檐)
    const segs = Math.max(3, Math.floor(fullZ / 0.9));
    const segLen = fullZ / segs;
    const tileGeo = new BoxGeometry(slopeLen, 0.08, segLen * 0.94);
    const tileMat = new MeshStandardMaterial({ color: 0x5a3a2a, roughness: 0.9, metalness: 0 });
    // 本栋屋顶的瓦块(同时登记全局 roofTiles 供爆炸破洞用，并返回给 addHouse 做承重关联)
    const tiles: { body: RAPIER.RigidBody; mesh: Mesh; alive: boolean }[] = [];
    const addTile = (t: { body: RAPIER.RigidBody; mesh: Mesh; alive: boolean }): void => {
      this.roofTiles.push(t);
      tiles.push(t);
    };

    // 两坡瓦块(rotation.z = -side*slope：瓦块贴合坡面，脊高端、檐低端，不悬空)
    for (const side of [-1, 1]) {
      for (let i = 0; i < segs; i++) {
        const z = center.z - fullZ / 2 + (i + 0.5) * segLen;
        const mx = center.x + (side * halfSpan) / 2;
        const my = top + roofH / 2;
        // BUG 修复：body 必须设旋转。SyncBridge.sync() 每帧用 body.rotation 覆盖
        // mesh.quaternion，若 body=identity 则 mesh 被强制水平 → 瓦块不贴坡面、悬空。
        // 倾斜由 body 带(绕 z 转 -side*slope)，collider 跟随 body 旋转贴合坡面。
        const ang = -side * slope;
        const body = this.physics.world.createRigidBody(
          RAPIER.RigidBodyDesc.fixed()
            .setTranslation(mx, my, z)
            .setRotation({ x: 0, y: 0, z: Math.sin(ang / 2), w: Math.cos(ang / 2) }),
        );
        this.physics.world.createCollider(
          RAPIER.ColliderDesc.cuboid((slopeLen / 2) * 0.9, 0.04, (segLen / 2) * 0.9)
            .setDensity(cfg.tileDensity)
            .setFriction(0.8)
            .setRestitution(0.1),
          body,
        );
        const mesh = new Mesh(tileGeo, tileMat);
        mesh.position.set(mx, my, z);
        // 不设 mesh.rotation：SyncBridge 每帧用 body.rotation 覆盖，倾斜由 body 带
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        this.render.scene.add(mesh);
        SyncBridge.bind(body, mesh);
        addTile({ body, mesh, alive: true });
      }
    }

    // 山墙(屋顶两端 z 方向的三角形封墙，封住屋顶下方，防从侧面看到内部空心)
    const gableShape = new Shape();
    gableShape.moveTo(-size.x / 2, 0);
    gableShape.lineTo(size.x / 2, 0);
    gableShape.lineTo(0, roofH);
    gableShape.lineTo(-size.x / 2, 0);
    const gableGeo = new ShapeGeometry(gableShape);
    const gableMat = new MeshStandardMaterial({
      color: 0x6a4a32,
      roughness: 0.95,
      metalness: 0,
      side: DoubleSide, // 室内外两面都可见
    });
    for (const side of [-1, 1]) {
      // 山墙物理：用薄 cuboid 近似三角形区域(底宽 size.x、高 roofH)。
      // 三角形无原生 collider，cuboid 是最简近似；山墙基本不参与坦克碰撞，够用。
      // body 平移 = mesh 期望位置(三角形底边中心 top)，SyncBridge 据此刷 mesh；
      // collider 用相对 body 的局部偏移上移 roofH/2，使碰撞体覆盖 top~top+roofH。
      const gx = center.x;
      const gz = center.z + (side * size.z) / 2;
      const gBody = this.physics.world.createRigidBody(
        RAPIER.RigidBodyDesc.fixed().setTranslation(gx, top, gz),
      );
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid((size.x / 2) * 0.9, roofH / 2, 0.08)
          .setDensity(cfg.tileDensity)
          .setFriction(0.8)
          .setRestitution(0.1)
          .setTranslation(0, roofH / 2, 0),
        gBody,
      );
      const gable = new Mesh(gableGeo, gableMat);
      gable.position.set(gx, top, gz);
      gable.castShadow = true;
      gable.receiveShadow = true;
      this.render.scene.add(gable);
      SyncBridge.bind(gBody, gable);
      addTile({ body: gBody, mesh: gable, alive: true });
    }

    // 屋脊(顶部沿 z 的长条，可被打掉)
    const ridgeGeo = new BoxGeometry(0.32, 0.14, fullZ);
    const rBody = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(center.x, top + roofH, center.z),
    );
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(0.16, 0.07, fullZ / 2)
        .setDensity(cfg.tileDensity)
        .setFriction(0.8),
      rBody,
    );
    const rMesh = new Mesh(ridgeGeo, tileMat);
    rMesh.position.set(center.x, top + roofH, center.z);
    rMesh.castShadow = true;
    this.render.scene.add(rMesh);
    SyncBridge.bind(rBody, rMesh);
    addTile({ body: rBody, mesh: rMesh, alive: true });

    return tiles;
  }

  /** 创建单块砖(动态刚体 + 网格)，高摩擦防滑、高密度有重量感 */
  private createBrick(
    x: number,
    y: number,
    z: number,
    geo: BoxGeometry,
    hx: number,
    hy: number,
    hz: number,
  ): void {
    const cfg = CONFIG.destruction.brick;
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(x, y, z)
      .setLinearDamping(0.05) // 低阻尼，让重力主导(不飘)
      .setAngularDamping(0.1);
    const body = this.physics.world.createRigidBody(bodyDesc);
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setDensity(cfg.density) // 重 → 有重量感
        .setFriction(0.9) // 高摩擦 → 堆叠稳定、坍塌不滑
        .setRestitution(0.0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), // 撞击破坏需要事件上报
      body,
    );
    const mesh = new Mesh(geo, brickMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.render.scene.add(mesh);
    SyncBridge.bind(body, mesh);
    this.bricks.push({ body, mesh });
  }

  /** 炮击爆炸：以爆心为中心、爆炸半径内施加破坏(复用统一 applyDamage) */
  onExplosion(pos: { x: number; y: number; z: number }, radius: number): void {
    this.applyDamage(pos, radius, CONFIG.destruction.hitDamage);
  }

  /**
   * 统一受击入口(炮击与撞击共用)
   * ------------------------------------------------------------
   * 以 pos 为中心、radius 为影响半径，对范围内所有可破坏物施加伤害：
   *  - 箱子/塔楼/树：HP 机制，按距离衰减扣血(各自内部再按自有 hitRadius 过滤)
   *  - 砖块：径向衰减冲量飞溅
   *  - 屋顶瓦块/山墙：半径内活化掉落
   *  - 房屋结构：扣结构 HP，归零则整栋屋顶塌落
   * 炮击调用 damage=hitDamage；撞击调用 damage=按坦克速度缩放(由 handleCollision 算好)。
   * 这样炮击与撞击对每个可破坏物完全一致。
   */
  applyDamage(pos: { x: number; y: number; z: number }, radius: number, damage: number): void {
    const r2 = radius * radius;

    // 箱子(HP 机制：伤害按距离衰减，hp<=0 才倒塌)
    let destroyed = 0;
    for (const d of this.destructibles) {
      if (d.state !== 'intact') continue;
      const t = d.body.translation();
      const dx = t.x - pos.x,
        dy = t.y - pos.y,
        dz = t.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const dist = Math.sqrt(d2);
      const falloff = 1 - dist / radius;
      const frags = d.takeHit(pos, damage * falloff);
      if (frags.length > 0) destroyed++;
      this.fragments.push(...frags);
    }

    // 静态展示坦克(HP 机制：距离衰减扣血，hp<=0 被炸翻)
    let tanksHit = 0;
    for (const st of this.staticTanks) {
      if (st.state !== 'intact') continue;
      const t = st.body.translation();
      const dx = t.x - pos.x,
        dy = t.y - pos.y,
        dz = t.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const dist = Math.sqrt(d2);
      const falloff = 1 - dist / radius;
      st.takeHit(pos, damage * falloff);
      tanksHit++;
    }

    // 砖块(距离衰减冲量 + 上扰 + 随机扭矩)
    const imp = CONFIG.destruction.brick.impulse;
    let bricksHit = 0;
    for (const b of this.bricks) {
      const t = b.body.translation();
      const dx = t.x - pos.x,
        dy = t.y - pos.y,
        dz = t.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const dist = Math.sqrt(d2) || 0.01;
      const falloff = 1 - dist / radius; // 中心 1 → 边缘 0
      const mag = imp * falloff;
      b.body.applyImpulse(
        { x: (dx / dist) * mag, y: (dy / dist) * mag + mag * 0.6, z: (dz / dist) * mag },
        true,
      );
      b.body.applyTorqueImpulse(
        {
          x: (Math.random() - 0.5) * mag * 0.5,
          y: (Math.random() - 0.5) * mag * 0.5,
          z: (Math.random() - 0.5) * mag * 0.5,
        },
        true,
      );
      bricksHit++;
    }

    // 塔(块状渐进：每炮坏一部分，累积过多倒塌)
    let towersHit = 0;
    for (const tw of this.towers) {
      if (tw.state !== 'intact') continue;
      tw.takeHit(pos); // 内部按 hitRadius 只活化命中点附近块，远处塔无效果
      towersHit++;
    }

    // 树(被爆炸波及 → 倒下)
    let treesHit = 0;
    for (const tr of this.trees) {
      if (tr.state !== 'intact') continue;
      tr.takeHit(pos);
      treesHit++;
    }

    // 栅栏(被爆炸波及 → 倒下，与树同机制)
    let fencesHit = 0;
    for (const f of this.fences) {
      if (f.state !== 'intact') continue;
      f.takeHit(pos);
      fencesHit++;
    }

    // 屋顶瓦块(被爆炸波及 → 活化掉落，形成破洞)
    let roofHit = 0;
    for (const tile of this.roofTiles) {
      if (!tile.alive) continue;
      const tt = tile.body.translation();
      const dx = tt.x - pos.x, dy = tt.y - pos.y, dz = tt.z - pos.z;
      if (dx * dx + dy * dy + dz * dz >= radius * radius) continue;
      tile.alive = false;
      tile.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      const d = Math.hypot(dx, dy, dz) || 1;
      tile.body.applyImpulse(
        { x: (dx / d) * 2, y: -1.5, z: (dz / d) * 2 },
        true,
      );
      roofHit++;
    }

    // 房屋结构耐久：爆炸到墙身的距离在半径内 → 按距离衰减扣结构 HP；
    // HP ≤ 0 屋顶(fixed)整体活化塌落(否则永远浮空)。
    // 用「点到墙体 AABB 的最近距离」判定，炮弹打在墙体外侧表面也算命中。
    // 砖块飞溅与结构 HP 是两条独立通道：砖块是视觉碎片，HP 决定屋顶是否塌。
    let roofsCollapsed = 0;
    for (const house of this.houses) {
      if (house.collapsed) continue;
      // 点到墙身包围盒(含墙身高度范围)的最近距离；在盒内为 0
      const cx = Math.max(house.centerX - house.halfX, Math.min(pos.x, house.centerX + house.halfX));
      const cz = Math.max(house.centerZ - house.halfZ, Math.min(pos.z, house.centerZ + house.halfZ));
      const cy = Math.max(house.bottomY, Math.min(pos.y, house.topY));
      const ddx = pos.x - cx, ddy = pos.y - cy, ddz = pos.z - cz;
      const distSq = ddx * ddx + ddy * ddy + ddz * ddz;
      if (distSq < radius * radius) {
        const dist = Math.sqrt(distSq);
        const falloff = 1 - dist / radius;
        house.hp -= damage * falloff;
      }
      if (house.hp <= 0) {
        house.collapsed = true;
        for (const tile of house.tiles) {
          if (!tile.alive) continue;
          tile.alive = false;
          tile.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
          // 微下沉冲量，模拟失去支撑后自然下坠(非爆炸式横飞)
          tile.body.applyImpulse(
            { x: (Math.random() - 0.5) * 0.6, y: -1.0, z: (Math.random() - 0.5) * 0.6 },
            true,
          );
          roofsCollapsed++;
        }
      }
    }

    if (destroyed > 0 || bricksHit > 0 || towersHit > 0 || treesHit > 0 || fencesHit > 0 || tanksHit > 0 || roofHit > 0 || roofsCollapsed > 0) {
      log.info('damage', { destroyed, bricksHit, towersHit, treesHit, fencesHit, tanksHit, roofHit, roofsCollapsed, radius, damage: damage.toFixed(1) });
    }
  }

  /**
   * 碰撞分发回调(main 统一 drain 调用)：坦克撞击可破坏物 → 与炮击一致的破坏。
   * ------------------------------------------------------------
   * 设计：撞击 = 以被撞物位置为爆心的小型 applyDamage，伤害按坦克速度缩放。
   *   - 只有坦克参与碰撞才触发(地面/山体未开碰撞事件，不会进来)
   *   - 被撞方任意可破坏物：树/栅栏/砖墙/塔/箱子/屋顶，统一走 applyDamage
   *   - 速度低于阈值不计伤害(静止贴着不算撞)；冷却去重防一帧多次扣血
   * 与炮击完全共用 applyDamage → 撞击和炮击对每个可破坏物行为一致。
   */
  handleCollision(h1: number, h2: number): void {
    if (this.tankCollider < 0 || !this.tankBody) return;
    // 坦克必须参与这次碰撞
    const tankInvolved = h1 === this.tankCollider || h2 === this.tankCollider;
    if (!tankInvolved) return;
    if (this.ramCooldown > 0) return; // 冷却期内忽略，防连续碰撞重复扣血

    // 坦克水平速度(撞击力度来源)
    const v = this.tankBody.linvel();
    const speed = Math.hypot(v.x, v.z);
    const minSpeed = CONFIG.tank.dust.minSpeed; // 复用扬尘阈值：慢速/静止不造成破坏
    if (speed < minSpeed) return;

    // 取被撞物位置作爆心(另一方的刚体 translation)
    const other = h1 === this.tankCollider ? h2 : h1;
    const col = this.physics.world.getCollider(other);
    const hitBody = col.parent();
    if (!hitBody) return;
    const t = hitBody.translation();

    // 伤害按速度缩放：满速(moveSpeed)≈ 炮击的 0.5 倍，慢速按比例衰减
    const ramScale = 0.5 * Math.min(1, speed / CONFIG.tank.moveSpeed);
    const damage = CONFIG.destruction.hitDamage * ramScale;
    // 撞击半径比爆炸小(贴身撞击)
    const radius = CONFIG.destruction.explosionRadius * 0.6;
    this.ramCooldown = 0.2; // 0.2s 冷却
    this.applyDamage({ x: t.x, y: t.y, z: t.z }, radius, damage);
  }

  /** 每帧更新碎片寿命/淡出(砖块由物理同步，不需更新) + 撞击冷却 */
  update(dt: number): void {
    if (this.ramCooldown > 0) this.ramCooldown -= dt;
    this.fragments = this.fragments.filter((f) => {
      if (f.update(dt)) return true;
      f.dispose(this.physics, this.render);
      return false;
    });
  }

  /** 诊断 */
  get stats(): { intact: number; fragments: number; bricks: number; towers: number; trees: number; fences: number } {
    let intact = 0;
    for (const d of this.destructibles) if (d.state === 'intact') intact++;
    let towers = 0;
    for (const t of this.towers) if (t.state === 'intact') towers++;
    let trees = 0;
    for (const tr of this.trees) if (tr.state === 'intact') trees++;
    let fences = 0;
    for (const f of this.fences) if (f.state === 'intact') fences++;
    return { intact, fragments: this.fragments.length, bricks: this.bricks.length, towers, trees, fences };
  }
}
