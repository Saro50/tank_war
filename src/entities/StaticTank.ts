import RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  Texture,
} from 'three';
import { PhysicsWorld } from '../core/PhysicsWorld';
import { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';
import {
  makeCamouflageCanvas,
  makeNumberDecalCanvas,
  makeTrackTexture,
  makeWedgeGeometry,
  makeWedgeTurretGeometry,
} from './Tank';
import { CONFIG } from '../config';
import { Logger } from '../utils/Logger';

const log = Logger.create('StaticTank');

/** 可选细节配置(某型坦克没有则该字段为 undefined) */
type Maybe<T> = T | undefined;

/** 静态坦克配置(放宽字面量类型,使 tiger/abrams 可统一传入) */
type StaticTankConfig = {
  hull: {
    bottomHalfX: number; topHalfX: number; bottomHalfZ: number; topHalfZ: number; height: number; centerY: number;
    /** 车首驾驶舱凸起(M1 标志性前上装甲板上的驾驶舱) */
    frontHatch?: Maybe<{ halfX: number; halfY: number; halfZ: number; x: number; y: number; z: number }>;
  };
  track: { halfX: number; halfY: number; halfZ: number; offsetX: number; centerY: number; texRepeat: number };
  roadWheel: { count: number; radius: number; halfWidth: number; offsetX: number; centerY: number; zSpan: number };
  /** 托带轮(履带上方回程支撑轮,现代坦克标志,可选) */
  returnRoller?: Maybe<{ radius: number; halfWidth: number; offsetX: number; centerY: number; count: number; zSpan: number }>;
  /** 端轮差异化:true=前主动轮(带齿)后诱导轮(实心盘),false=前后同型 */
  toothedSprocket?: boolean;
  roadWheelStagger: Maybe<{ radius: number; halfWidth: number; offsetX: number; centerY: number; zSpan: number; zHalfStep: boolean }>;
  fender: { halfX: number; halfY: number; halfZ: number; offsetX: number; centerY: number };
  /** 侧裙板(履带侧面装甲板,可选,现代坦克标志) */
  sideSkirt?: Maybe<{ halfX: number; halfY: number; halfZ: number; offsetX: number; centerY: number }>;
  turret: {
    offset: { x: number; y: number; z: number };
    // body:对称楔形用 topHalfZ;若提供 frontHalfZ/backHalfZ 则用前后非对称楔形(正面厚、后部薄)
    body: {
      bottomHalfX: number; topHalfX: number;
      bottomHalfZ: number; topHalfZ: number;
      frontHalfZ?: number; backHalfZ?: number; // 非对称楔形(可选)
      height: number; centerY: number;
    };
    cupola: Maybe<{ radius: number; height: number; x: number; y: number; z: number }>;
    sight: Maybe<{ halfX: number; halfY: number; halfZ: number; x: number; y: number; z: number }>;
    loaderHatch: Maybe<{ radius: number; height: number; x: number; y: number; z: number }>;
    bustle: Maybe<{ halfX: number; halfY: number; halfZ: number; x: number; y: number; z: number }>;
    /** 炮塔前脸厚防盾块(虎式弧形防盾,加厚前脸避免平) */
    frontShield: Maybe<{ halfX: number; halfY: number; halfZ: number; x: number; y: number; z: number }>;
    /** 车长机枪站(底座+枪管,M1 等现代坦克炮塔顶标志) */
    mgStation?: Maybe<{ baseHalf: { x: number; y: number; z: number }; base: { x: number; y: number; z: number }; barrelRadius: number; barrelLen: number; barrel: { x: number; y: number; z: number } }>;
  };
  barrel: { offset: { x: number; y: number; z: number }; length: number; radius: number };
  muzzleBrake: Maybe<{ radius: number; length: number }>;
  thermalSleeve: Maybe<{ radius: number; length: number; posRatio: number }>;
  mantlet: Maybe<{ radius: number; halfZ: number }>;
  colors: { hull: number; turret: number; camo: { base: number; blobDark: number; blobMid: number }; trackMetal: number; wheelRubber: number; wheelHub: number; barrel: number; detail: number; fender: number };
  number: string;
  decal: { cross: boolean; crossColor: number };
  maxHp: number;
};

/**
 * 生成德军黑十字(Balkenkreuz)贴花画布。
 * 白边黑心十字,二战德军标志,贴炮塔两侧。
 */
function makeCrossDecalCanvas(size = 128): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const armW = size * 0.16; // 臂宽
  const armL = size * 0.42; // 臂长
  // 白边(外十字)
  ctx.fillStyle = '#e8e4d8';
  ctx.fillRect(cx - armW - 4, cx - armL, (armW + 4) * 2, armL * 2);
  ctx.fillRect(cx - armL, cx - armW - 4, armL * 2, (armW + 4) * 2);
  // 黑心(内十字)
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(cx - armW, cx - armL + 4, armW * 2, armL * 2 - 8);
  ctx.fillRect(cx - armL + 4, cx - armW, armL * 2 - 8, armW * 2);
  return cv;
}

