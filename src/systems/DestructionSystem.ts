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
import { ResupplyPoint } from '../entities/ResupplyPoint';
import { StaticTankBase } from '../entities/tanks/StaticTankBase';
import type { IControllableTank } from '../entities/IControllableTank';
import type { TankPart } from '../entities/TankStatus';
import type { SoundHooks } from '../audio/SoundSystem';
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
 *  2. Brick 砖墙房子 —— 独立砖块预砌(fixed 锁死)，受击时命中半径内的
 *     砖块转 dynamic 飞溅脱落。
 *
 * 静态物体统一原则：所有可破坏物(fixed)只有在被炮弹爆炸(onExplosion)
 * 或坦克撞击(handleCollision)交互时，才由 applyDamage 转 dynamic。
 * 避免"靠物理堆叠维持稳定"——rapier 里堆叠极易因微小重叠/积分误差
 * 连锁抖动 → 整栋墙自动倒塌。
 *
 * 爆炸响应(onExplosion → applyDamage)：
 *  - 半径内箱子 → 触发 Voronoi 破碎
 *  - 半径内砖块 → fixed 转 dynamic + 按距离衰减施加径向冲量
 *    (+上扰+随机扭矩)，只活化直接命中的砖块，远处砖块继续 fixed 稳固
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
  /** 补给点(可被摧毁/再生,实现 Damageable),applyDamage 伤害链统一遍历 */
  private resupplyPoints: ResupplyPoint[] = [];
  /** 静态展示坦克(可破坏目标：HP 归零被炸翻) */
  private staticTanks: StaticTankBase[] = [];
  /** 屋顶瓦块(被爆炸活化掉落 = 破洞) */
  private roofTiles: { body: RAPIER.RigidBody; mesh: Mesh; alive: boolean }[] = [];
  /** 房屋(结构 HP + 屋顶瓦块，HP 归零屋顶塌落) */
  private houses: House[] = [];
  private fragments: Fragment[] = [];
  /** 当前玩家活性坦克:simulateStaticHit 定位用。撞击判定已改用 tankByCollider(任意坦克) */
  private activeTank?: IControllableTank;
  /** 所有可附身坦克（玩家+静态），用于统一 update */
  private controllableTanks: IControllableTank[] = [];
  /** collider handle → 坦克 映射(handleCollision 任意坦克撞击判定,不再只认玩家) */
  private readonly tankByCollider = new Map<number, IControllableTank>();
  /**
   * collider handle → {tank, part} 部位反查表(M2)。
   * 含主 collider(兜底 hull)+ 部位 sensor collider(turret/track)。
   * AP 直击(applyDirectHit)据此判定命中部位,注入对应 debuff 到 tank.status。
   */
  private readonly partByCollider = new Map<number, { tank: IControllableTank; part: TankPart }>();
  /**
   * 所有坦克的刚体集合(M2 部位 sensor 修复)。
   * 部位 sensor 开了 COLLISION_EVENTS 但不产生物理阻挡——两坦克靠近时 sensor 接触对方
   * 主 collider 会触发 handleCollision,需据此排除"被撞方是坦克 body"的情况(坦克互撞走物理推开,
   * 不走 applyDamage 撞击破坏,否则巡逻靠近的坦克会互相误伤)。
   */
  private readonly tankBodySet = new Set<RAPIER.RigidBody>();
  /** 撞击冷却(秒)：连续碰撞不重复扣血，避免一帧多次 applyDamage */
  private ramCooldown = 0;
  /** 音效钩子(可选:main 创建 SoundSystem 后注入。命中敌坦时触发语音04) */
  private sound?: SoundHooks;

  constructor(physics: PhysicsWorld, render: RenderScene) {
    this.physics = physics;
    this.render = render;
    log.info('destruction system ready');
  }

  /** 注入音效钩子(命中敌坦时触发玩家语音04) */
  setSoundHooks(s: SoundHooks): void {
    this.sound = s;
  }

  /**
   * 注册所有可附身坦克,用于统一 update + 构建 collider→坦克 映射(撞击判定用)。
   */
  setControllableTanks(tanks: IControllableTank[]): void {
    this.controllableTanks = tanks;
    this.tankByCollider.clear();
    this.partByCollider.clear();
    this.tankBodySet.clear();
    for (const t of tanks) {
      this.tankByCollider.set(t.colliderHandle, t);
      // 部位反查:主 collider 兜底 hull + 部位 sensor collider(turret/track)
      this.partByCollider.set(t.colliderHandle, { tank: t, part: 'hull' });
      for (const pc of t.partColliders) this.partByCollider.set(pc.handle, { tank: t, part: pc.part });
      this.tankBodySet.add(t.body); // 撞击判定排除坦克互撞(M2 部位 sensor 修复)
    }
  }

  /**
   * 动态注册一辆坦克(导演 spawn 新 NPC 时调用)。
   * controllableTanks 是共享引用(director.allTanks 同一数组),push 后已自动包含,
   * 此处只补 collider→tank 映射,让新 NPC 接入撞击判定(handleCollision)。
   */
  registerTank(tank: IControllableTank): void {
    this.tankByCollider.set(tank.colliderHandle, tank);
    // 部位反查(动态生成的 NPC 也接入 M2 部位判定)
    this.partByCollider.set(tank.colliderHandle, { tank, part: 'hull' });
    for (const pc of tank.partColliders) this.partByCollider.set(pc.handle, { tank, part: pc.part });
    this.tankBodySet.add(tank.body);
  }

  /**
   * 注销一辆坦克的 collider 映射(NPC 被击毁并清理时调用)。
   * 注意:不把它从 controllableTanks 移除,残骸仍需 update(烟/特效)和渲染。
   * 也不从 tankBodySet 移除——坦克(含残骸)之间的碰撞仍应被跳过,避免小擦碰引发爆炸伤害。
   */
  unregisterTank(tank: IControllableTank): void {
    this.tankByCollider.delete(tank.colliderHandle);
    this.partByCollider.delete(tank.colliderHandle);
    for (const pc of tank.partColliders) this.partByCollider.delete(pc.handle);
    // 故意不操作 tankBodySet:残骸刚体仍在该集合中,防止坦克撞残骸触发 applyDamage
  }

  /**
   * 注册当前玩家活性坦克(simulateStaticHit 定位用)。由 main 切换后调用。
   * 注:撞击破坏判定已改用 tankByCollider(任意坦克参与即触发),不再依赖单一活性坦克。
   */
  setActiveTank(tank: IControllableTank): void {
    this.activeTank = tank;
  }

  /**
   * 调试用:对最近的一辆完好静态坦克施加一次满伤受击(验证损坏链,无 AI 攻击者时用)。
   * 爆心设在目标刚体前方 0.8m(车身内) → falloff 接近满伤,命中约 hitDamage 伤害。
   */
  simulateStaticHit(): void {
    if (!this.activeTank) return;
    const activePos = this.activeTank.body.translation();
    let nearest: StaticTankBase | undefined;
    let nearestD2 = Infinity;
    for (const st of this.staticTanks) {
      if (st.state !== 'intact' || st === this.activeTank) continue;
      const t = st.body.translation();
      const d2 = (t.x - activePos.x) ** 2 + (t.z - activePos.z) ** 2;
      if (d2 < nearestD2) {
        nearestD2 = d2;
        nearest = st;
      }
    }
    if (!nearest) return;
    const t = nearest.body.translation();
    this.applyDamage({ x: t.x, y: t.y + 0.5, z: t.z + 0.8 }, CONFIG.destruction.explosionRadius, CONFIG.destruction.hitDamage);
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
   * 创建砖墙房子(四面墙，砖块各自 fixed 锁死、错缝砌筑)
   * 砖块默认 fixed(不靠堆叠稳定，防自动倒塌)；受击时由 applyDamage 转 dynamic 飞溅。
   * @param center 房子中心(地面层 y)
   * @param house  {x:宽, y:高, z:深}
   * @returns 实际砖墙顶 y(center.y + rows*by)。砖块按 by 整数层堆叠，
   *          house.y 非 by 整数倍时实际墙高 < house.y，屋顶须以此为准才不浮空。
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
    // 实际墙顶：最后一层砖的上表面 = center.y + rows*by。
    // rows*by 可能 < house.y(非整数倍)，屋顶(buildRoof)必须用此值而非 center.y+house.y，
    // 否则屋顶底沿悬在墙顶之上 → 整栋屋顶浮空。
    return center.y + rows * by;
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
    const wallTopY = this.addBrickHouse(center, size); // 实际砖墙顶(防屋顶浮空)
    const tiles = this.buildRoof(center, size, wallTopY);
    // 结构耐久按房屋体积标定(越大越抗揍)：6×5×6≈22HP, 5×4×5≈12HP
    const maxHp = Math.max(8, Math.round((size.x * size.y * size.z) / 8));
    this.houses.push({
      tiles,
      centerX: center.x,
      centerZ: center.z,
      halfX: size.x / 2,
      halfZ: size.z / 2,
      topY: wallTopY, // 爆炸命中判定的高度上界用实际墙顶，与屋顶/砖墙一致
      bottomY: center.y,
      hp: maxHp,
      maxHp,
      collapsed: false,
    });
  }

  /** 注册静态展示坦克(可破坏目标),由 main 创建后调用 */
  addStaticTank(tank: StaticTankBase): void {
    this.staticTanks.push(tank);
  }

  /** 注册补给点(可被摧毁/再生),融入 applyDamage 伤害链 */
  addResupplyPoint(rp: ResupplyPoint): void {
    this.resupplyPoints.push(rp);
  }

  /** 获取已注册的静态展示坦克列表(用于构建可附身列表) */
  getStaticTanks(): StaticTankBase[] {
    return this.staticTanks;
  }

  /**
   * 人字坡屋顶(南方农家风)
   * ------------------------------------------------------------
   * - 陡坡(roofHeightRatio 大)：脊高高，利于雨水快速滑落
   * - 屋檐外延(eave)：瓦块四面超出墙体一截，遮雨遮阳(屋檐挑出是农家标志)
   * - 屋脊：顶部沿 z 轴的长条(可破坏)
   * 瓦块沿 z 分段，被爆炸活化掉落 = 破洞。
   *
   * @param wallTopY 砖墙实际顶 y(由 addBrickHouse 返回)。屋顶底沿贴合此值，
   *                 不能用 center.y+size.y——砖块按 by 整数层堆，house.y 非
   *                 整数倍时墙顶低于 size.y，用理论值会让整栋屋顶浮空。
   */
  private buildRoof(
    center: { x: number; y: number; z: number },
    size: { x: number; y: number; z: number },
    wallTopY: number,
  ): { body: RAPIER.RigidBody; mesh: Mesh; alive: boolean }[] {
    const cfg = CONFIG.destruction.house;
    const top = wallTopY; // 屋顶底沿贴合砖墙实际顶(防浮空)
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

  /**
   * 创建单块砖(fixed 刚体 + 网格)
   * ------------------------------------------------------------
   * 砖块默认 fixed 锁死，避免"靠物理堆叠维持稳定"——堆叠在 rapier 里
   * 极易因初始微小重叠/积分误差连锁抖动 → 整栋墙自动倒塌。
   * 与 Tree/Tower 同思路：未受击时纹丝不动，受击时由 applyDamage 转
   * dynamic 飞溅。density/friction 保留，供转 dynamic 后的飞溅手感。
   */
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
    const bodyDesc = RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z);
    const body = this.physics.world.createRigidBody(bodyDesc);
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hx, hy, hz)
        .setDensity(cfg.density) // 重 → 转 dynamic 后有重量感
        .setFriction(0.9) // 高摩擦 → 飞溅落地不滑
        .setRestitution(0.0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS), // 坦克撞击需事件上报(handleCollision)
      body,
    );
    const mesh = new Mesh(geo, brickMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.render.scene.add(mesh);
    SyncBridge.bind(body, mesh);
    this.bricks.push({ body, mesh });
  }

  /**
   * 炮击爆炸：以爆心为中心、爆炸半径内施加破坏(复用统一 applyDamage)。
   * @param excludeTank 开火的坦克（通常是当前活性坦克），防止自伤。
   * @param destructibleMultiplier 可破坏物(箱子/房屋/补给点)伤害倍率。
   *        HE 弹清建筑强(>1)、AP 弹对建筑弱(<1);坦克伤害不受此影响(走装甲逻辑)。
   *        详见 docs/combat-layer-design.md §2.5.1。
   */
  onExplosion(
    pos: { x: number; y: number; z: number },
    radius: number,
    excludeTank?: IControllableTank,
    destructibleMultiplier = 1,
  ): void {
    this.applyDamage(pos, radius, CONFIG.destruction.hitDamage, excludeTank, destructibleMultiplier);
  }

  /**
   * AP 直击伤害(弹药种类增强 · 直击管线 + M2 部位判定)
   * ------------------------------------------------------------
   * 与 AOE applyDamage 的区别:
   *  - 精确到单个命中目标(按 hitColliderHandle 反查 partByCollider),无距离衰减(满伤);
   *  - 按弹种算装甲穿透(ap.armorPenetration 削弱方向装甲);
   *  - 命中坦克时直击结算 + 按部位(turret/track)注入 debuff 到 tank.status;
   *  - 命中环境(建筑/树/地面)则降级为小 AOE。
   *
   * @param ammoCfg AP 弹种参数(含 damageMultiplier/armorPenetration/destructibleMultiplier)
   */
  applyDirectHit(
    pos: { x: number; y: number; z: number },
    hitColliderHandle: number,
    excludeTank: IControllableTank | undefined,
    ammoCfg: typeof CONFIG.weapon.ammoTypes.ap,
  ): void {
    const info = this.partByCollider.get(hitColliderHandle);
    if (info) {
      const { tank, part } = info;
      if (tank === excludeTank || tank.state !== 'intact') return;
      // 伤害结算:部位仅决定 debuff,伤害本身走方向装甲(与 hull 一致)
      const baseMult = this.armorMultiplier(tank, pos);
      const pen = 1 - ammoCfg.armorPenetration;
      const reduction = tank.status.damageReduction;
      const dmg = CONFIG.destruction.hitDamage * ammoCfg.damageMultiplier * baseMult * pen * reduction;
      this.fragments.push(...tank.takeHit(pos, dmg));
      // 部位 debuff 注入(M2 核心:turret/track 命中注入对应 debuff 到 status)
      this.applyPartDebuff(tank, part);
      log.info('AP direct hit', { tank: tank.displayName, part, dmg: dmg.toFixed(1), hp: tank.getHp().toFixed(0) });
      // 音效:命中敌坦(机械音爆炸 + 玩家语音04);excludeTank 是开火者(owner)
      this.sound?.onTankHit(excludeTank, tank, pos);
      return;
    }
    // 非坦克部位 collider(AP 打到环境:建筑/树/地面):降级为小 AOE,对可破坏物按 AP 倍率
    this.applyDamage(
      pos,
      CONFIG.destruction.explosionRadius * 0.4,
      CONFIG.destruction.hitDamage,
      excludeTank,
      ammoCfg.destructibleMultiplier,
    );
  }

  /**
   * 部位 debuff 注入(M2):按命中部位给 tank.status 注入临时 debuff。
   * ------------------------------------------------------------
   *  turret → 炮塔转速 debuff(对手准星劣势,玩家绕侧窗口)
   *  track  → 机动 debuff(大幅减速但仍可缓慢机动,保留策略空间)
   *  hull/ammoRack → 无 debuff(hull 仅方向装甲;ammoRack 本期不做,用户已定无殉爆)
   * debuff 经 TankStatus.apply 注入(同 id 覆盖防叠加),到期由 status.update 自动清除。
   */
  private applyPartDebuff(tank: IControllableTank, part: TankPart): void {
    const cfg = CONFIG.combat.parts;
    if (part === 'turret') {
      tank.status.apply({ id: 'turret-dmg', remaining: cfg.turret.duration, turretScale: cfg.turret.scale });
    } else if (part === 'track') {
      tank.status.apply({
        id: 'track-dmg',
        remaining: cfg.track.duration,
        moveScale: cfg.track.scale,
        turnScale: cfg.track.scale,
      });
    }
    // hull: 无 debuff(仅方向装甲,已在伤害结算体现);ammoRack: 本期不做
  }

  /**
   * 统一受击入口(炮击与撞击共用)
   * ------------------------------------------------------------
   * 以 pos 为中心、radius 为影响半径，对范围内所有可破坏物施加伤害：
   *  - 箱子/塔楼/树：HP 机制，按距离衰减扣血(各自内部再按自有 hitRadius 过滤)
   *  - 玩家坦克/静态坦克：HP 机制，距离衰减扣血，hp<=0 被击毁
   *  - 砖块：径向衰减冲量飞溅
   *  - 屋顶瓦块/山墙：半径内活化掉落
   *  - 房屋结构：扣结构 HP，归零则整栋屋顶塌落
   * 炮击调用 damage=hitDamage；撞击调用 damage=按坦克速度缩放(由 handleCollision 算好)。
   * 这样炮击与撞击对每个可破坏物完全一致。
   * @param excludeTank 可选：指定一辆坦克跳过伤害（如开火的坦克防自伤）。
   * @param destructibleMultiplier 可破坏物(箱子/房屋/补给点)伤害倍率,默认 1。
   *        HE>1(清建筑强)、AP<1(对建筑弱);坦克伤害不乘(走装甲逻辑)。
   */
  applyDamage(
    pos: { x: number; y: number; z: number },
    radius: number,
    damage: number,
    excludeTank?: IControllableTank,
    destructibleMultiplier = 1,
  ): void {
    const r2 = radius * radius;
    // 可破坏物伤害(按弹种倍率):坦克走 damage(装甲逻辑),环境走 dmgDes(倍率调整)
    const dmgDes = damage * destructibleMultiplier;

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
      const frags = d.takeHit(pos, dmgDes * falloff);
      if (frags.length > 0) destroyed++;
      this.fragments.push(...frags);
    }

    // 所有可附身坦克（玩家 T-14 + 静态展示坦克）统一判定。
    // excludeTank 为开火的坦克时跳过，防止自伤；撞击时不用传 excludeTank。
    let tanksHit = 0;
    for (const tank of this.controllableTanks) {
      if (tank.state !== 'intact' || tank === excludeTank) continue;
      const t = tank.body.translation();
      const dx = t.x - pos.x,
        dy = t.y - pos.y,
        dz = t.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const dist = Math.sqrt(d2);
      const falloff = 1 - dist / radius;
      const mult = this.armorMultiplier(tank, pos); // 侧/背命中加伤(所有坦克)
      // 状态层 damageReduction(装甲倾斜等减伤 buff,乘法叠加在最后)
      const dmg = damage * falloff * mult * tank.status.damageReduction;
      const frags = tank.takeHit(pos, dmg);
      this.fragments.push(...frags);
      tanksHit++;
      // 音效:AOE 命中敌坦(机械音爆炸 + 玩家语音04);excludeTank 是开火者(owner)。
      // AOE 可能一次命中多辆,每辆都触发 onTankHit;语音04 内部有冷却防刷屏。
      this.sound?.onTankHit(excludeTank, tank, pos);
    }

    // 补给点(可被摧毁:HP 机制,按距离衰减扣血;摧毁后由 ResupplyPoint 自身状态机倒计时再生)
    let resupplyHit = 0;
    for (const rp of this.resupplyPoints) {
      if (rp.state !== 'intact') continue;
      const t = rp.body.translation();
      const dx = t.x - pos.x,
        dy = t.y - pos.y,
        dz = t.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const dist = Math.sqrt(d2);
      const falloff = 1 - dist / radius;
      rp.takeHit(pos, dmgDes * falloff);
      resupplyHit++;
    }

    // 砖块(fixed → 命中半径内转 dynamic + 径向衰减冲量飞溅 + 上扰 + 随机扭矩)。
    // 注意：砖块默认 fixed 锁死，必须先 setBodyType(Dynamic) 冲量才会生效，
    // 否则 fixed 刚体对 applyImpulse 完全不响应(整墙打不动)。
    // 这与炮弹/坦克两种交互一致：炮击靠 onExplosion，撞击靠 handleCollision，最终都走这里。
    const imp = CONFIG.destruction.brick.impulse;
    let bricksHit = 0;
    for (const b of this.bricks) {
      const t = b.body.translation();
      const dx = t.x - pos.x,
        dy = t.y - pos.y,
        dz = t.z - pos.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= r2) continue;
      const dist = Math.sqrt(d2);
      const falloff = 1 - Math.min(dist, radius) / radius; // 中心 1 → 边缘 0
      const mag = imp * falloff;
      // 活化：fixed → dynamic，使其可受力、受重力影响(飞溅后自然落地)
      b.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
      // 爆心正上方时纯垂直上冲，避免人为 0.01 导致的方向偏移
      const dirScale = dist > 0.001 ? mag / dist : 0;
      b.body.applyImpulse(
        { x: dx * dirScale, y: dy * dirScale + mag * 0.6, z: dz * dirScale },
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
        house.hp -= dmgDes * falloff;
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

    if (destroyed > 0 || bricksHit > 0 || towersHit > 0 || treesHit > 0 || fencesHit > 0 || tanksHit > 0 || roofHit > 0 || roofsCollapsed > 0 || resupplyHit > 0) {
      log.info('damage', { destroyed, bricksHit, towersHit, treesHit, fencesHit, tanksHit, roofHit, roofsCollapsed, resupplyHit, radius, damage: damage.toFixed(1) });
    }
  }

  /**
   * 碰撞分发回调(main 统一 drain 调用)：任意坦克撞击可破坏物 → 与炮击一致的破坏。
   * ------------------------------------------------------------
   * 设计:撞击 = 以被撞物位置为爆心的小型 applyDamage,伤害按【撞击者】速度缩放。
   *   - 任意 controllableTank(玩家或NPC)参与碰撞都触发(用 tankByCollider 反查)
   *   - 被撞方任意可破坏物:树/栅栏/砖墙/塔/箱子/屋顶,统一走 applyDamage
   *   - 速度低于阈值不计伤害(静止贴着不算撞);冷却去重防一帧多次扣血
   *   - exclude 撞击者:撞击爆炸不伤自己
   * 与炮击完全共用 applyDamage → 撞击和炮击对每个可破坏物行为一致。
   */
  handleCollision(h1: number, h2: number): void {
    if (this.ramCooldown > 0) return; // 冷却期内忽略,防连续碰撞重复扣血
    // 找参与碰撞的坦克(任意 controllableTank,不再只认玩家)
    const tank = this.tankByCollider.get(h1) ?? this.tankByCollider.get(h2);
    if (!tank || tank.state !== 'intact') return;

    // 撞击者水平速度(撞击力度来源)——用撞击者而非玩家,修复 NPC 撞玩家误用玩家速度
    const v = tank.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    const driveCfg = tank.driveConfig;
    const minSpeed = driveCfg.dust.minSpeed; // 复用扬尘阈值:慢速/静止不造成破坏
    if (speed < minSpeed) return;

    // 取被撞物位置作爆心(另一方的刚体 translation)
    const other = this.tankByCollider.has(h1) ? h2 : h1;
    const col = this.physics.world.getCollider(other);
    if (!col) return;
    const hitBody = col.parent();
    if (!hitBody) return;
    // M2 部位 sensor 修复:被撞方若为坦克 body(对方主 collider 或部位 sensor 的 parent),跳过。
    // 部位 sensor 不产生物理阻挡但会触发碰撞事件 → 若不排除,两坦克巡逻靠近时 sensor 接触
    // 对方主 collider 会被误判为"坦克撞击"互相伤害。坦克互撞走物理推开,不走 applyDamage。
    if (this.tankBodySet.has(hitBody)) return;
    const t = hitBody.translation();

    // 伤害按撞击者速度缩放:满速(moveSpeed)≈ 炮击的 0.5 倍,慢速按比例衰减
    const moveSpeed = driveCfg.moveSpeed;
    const ramScale = 0.5 * Math.min(1, speed / moveSpeed);
    const damage = CONFIG.destruction.hitDamage * ramScale;
    // 撞击半径比爆炸小(贴身撞击)
    const radius = CONFIG.destruction.explosionRadius * 0.6;
    this.ramCooldown = 0.2; // 0.2s 冷却
    // exclude 撞击者:撞击爆炸不伤自己(否则玩家撞树会炸到自己)
    this.applyDamage({ x: t.x, y: t.y, z: t.z }, radius, damage, tank);
  }

  /** 每帧更新碎片寿命/淡出(砖块由物理同步，不需更新) + 撞击冷却 + 所有可附身坦克冒烟 */
  update(dt: number): void {
    if (this.ramCooldown > 0) this.ramCooldown -= dt;
    this.fragments = this.fragments.filter((f) => {
      if (f.update(dt)) return true;
      f.dispose(this.physics, this.render);
      return false;
    });
    for (const t of this.controllableTanks) t.update(dt);
  }

  /**
   * 根据着弹点相对坦克的方向计算伤害倍率(方位装甲)
   * ------------------------------------------------------------
   * 以坦克朝向为基准:
   *  - 正面(±45°)  : 1.0x — 正面装甲最厚
   *  - 侧面(45°~135°): 1.5x — 侧击加伤,鼓励绕侧
   *  - 背面(135°~180°): 2.0x — 背击最大伤害,奖励包抄
   */
  private armorMultiplier(tank: IControllableTank, epicenter: { x: number; y: number; z: number }): number {
    const cfg = CONFIG.destruction.armor;
    const q = tank.body.rotation();
    // 从四元数计算车身偏航角
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
    const dx = epicenter.x - tank.body.translation().x;
    const dz = epicenter.z - tank.body.translation().z;
    // 将冲击方向转到坦克局部坐标系
    const localAngle = Math.atan2(
      -dx * Math.cos(yaw) - dz * Math.sin(yaw),
      -dx * Math.sin(yaw) + dz * Math.cos(yaw),
    );
    const absAngle = Math.abs(localAngle);
    if (absAngle < Math.PI / 4) return 1.0;                    // 正面(装甲最厚)
    if (absAngle < Math.PI * 3 / 4) return cfg.sideMultiplier; // 侧面
    return cfg.backMultiplier;                                  // 背面
  }

  /**
   * 从多个候选 collider handle 中选"部位优先"的(M2 部位判定修正)。
   * ------------------------------------------------------------
   * AP 一帧内可能同时接触主 collider + 部位 sensor(部位在主 collider 内部)。
   * 若取主 collider(hull),部位 debuff 永不触发;故优先选部位(turret/track)handle,
   * 保证弱点部位瞄准有效。无部位 handle 则返回第一个(hull 兜底)。
   */
  pickPartHandle(handles: number[]): number | undefined {
    if (handles.length === 0) return undefined;
    // 优先选部位(非 hull):turret/track 命中触发 debuff
    for (const h of handles) {
      const info = this.partByCollider.get(h);
      if (info && info.part !== 'hull') return h;
    }
    // 无部位:返回第一个(主 collider hull 或环境物)
    return handles[0];
  }

  /** 诊断 */
  get stats(): { intact: number; fragments: number; bricks: number; towers: number; trees: number; fences: number; resupply: number } {
    let intact = 0;
    for (const d of this.destructibles) if (d.state === 'intact') intact++;
    let towers = 0;
    for (const t of this.towers) if (t.state === 'intact') towers++;
    let trees = 0;
    for (const tr of this.trees) if (tr.state === 'intact') trees++;
    let fences = 0;
    for (const f of this.fences) if (f.state === 'intact') fences++;
    let resupply = 0;
    for (const rp of this.resupplyPoints) if (rp.state === 'intact') resupply++;
    return { intact, fragments: this.fragments.length, bricks: this.bricks.length, towers, trees, fences, resupply };
  }
}