/**
 * 静态展示坦克(可破坏目标)。
 * ------------------------------------------------------------
 * 复用玩家 Tank 的 4 个几何/纹理工厂,通过 config 参数化构建不同型号外形。
 * 细节:PBR 分级材质(漆面/金属/橡胶)、炮口制退器或热护套、炮塔指挥塔/瞄准镜/
 *       装填手舱盖/后突、交错负重轮(虎式)、十字/编号贴花。
 * 物理:fixed 刚体(静态障碍);接入 DestructionSystem.applyDamage。
 * 破坏:HP 机制,HP≤0 时整辆转 dynamic + 爆心方向冲量 → 被炸翻。
 */
export class StaticTank {
  readonly body: RAPIER.RigidBody;
  readonly colliderHandle: number;
  readonly group: Group;
  state: 'intact' | 'destroyed' = 'intact';
  private hp: number;
  /** 独有 GPU 资源(dispose 用) */
  private readonly geos: BufferGeometry[] = [];
  private readonly mats: MeshStandardMaterial[] = [];
  private readonly texs: (CanvasTexture | Texture)[] = [];
  /** 材质池(按名索引,供 buildTracks 等方法复用) */
  private mat!: Record<string, MeshStandardMaterial>;

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    spawn: { x: number; y: number; z: number },
    /** 朝向角(弧度,绕 y 轴)。0=面向 +z(炮管指 +z) */
    yaw: number,
    /** 'tiger' | 'abrams' */
    variant: 'tiger' | 'abrams',
  ) {
    const cfg: StaticTankConfig = CONFIG.staticTank[variant];
    this.hp = cfg.maxHp;
    const c = cfg.colors;

    // —— 物理车身(fixed 静态障碍) ——
    const hh = cfg.hull;
    const bodyDesc = RAPIER.RigidBodyDesc.fixed()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation({ x: 0, y: yaw, z: 0, w: 1 });
    this.body = physics.world.createRigidBody(bodyDesc);
    const col = physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(hh.topHalfX + cfg.track.halfX, hh.height, hh.bottomHalfZ)
        .setFriction(0.8)
        .setRestitution(0.0)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS),
      this.body,
    );
    this.colliderHandle = col.handle;

    // —— 迷彩纹理(anisotropy 提升斜角清晰度,复用 makeCamouflageCanvas) ——
    const camoCanvas = makeCamouflageCanvas({ base: c.camo.base, blobDark: c.camo.blobDark, blobMid: c.camo.blobMid });
    const hullTex = new CanvasTexture(camoCanvas);
    hullTex.wrapS = hullTex.wrapT = RepeatWrapping;
    hullTex.repeat.set(3, 2);
    hullTex.anisotropy = 4;
    this.texs.push(hullTex);
    const turretTex = new CanvasTexture(camoCanvas);
    turretTex.wrapS = turretTex.wrapT = RepeatWrapping;
    turretTex.repeat.set(4, 1);
    turretTex.anisotropy = 4;
    this.texs.push(turretTex);

    // —— PBR 分级材质(漆面哑光 / 金属高反射 / 橡胶全哑光 / 炮管金属) ——
    this.mat = {
      hull: new MeshStandardMaterial({ map: hullTex, color: 0xffffff, roughness: 0.88, metalness: 0.1 }),
      turret: new MeshStandardMaterial({ map: turretTex, color: 0xffffff, roughness: 0.82, metalness: 0.1 }),
      trackMetal: new MeshStandardMaterial({ color: c.trackMetal, roughness: 0.55, metalness: 0.5 }),
      wheelRubber: new MeshStandardMaterial({ color: c.wheelRubber, roughness: 0.95, metalness: 0.0 }),
      wheelHub: new MeshStandardMaterial({ color: c.wheelHub, roughness: 0.5, metalness: 0.6 }),
      barrel: new MeshStandardMaterial({ color: c.barrel, roughness: 0.5, metalness: 0.6 }),
      detail: new MeshStandardMaterial({ color: c.detail, roughness: 0.6, metalness: 0.4 }),
      fender: new MeshStandardMaterial({ color: c.fender, roughness: 0.86, metalness: 0.1 }),
    };
    const mat = this.mat;
    for (const m of Object.values(mat)) this.mats.push(m);

    this.group = new Group();

    // ===== 车体(楔形/方盒) =====
    const hullGeo = makeWedgeGeometry({
      bottomHalfX: cfg.hull.bottomHalfX, topHalfX: cfg.hull.topHalfX,
      bottomHalfZ: cfg.hull.bottomHalfZ, topHalfZ: cfg.hull.topHalfZ,
      height: cfg.hull.height, centerY: cfg.hull.centerY,
    });
    this.geos.push(hullGeo);
    const hullMesh = new Mesh(hullGeo, mat.hull);
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    this.group.add(hullMesh);

    // 车首驾驶舱凸起(M1 前上装甲板驾驶舱,标志性前凸)
    if (cfg.hull.frontHatch) {
      const fh = cfg.hull.frontHatch;
      const fgeo = new BoxGeometry(fh.halfX * 2, fh.halfY * 2, fh.halfZ * 2);
      this.geos.push(fgeo);
      const fmesh = new Mesh(fgeo, mat.hull);
      fmesh.position.set(fh.x, fh.y, fh.z);
      fmesh.castShadow = true;
      this.group.add(fmesh);
    }

    // ===== 履带 + 主动轮 + 负重轮 + 挡泥板(两侧) =====
    this.buildTracks(cfg, c);

    // ===== 炮塔 =====
    const turret = new Group();
    turret.position.set(cfg.turret.offset.x, cfg.turret.offset.y, cfg.turret.offset.z);
    const tb = cfg.turret.body;
    // 炮塔主体:提供 frontHalfZ/backHalfZ → 前后非对称楔形(正面厚后部薄);否则对称楔形
    const turretGeo = tb.frontHalfZ != null && tb.backHalfZ != null
      ? makeWedgeTurretGeometry({
          bottomHalfX: tb.bottomHalfX, topHalfX: tb.topHalfX,
          bottomHalfZ: tb.bottomHalfZ, frontHalfZ: tb.frontHalfZ, backHalfZ: tb.backHalfZ,
          height: tb.height, centerY: tb.centerY,
        })
      : makeWedgeGeometry({
          bottomHalfX: tb.bottomHalfX, topHalfX: tb.topHalfX,
          bottomHalfZ: tb.bottomHalfZ, topHalfZ: tb.topHalfZ,
          height: tb.height, centerY: tb.centerY,
        });
    this.geos.push(turretGeo);
    const turretMesh = new Mesh(turretGeo, mat.turret);
    turretMesh.castShadow = true;
    turretMesh.receiveShadow = true;
    turret.add(turretMesh);

    // 炮塔后部突出/储物篮(平衡长炮管配重,虎式战斗室后延 / M1 尾篮)
    this.addBustle(turret, cfg.turret.bustle, mat);

    // 前脸厚防盾块(虎式弧形防盾,加厚前脸避免平)
    this.addBustle(turret, cfg.turret.frontShield, mat);

    // 车长指挥塔(炮塔顶圆柱)
    this.addCupola(turret, cfg.turret.cupola, mat.turret);

    // 车长瞄准镜(现代坦克独立周视镜柱,M1)
    if (cfg.turret.sight) {
      const s = cfg.turret.sight;
      const sgeo = new BoxGeometry(s.halfX * 2, s.halfY * 2, s.halfZ * 2);
      this.geos.push(sgeo);
      const sight = new Mesh(sgeo, mat.detail);
      sight.position.set(s.x, s.y, s.z);
      sight.castShadow = true;
      turret.add(sight);
    }

    // 装填手舱盖(左侧不对称,M1 标志)
    if (cfg.turret.loaderHatch) {
      const lh = cfg.turret.loaderHatch;
      const lgeo = new CylinderGeometry(lh.radius, lh.radius, lh.height, 14);
      this.geos.push(lgeo);
      const hatch = new Mesh(lgeo, mat.turret);
      hatch.position.set(lh.x, lh.y, lh.z);
      hatch.castShadow = true;
      turret.add(hatch);
    }

    // 车长机枪站(底座+枪管,M1 等现代坦克炮塔顶标志)
    this.addMgStation(turret, cfg.turret.mgStation, mat);

    // ===== 炮管(含制退器/热护套/炮盾) =====
    const barrel = new Group();
    barrel.position.set(cfg.barrel.offset.x, cfg.barrel.offset.y, cfg.barrel.offset.z);

    // 主炮管
    const barrelGeo = new CylinderGeometry(cfg.barrel.radius, cfg.barrel.radius, cfg.barrel.length, 16);
    this.geos.push(barrelGeo);
    const barrelMesh = new Mesh(barrelGeo, mat.barrel);
    barrelMesh.rotation.x = Math.PI / 2;
    barrelMesh.position.z = cfg.barrel.length / 2;
    barrelMesh.castShadow = true;
    barrel.add(barrelMesh);

    // 炮盾(炮管根部加厚防盾)
    this.addMantlet(barrel, cfg.mantlet, mat.barrel);

    // 热护套(炮管中段加粗,M256 标志) 或 炮口制退器(88mm 标志),二选一
    this.addBarrelDetail(barrel, cfg, mat.barrel);

    turret.add(barrel);

    // ===== 贴花(编号 + 十字) =====
    this.addDecals(turret, cfg, tb);

    this.group.add(turret);
    render.scene.add(this.group);
    SyncBridge.bind(this.body, this.group);
    log.info('static tank built', { variant, at: spawn, yaw: yaw.toFixed(2) });
  }

  /** 炮塔附加 box 段(通用:后突/储物篮/前脸防盾,均用同色 box) */
  private addBustle(turret: Group, b: StaticTankConfig['turret']['bustle'], mat: Record<string, MeshStandardMaterial>): void {
    if (!b) return;
    const geo = new BoxGeometry(b.halfX * 2, b.halfY * 2, b.halfZ * 2);
    this.geos.push(geo);
    const mesh = new Mesh(geo, mat.turret);
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = true;
    turret.add(mesh);
  }

  /** 车长指挥塔 */
  private addCupola(turret: Group, cp: StaticTankConfig['turret']['cupola'], m: MeshStandardMaterial): void {
    if (!cp) return;
    const geo = new CylinderGeometry(cp.radius, cp.radius, cp.height, 14);
    this.geos.push(geo);
    const cupola = new Mesh(geo, m);
    cupola.position.set(cp.x, cp.y, cp.z);
    cupola.castShadow = true;
    turret.add(cupola);
  }

  /** 车长机枪站(底座 + 枪管,M1 等炮塔顶标志) */
  private addMgStation(
    turret: Group,
    mg: StaticTankConfig['turret']['mgStation'],
    mat: Record<string, MeshStandardMaterial>,
  ): void {
    if (!mg) return;
    // 底座
    const baseGeo = new BoxGeometry(mg.baseHalf.x * 2, mg.baseHalf.y * 2, mg.baseHalf.z * 2);
    this.geos.push(baseGeo);
    const base = new Mesh(baseGeo, mat.detail);
    base.position.set(mg.base.x, mg.base.y, mg.base.z);
    base.castShadow = true;
    turret.add(base);
    // 枪管(圆柱沿 +z)
    const bGeo = new CylinderGeometry(mg.barrelRadius, mg.barrelRadius, mg.barrelLen, 10);
    this.geos.push(bGeo);
    const barrel = new Mesh(bGeo, mat.barrel);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(mg.barrel.x, mg.barrel.y, mg.barrel.z + mg.barrelLen / 2);
    barrel.castShadow = true;
    turret.add(barrel);
  }

  /** 炮盾(炮管根部加厚) */
  private addMantlet(barrel: Group, mn: StaticTankConfig['mantlet'], m: MeshStandardMaterial): void {
    if (!mn) return;
    const geo = new CylinderGeometry(mn.radius, mn.radius, mn.halfZ * 2, 20);
    this.geos.push(geo);
    const mesh = new Mesh(geo, m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = mn.halfZ;
    mesh.castShadow = true;
    barrel.add(mesh);
  }

  /**
   * 炮管末端细节:
   *  - 有 muzzleBrake → 炮口制退器(88mm 双室,虎式标志)
   *  - 有 thermalSleeve → 热护套(中段分段加粗,M256 标志)
   *  二者互斥(虎式用制退器,M1 用热护套)。
   */
  private addBarrelDetail(barrel: Group, cfg: StaticTankConfig, m: MeshStandardMaterial): void {
    if (cfg.muzzleBrake) {
      const mb = cfg.muzzleBrake;
      const geo = new CylinderGeometry(mb.radius, mb.radius, mb.length, 16);
      this.geos.push(geo);
      const mesh = new Mesh(geo, m);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = cfg.barrel.length + mb.length / 2;
      mesh.castShadow = true;
      barrel.add(mesh);
    } else if (cfg.thermalSleeve) {
      const ts = cfg.thermalSleeve;
      const geo = new CylinderGeometry(ts.radius, ts.radius, ts.length, 16);
      this.geos.push(geo);
      const mesh = new Mesh(geo, m);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = cfg.barrel.length * ts.posRatio;
      mesh.castShadow = true;
      barrel.add(mesh);
    }
  }

  /** 贴花:炮塔两侧战术编号 + (虎式)德军黑十字 */
  private addDecals(
    turret: Group,
    cfg: StaticTankConfig,
    tb: StaticTankConfig['turret']['body'],
  ): void {
    // 战术编号(两侧)
    const numTex = new CanvasTexture(makeNumberDecalCanvas(cfg.number));
    numTex.anisotropy = 4;
    this.texs.push(numTex);
    const numMat = new MeshStandardMaterial({ map: numTex, transparent: true, alphaTest: 0.5, depthWrite: false, roughness: 0.8 });
    this.mats.push(numMat);
    const decalGeo = new PlaneGeometry(0.5, 0.5);
    this.geos.push(decalGeo);
    for (const side of [-1, 1]) {
      const decal = new Mesh(decalGeo, numMat);
      decal.position.set(side * (tb.bottomHalfX + 0.02), tb.centerY + 0.05, -0.2);
      decal.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      turret.add(decal);
    }

    // 德军黑十字(虎式专属,贴炮塔后部两侧)
    if (cfg.decal.cross) {
      const crossTex = new CanvasTexture(makeCrossDecalCanvas());
      crossTex.anisotropy = 4;
      this.texs.push(crossTex);
      const crossMat = new MeshStandardMaterial({ map: crossTex, transparent: true, alphaTest: 0.5, depthWrite: false, roughness: 0.8 });
      this.mats.push(crossMat);
      const crossGeo = new PlaneGeometry(0.45, 0.45);
      this.geos.push(crossGeo);
      for (const side of [-1, 1]) {
        const cross = new Mesh(crossGeo, crossMat);
        cross.position.set(side * (tb.bottomHalfX + 0.02), tb.centerY + 0.05, 0.4);
        cross.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        turret.add(cross);
      }
    }
  }

  /** 构建两侧履带 + 主动轮 + 负重轮(含交错轮)+ 挡泥板 */
  private buildTracks(
    cfg: StaticTankConfig,
    c: StaticTankConfig['colors'],
  ): void {
    const mat = this.mat;
    const tr = cfg.track;
    const rw = cfg.roadWheel;
    const straightLen = (tr.halfZ - tr.halfY) * 2;
    const straightGeo = new BoxGeometry(tr.halfX, tr.halfY * 2, straightLen);
    this.geos.push(straightGeo);
    // 履带上方回程段(扁平薄段,模拟闭环履带的上半圈)
    const returnGeo = new BoxGeometry(tr.halfX * 0.9, tr.halfY * 0.6, straightLen);
    this.geos.push(returnGeo);
    const sprocketGeo = new CylinderGeometry(tr.halfY, tr.halfY, tr.halfX * 2, 24);
    this.geos.push(sprocketGeo);
    // 主动轮带齿(分段多+略大半径,粗糙近似齿形);诱导轮实心盘(标准圆柱)
    const toothedSprocketGeo = new CylinderGeometry(tr.halfY * 1.12, tr.halfY * 1.12, tr.halfX * 2, 12);
    this.geos.push(toothedSprocketGeo);
    const wheelGeo = new CylinderGeometry(rw.radius, rw.radius, rw.halfWidth * 2, 20);
    this.geos.push(wheelGeo);
    const hubGeo = new CylinderGeometry(rw.radius * 0.6, rw.radius * 0.6, rw.halfWidth * 1.2, 16);
    this.geos.push(hubGeo);
    // 交错内排轮(虎式)
    const stagger = cfg.roadWheelStagger;
    let staggerGeo: CylinderGeometry | null = null;
    if (stagger) {
      staggerGeo = new CylinderGeometry(stagger.radius, stagger.radius, stagger.halfWidth * 2, 18);
      this.geos.push(staggerGeo);
    }

    // 负重轮 z 均匀分布(外排)
    const wheelZs: number[] = [];
    for (let i = 0; i < rw.count; i++) {
      wheelZs.push(-rw.zSpan + (2 * rw.zSpan * i) / (rw.count - 1));
    }

    for (const side of [-1, 1]) {
      // 履带纹路(每侧独有 CanvasTexture)
      const trackTex = makeTrackTexture(tr.texRepeat);
      trackTex.wrapS = trackTex.wrapT = RepeatWrapping;
      this.texs.push(trackTex);
      const trackMat = new MeshStandardMaterial({ color: c.trackMetal, map: trackTex, roughness: 0.9, metalness: 0.3 });
      this.mats.push(trackMat);

      // 下直段(接地,链节纹理)
      const track = new Mesh(straightGeo, trackMat);
      track.position.set(side * tr.offsetX, tr.centerY, 0);
      track.castShadow = true;
      track.receiveShadow = true;
      this.group.add(track);

      // 上回程段(闭环履带的上半圈,扁平薄段,绕过端轮)
      const returnTrack = new Mesh(returnGeo, trackMat);
      returnTrack.position.set(side * tr.offsetX, tr.centerY + tr.halfY * 1.4, 0);
      returnTrack.castShadow = true;
      this.group.add(returnTrack);

      // 前后端轮:前端主动轮(带齿)、后端诱导轮(实心盘),无差异化配置则前后同型实心
      for (const z of [-tr.halfZ + tr.halfY, tr.halfZ - tr.halfY]) {
        const isDrive = z > 0 && cfg.toothedSprocket; // +z 前端=主动轮(带齿)
        const sprocket = new Mesh(isDrive ? toothedSprocketGeo : sprocketGeo, mat.trackMetal);
        sprocket.rotation.z = Math.PI / 2;
        sprocket.position.set(side * tr.offsetX, tr.centerY, z);
        sprocket.castShadow = true;
        this.group.add(sprocket);
      }

      // 托带轮(履带上方回程支撑轮,M1 标志,均匀分布支撑上回程段)
      const rr = cfg.returnRoller;
      if (rr) {
        const rrGeo = new CylinderGeometry(rr.radius, rr.radius, rr.halfWidth * 2, 14);
        this.geos.push(rrGeo);
        for (let i = 0; i < rr.count; i++) {
          const wz = rr.count === 1 ? 0 : -rr.zSpan + (2 * rr.zSpan * i) / (rr.count - 1);
          const rmesh = new Mesh(rrGeo, mat.wheelHub);
          rmesh.rotation.z = Math.PI / 2;
          rmesh.position.set(side * rr.offsetX, rr.centerY, wz);
          rmesh.castShadow = true;
          this.group.add(rmesh);
        }
      }

      // 外排负重轮(橡胶外圈 + 金属轮毂)
      for (const wz of wheelZs) {
        const wheel = new Mesh(wheelGeo, mat.wheelRubber);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * rw.offsetX, rw.centerY, wz);
        wheel.castShadow = true;
        this.group.add(wheel);
        const hub = new Mesh(hubGeo, mat.wheelHub);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(side * (rw.offsetX + rw.halfWidth), rw.centerY, wz);
        this.group.add(hub);
      }

      // 内排交错轮(虎式:偏移半步,藏在履带内侧)
      if (stagger && staggerGeo) {
        const sCount = rw.count - 1;
        for (let i = 0; i < sCount; i++) {
          const wz = -stagger.zSpan + (2 * stagger.zSpan * i) / Math.max(1, sCount - 1) + stagger.zSpan / (rw.count);
          const wheel = new Mesh(staggerGeo, mat.wheelRubber);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(side * stagger.offsetX, stagger.centerY, wz);
          wheel.castShadow = true;
          this.group.add(wheel);
        }
      }

      // 挡泥板
      const fg = cfg.fender;
      const fenderGeo = new BoxGeometry(fg.halfX * 2, fg.halfY * 2, fg.halfZ * 2);
      this.geos.push(fenderGeo);
      const fender = new Mesh(fenderGeo, mat.fender);
      fender.position.set(side * fg.offsetX, fg.centerY, 0);
      fender.castShadow = true;
      fender.receiveShadow = true;
      this.group.add(fender);

      // 侧裙板(履带侧面整块装甲板,M1/现代坦克标志,遮住上排轮)
      const sk = cfg.sideSkirt;
      if (sk) {
        const skGeo = new BoxGeometry(sk.halfX * 2, sk.halfY * 2, sk.halfZ * 2);
        this.geos.push(skGeo);
        const skirt = new Mesh(skGeo, mat.fender);
        skirt.position.set(side * sk.offsetX, sk.centerY, 0);
        skirt.castShadow = true;
        skirt.receiveShadow = true;
        this.group.add(skirt);
      }
    }
  }

  /** 受击(由 DestructionSystem.applyDamage 调用,与炮击/撞击统一) */
  takeHit(epicenter: { x: number; y: number; z: number }, damage: number): void {
    if (this.state !== 'intact') return;
    this.hp -= damage;
    log.debug('static tank hit', { hp: this.hp.toFixed(1), damage: damage.toFixed(1) });
    if (this.hp <= 0) this.destroy(epicenter);
  }

  /** 击毁:fixed→dynamic,沿爆心方向爆炸冲量把坦克掀翻 */
  private destroy(epicenter: { x: number; y: number; z: number }): void {
    this.state = 'destroyed';
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    const t = this.body.translation();
    const dx = t.x - epicenter.x;
    const dz = t.z - epicenter.z;
    const d = Math.hypot(dx, dz) || 1;
    const imp = CONFIG.staticTank.destroyImpulse;
    this.body.applyImpulse(
      { x: (dx / d) * imp, y: imp * 0.8, z: (dz / d) * imp },
      true,
    );
    this.body.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 4, z: (Math.random() - 0.5) * 8 },
      true,
    );
    log.info('static tank DESTROYED', { at: t });
  }

  /** 彻底销毁(场景重置用) */
  dispose(physics: PhysicsWorld, render: RenderScene): void {
    SyncBridge.unbind(this.body);
    physics.world.removeRigidBody(this.body);
    render.scene.remove(this.group);
    for (const t of this.texs) t.dispose();
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}
