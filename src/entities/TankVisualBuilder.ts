/**
 * TankVisualBuilder.ts — 坦克几何构建的唯一真相源
 * ============================================================
 * 从视觉数据(TankData)构建 Three.js 几何模型。游戏和编辑器【共用此模块】,
 * 保证"编辑器所见 = 游戏所得"。
 *
 * 设计约束:
 *  - 纯几何:不依赖物理(RAPIER),只依赖 three.js + TankGeometryFactories
 *  - 数据驱动:所有尺寸/位置/颜色从 data 读,除 T14 炮管半径(历史硬编码 0.11,数据无此字段)外无硬编码
 *  - 资源跟踪:返回创建的 geometries/materials/textures,供调用方 dispose
 *    (编辑器 rebuild 时释放旧资源;游戏实体销毁时清理 GPU 资源)
 *
 * 调用方:
 *  - 游戏 T14Tank.buildVisuals:buildT14(data, { camoSeed: this.id })
 *  - 游戏 StaticTankBase.buildVisuals:buildTiger/buildAbrams(data, { camoSeed, camoOverride })
 *    (camoOverride 由 resolveTierCamo 算出,NPC 难度外观)
 *  - 编辑器:同上方法 + 用返回的 resources 在 rebuild 时 dispose
 *
 * tier(难度外观)处理边界:
 *  - 配色覆盖:Builder 接受 camoOverride 参数(覆盖基础配色),由调用方算好传入
 *  - 军衔贴花:不在 Builder 内(它是运行时装饰),由 StaticTankBase 在 Builder 之后追加
 *  这样 Builder 职责单一(纯数据→几何),tier 装饰是上层职责
 */
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  Texture,
} from 'three';
import {
  makeCamouflageCanvas,
  makeCrossDecalCanvas,
  makeGlacisGeometry,
  makeNumberDecalCanvas,
  makeTrackTexture,
  makeWedgeGeometry,
  makeWedgeTurretGeometry,
  type CamoParams,
} from './TankGeometryFactories';
import type { T14Data, TigerData, AbramsData } from '../data/TankSchema';

// ============================================================
// 类型定义
// ============================================================

/** 构建期间创建的资源(供调用方 dispose) */
export interface BuiltResources {
  geometries: BufferGeometry[];
  materials: Material[];
  textures: Texture[];
}

/** Builder 产出的视觉对象(对应 TankBase 需要的 TankVisuals) */
export interface BuiltVisuals {
  /** 坦克根 group(调用方加到场景或自己的 parent) */
  group: Group;
  /** 车身摇晃 group(仅 T14 有;Static 为 undefined) */
  hullSway?: Group;
  turret: Group;
  barrel: Group;
  muzzle: Object3D;
  leftTrackTex: CanvasTexture;
  rightTrackTex: CanvasTexture;
  barrelBaseZ: number;
  /** 创建的全部资源(dispose 用) */
  resources: BuiltResources;
}

/** 构建上下文 */
export interface BuildContext {
  /** 迷彩种子(游戏用 tank.id 让不同个体迷彩不同;编辑器用固定值如 1) */
  camoSeed: number;
  /** 可选配色覆盖(NPC tier 外观);undefined 用 data 原始 camo */
  camoOverride?: CamoParams;
}

// ============================================================
// 资源跟踪辅助(模块级,所有构建方法共用)
// ============================================================

/** 创建一个资源跟踪容器 */
function newResources(): BuiltResources {
  return { geometries: [], materials: [], textures: [] };
}

/** 创建 MeshStandardMaterial 并跟踪 */
function mat(
  res: BuiltResources,
  p: { color?: number; map?: Texture | null; roughness?: number; metalness?: number; transparent?: boolean; alphaTest?: number },
): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color: p.color ?? 0xffffff,
    map: p.map ?? null,
    roughness: p.roughness ?? 0.8,
    metalness: p.metalness ?? 0.1,
    transparent: p.transparent ?? false,
    alphaTest: p.alphaTest ?? 0,
  });
  res.materials.push(m);
  return m;
}

/** 创建 CanvasTexture 并跟踪 */
function tex(res: BuiltResources, canvas: HTMLCanvasElement, repeatS = 1, repeatT = 1): CanvasTexture {
  const t = new CanvasTexture(canvas);
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(repeatS, repeatT);
  t.anisotropy = 4;
  res.textures.push(t);
  return t;
}

/** 创建 BoxGeometry 的 Mesh,跟踪 geometry(material 由调用方传,已跟踪) */
function addBox(
  res: BuiltResources,
  parent: Object3D,
  half: { x: number; y: number; z: number },
  m: Material,
  pos?: { x: number; y: number; z: number },
): Mesh {
  const geo = new BoxGeometry(half.x * 2, half.y * 2, half.z * 2);
  res.geometries.push(geo);
  const mesh = new Mesh(geo, m);
  if (pos) mesh.position.set(pos.x, pos.y, pos.z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 创建 CylinderGeometry 的 Mesh,跟踪 geometry */
function addCyl(
  res: BuiltResources,
  parent: Object3D,
  radius: number,
  height: number,
  m: Material,
  pos?: { x: number; y: number; z: number },
  seg = 16,
): Mesh {
  const geo = new CylinderGeometry(radius, radius, height, seg);
  res.geometries.push(geo);
  const mesh = new Mesh(geo, m);
  if (pos) mesh.position.set(pos.x, pos.y, pos.z);
  mesh.castShadow = true;
  parent.add(mesh);
  return mesh;
}

/** 通用 Mesh 创建(自定义 geometry,如楔形车体) */
function addMesh(res: BuiltResources, parent: Object3D, geo: BufferGeometry, m: Material): Mesh {
  res.geometries.push(geo);
  const mesh = new Mesh(geo, m);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

// ============================================================
// 公共组件:履带总成(T14/虎式/M1 共用,差异用 extras 表达)
// ============================================================

/** 履带总成的可选附加件(车型差异) */
interface TrackExtras {
  /** 交错负重轮(虎式) */
  stagger?: { radius: number; halfWidth: number; offsetX: number; centerY: number; zSpan: number };
  /** 侧裙板(虎式/M1) */
  sideSkirt?: { halfX: number; halfY: number; halfZ: number; offsetX: number; centerY: number };
  /** 托带轮(M1) */
  returnRoller?: { radius: number; halfWidth: number; offsetX: number; centerY: number; count: number; zSpan: number };
  /** 主动轮带齿(M1) */
  toothedSprocket?: boolean;
}

/**
 * 构建单侧履带总成:履带板 + 主动轮 + 负重轮组 + 挡泥板(+ 可选交错轮/侧裙/托带轮)
 * 严格对照游戏代码 T14Tank.addTrack / StaticTankBase.buildTracks 的几何与位置。
 */
function buildTrackAssembly(
  res: BuiltResources,
  side: number,
  parent: Object3D,
  track: { halfX: number; halfY: number; halfZ: number; offsetX: number; centerY: number },
  roadWheel: { count: number; radius: number; halfWidth: number; offsetX: number; centerY: number; zSpan: number },
  fender: { halfX: number; halfY: number; halfZ: number; offsetX: number; centerY: number },
  wheelMats: { trackMetal: Material; wheelRubber: Material; wheelHub: Material; fender: Material },
  trackTex: CanvasTexture,
  extras?: TrackExtras,
): void {
  const x = side * track.offsetX;
  const wheelZ = track.halfZ - track.halfY;

  // 履带直段(带纹理)
  const trackGeo = new BoxGeometry(track.halfX * 2, track.halfY * 2, wheelZ * 2);
  const trackMat = mat(res, { map: trackTex, roughness: 0.95, metalness: 0.05 });
  const trackMesh = new Mesh(trackGeo, trackMat);
  trackMesh.position.set(x, track.centerY, 0);
  trackMesh.castShadow = true;
  trackMesh.receiveShadow = true;
  parent.add(trackMesh);
  res.geometries.push(trackGeo);

  // 主动轮(两端)
  const sprocketZs = [-wheelZ, wheelZ];
  for (const sz of sprocketZs) {
    const isDrive = sz > 0 && extras?.toothedSprocket;
    const spR = isDrive ? track.halfY * 1.12 : track.halfY;
    const spGeo = new CylinderGeometry(spR, spR, track.halfX * 2, isDrive ? 12 : 24);
    const sp = new Mesh(spGeo, wheelMats.trackMetal);
    sp.rotation.z = Math.PI / 2;
    sp.position.set(x, track.centerY, sz);
    sp.castShadow = true;
    sp.receiveShadow = true;
    parent.add(sp);
    res.geometries.push(spGeo);
  }

  // 托带轮(M1,履带上方回程支撑轮)
  if (extras?.returnRoller) {
    const rr = extras.returnRoller;
    for (let i = 0; i < rr.count; i++) {
      const wz = rr.count === 1 ? 0 : -rr.zSpan + (2 * rr.zSpan * i) / (rr.count - 1);
      addCyl(res, parent, rr.radius, rr.halfWidth * 2, wheelMats.wheelHub, { x: side * rr.offsetX, y: rr.centerY, z: wz }, 14)
        .rotation.z = Math.PI / 2;
    }
  }

  // 负重轮组
  const wheelGeo = new CylinderGeometry(roadWheel.radius, roadWheel.radius, roadWheel.halfWidth * 2, 20);
  const hubGeo = new CylinderGeometry(roadWheel.radius * 0.6, roadWheel.radius * 0.6, roadWheel.halfWidth * 1.2, 16);
  res.geometries.push(wheelGeo, hubGeo);
  for (let i = 0; i < roadWheel.count; i++) {
    const wz = -roadWheel.zSpan + (2 * roadWheel.zSpan * i) / (roadWheel.count - 1);
    const wheel = new Mesh(wheelGeo, wheelMats.wheelRubber);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(side * roadWheel.offsetX, roadWheel.centerY, wz);
    wheel.castShadow = true;
    parent.add(wheel);
    const hub = new Mesh(hubGeo, wheelMats.wheelHub);
    hub.rotation.z = Math.PI / 2;
    hub.position.set(side * (roadWheel.offsetX + roadWheel.halfWidth), roadWheel.centerY, wz);
    parent.add(hub);
  }

  // 交错负重轮(虎式:内排轮偏移半距)
  if (extras?.stagger) {
    const st = extras.stagger;
    const stGeo = new CylinderGeometry(st.radius, st.radius, st.halfWidth * 2, 18);
    res.geometries.push(stGeo);
    const sc = roadWheel.count - 1;
    for (let i = 0; i < sc; i++) {
      const wz = -st.zSpan + (2 * st.zSpan * i) / Math.max(1, sc - 1) + st.zSpan / roadWheel.count;
      const sw = new Mesh(stGeo, wheelMats.wheelRubber);
      sw.rotation.z = Math.PI / 2;
      sw.position.set(side * st.offsetX, st.centerY, wz);
      parent.add(sw);
    }
  }

  // 挡泥板
  addBox(res, parent, { x: fender.halfX, y: fender.halfY, z: fender.halfZ }, wheelMats.fender, { x: side * fender.offsetX, y: fender.centerY, z: 0 });

  // 侧裙板(虎式/M1)
  if (extras?.sideSkirt) {
    const sk = extras.sideSkirt;
    addBox(res, parent, { x: sk.halfX, y: sk.halfY, z: sk.halfZ }, wheelMats.fender, { x: side * sk.offsetX, y: sk.centerY, z: 0 });
  }
}

// ============================================================
// 公共组件:贴花(编号 + 黑十字)
// ============================================================

/**
 * 贴战术编号 + 可选黑十字贴花。
 * T14:编号贴炮塔前部(+z);虎式/M1:编号贴炮塔后部(-z),十字在前部(+z)。
 */
function addNumberAndCrossDecals(
  res: BuiltResources,
  turret: Group,
  variant: 't14' | 'static',
  turretBody: { bottomHalfX: number; centerY: number },
  number: string,
  decal?: { cross?: boolean; crossColor?: number },
): void {
  // 编号
  const numTex = tex(res, makeNumberDecalCanvas(number));
  const numMat = mat(res, { map: numTex, transparent: true, alphaTest: 0.5, roughness: 0.8 });
  const size = variant === 't14' ? 0.34 : 0.5;
  const decalGeo = new PlaneGeometry(size, size);
  res.geometries.push(decalGeo);
  const bx = turretBody.bottomHalfX + 0.02;
  const zDir = variant === 't14' ? 1 : -1;
  for (const side of [-1, 1]) {
    const d = new Mesh(decalGeo, numMat);
    d.position.set(side * bx, turretBody.centerY + 0.05, zDir * 0.2);
    d.rotation.y = side * Math.PI * 0.5;
    turret.add(d);
  }
  // 黑十字(虎式)
  if (decal?.cross) {
    const crossTex = tex(res, makeCrossDecalCanvas());
    const crossMat = mat(res, { map: crossTex, transparent: true, alphaTest: 0.5, roughness: 0.8 });
    const crossGeo = new PlaneGeometry(0.45, 0.45);
    res.geometries.push(crossGeo);
    for (const side of [-1, 1]) {
      const c = new Mesh(crossGeo, crossMat);
      c.position.set(side * bx, turretBody.centerY + 0.05, 0.4);
      c.rotation.y = side * Math.PI * 0.5;
      turret.add(c);
    }
  }
}

// ============================================================
// 公共组件:配色解析(基础 camo + 可选 tier 覆盖)
// ============================================================

/** 解析最终 camo 参数:有覆盖用覆盖,否则用 data 原始 */
function resolveCamo(base: CamoParams, override?: CamoParams): CamoParams {
  return override ?? base;
}

// ============================================================
// T-14 Armata 构建
// ============================================================

function buildT14(data: T14Data, ctx: BuildContext): BuiltVisuals {
  const res = newResources();
  const c = data.colors;
  const camo = resolveCamo(c.camo, ctx.camoOverride);

  // 迷彩纹理(车体 + 炮塔,用同一 canvas 不同 repeat)
  const camoCanvas = makeCamouflageCanvas(camo, { seed: ctx.camoSeed });
  const hullCamoTex = tex(res, camoCanvas, 3, 2);
  const turretCamoTex = tex(res, camoCanvas, 4, 1);

  // 材质集
  const hullMat = mat(res, { map: hullCamoTex, roughness: 0.88, metalness: 0.1 });
  const turretMat = mat(res, { map: turretCamoTex, roughness: 0.82, metalness: 0.1 });
  const trackMetalMat = mat(res, { color: c.trackMetal, roughness: 0.55, metalness: 0.5 });
  const wheelRubberMat = mat(res, { color: c.wheelRubber, roughness: 0.95, metalness: 0 });
  const wheelHubMat = mat(res, { color: c.wheelHub, roughness: 0.5, metalness: 0.6 });
  const barrelMat = mat(res, { color: c.barrel, roughness: 0.5, metalness: 0.6 });
  const mantletMat = mat(res, { color: c.mantlet ?? c.barrel, roughness: 0.55, metalness: 0.5 });
  const detailMat = mat(res, { color: c.detail, roughness: 0.6, metalness: 0.4 });
  const fenderMat = mat(res, { color: c.fender, roughness: 0.86, metalness: 0.1 });

  // group 结构:T14 有 hullSway(车身摇晃)+ trackGroup(履带独立)
  const group = new Group();
  const hullSway = new Group();
  const trackGroup = new Group();
  group.add(hullSway, trackGroup);

  // 车体(楔形)
  addMesh(res, hullSway, makeWedgeGeometry({
    bottomHalfX: data.hull.bottomHalfX, topHalfX: data.hull.topHalfX,
    bottomHalfZ: data.hull.bottomHalfZ, topHalfZ: data.hull.topHalfZ,
    height: data.hull.height, centerY: data.hull.centerY,
  }), hullMat);

  // 驾驶员舱盖
  const dh = data.stowage.driverHatch;
  addCyl(res, hullSway, dh.radius, dh.height, hullMat, { x: dh.x, y: dh.y, z: dh.z }, 16);

  // 发动机格栅(count 条横杆)
  const eg = data.stowage.engineGrille;
  const barH = (eg.halfY * 2 * 0.7) / eg.count;
  const yStep = (eg.halfY * 2) / (eg.count - 1);
  for (let i = 0; i < eg.count; i++) {
    addBox(res, hullSway, { x: eg.halfX, y: barH / 2, z: eg.halfThick }, detailMat, { x: 0, y: eg.y - eg.halfY + i * yStep, z: eg.z });
  }

  // 履带(左右)
  const leftTrackTex = makeTrackTexture(data.track.texRepeat);
  const rightTrackTex = makeTrackTexture(data.track.texRepeat);
  res.textures.push(leftTrackTex, rightTrackTex);
  const wheelMats = { trackMetal: trackMetalMat, wheelRubber: wheelRubberMat, wheelHub: wheelHubMat, fender: fenderMat };
  buildTrackAssembly(res, -1, trackGroup, data.track, data.roadWheel, data.fender, wheelMats, leftTrackTex);
  buildTrackAssembly(res, 1, trackGroup, data.track, data.roadWheel, data.fender, wheelMats, rightTrackTex);

  // 炮塔
  const turret = new Group();
  turret.position.set(data.turret.offset.x, data.turret.offset.y, data.turret.offset.z);
  const ar = data.turret.armata;
  addMesh(res, turret, makeWedgeGeometry({
    bottomHalfX: ar.bottomHalfX, topHalfX: ar.topHalfX,
    bottomHalfZ: ar.bottomHalfZ, topHalfZ: ar.topHalfZ,
    height: ar.halfY * 2, centerY: ar.offsetY,
  }), turretMat);

  // 瞄准镜 + 遥控机枪
  addBox(res, turret, ar.sightCmdr.half, turretMat, ar.sightCmdr.offset);
  addBox(res, turret, ar.sightGunner.half, turretMat, ar.sightGunner.offset);
  addBox(res, turret, ar.rcws.half, detailMat, ar.rcws.offset);
  const rcwsBarrel = addCyl(res, turret, ar.rcws.barrelRadius, ar.rcws.barrelLen, barrelMat, {
    x: ar.rcws.offset.x, y: ar.rcws.offset.y, z: ar.rcws.offset.z + ar.rcws.half.z + ar.rcws.barrelLen / 2,
  }, 10);
  rcwsBarrel.rotation.x = Math.PI / 2;

  // 阿富汗石主动防御发射管(两侧 × count)
  const af = data.turret.afghanit;
  for (let i = 0; i < af.count; i++) {
    const z = -af.zSpan + (2 * af.zSpan * i) / (af.count - 1);
    for (const s of [-1, 1]) {
      const tube = addCyl(res, turret, af.radius, af.height, detailMat, { x: s * af.offsetX, y: af.offsetY, z }, 10);
      tube.rotation.z = Math.PI / 2;
    }
  }

  // 天线
  const ac = data.turret.antenna;
  const antPivot = new Object3D();
  antPivot.position.set(ac.baseX, ac.baseY, ac.baseZ);
  antPivot.rotation.x = -ac.tilt;
  addCyl(res, antPivot, ac.radius, ac.length, detailMat, { x: 0, y: ac.length / 2, z: 0 }, 8);
  turret.add(antPivot);

  // 编号贴花(T14 在炮塔前部)
  addNumberAndCrossDecals(res, turret, 't14', { bottomHalfX: ar.bottomHalfX, centerY: ar.offsetY }, c.number);

  hullSway.add(turret);

  // 炮管
  const barrel = new Group();
  barrel.position.set(data.barrel.offset.x, data.barrel.offset.y, data.barrel.offset.z);
  const bLen = data.barrel.length;
  const bRad = 0.11; // T14 炮管半径(历史硬编码,数据无此字段;保持与游戏一致)
  const barrelMesh = addCyl(res, barrel, bRad, bLen, barrelMat, { x: 0, y: 0, z: bLen / 2 });
  barrelMesh.rotation.x = Math.PI / 2;

  // 炮盾
  const mn = data.barrel.mantlet;
  const mantlet = addCyl(res, barrel, mn.radius, mn.halfZ * 2, mantletMat, { x: 0, y: 0, z: mn.halfZ }, 20);
  mantlet.rotation.x = Math.PI / 2;

  // 抽烟器
  const fe = data.barrel.fumeExtractor;
  const feMesh = addCyl(res, barrel, fe.radius, fe.length, barrelMat, { x: 0, y: 0, z: bLen * fe.posRatio }, 18);
  feMesh.rotation.x = Math.PI / 2;

  // 炮口装置
  const md = data.barrel.muzzleDevice;
  const mdMesh = addCyl(res, barrel, md.radius, md.length, barrelMat, { x: 0, y: 0, z: bLen - md.length / 2 }, 16);
  mdMesh.rotation.x = Math.PI / 2;

  const muzzle = new Object3D();
  muzzle.position.set(0, 0, bLen);
  barrel.add(muzzle);
  turret.add(barrel);

  return {
    group, hullSway, turret, barrel, muzzle,
    leftTrackTex, rightTrackTex,
    barrelBaseZ: data.barrel.offset.z,
    resources: res,
  };
}

// ============================================================
// 虎式 Tiger I 构建
// ============================================================

function buildTiger(data: TigerData, ctx: BuildContext): BuiltVisuals {
  const res = newResources();
  const c = data.colors;
  const camo = resolveCamo(c.camo, ctx.camoOverride);

  const camoCanvas = makeCamouflageCanvas(camo, { seed: ctx.camoSeed });
  const hullCamoTex = tex(res, camoCanvas, 3, 2);
  const turretCamoTex = tex(res, camoCanvas, 4, 1);
  const hullMat = mat(res, { map: hullCamoTex, roughness: 0.88, metalness: 0.1 });
  const turretMat = mat(res, { map: turretCamoTex, roughness: 0.82, metalness: 0.1 });
  const trackMetalMat = mat(res, { color: c.trackMetal, roughness: 0.55, metalness: 0.5 });
  const wheelRubberMat = mat(res, { color: c.wheelRubber, roughness: 0.95, metalness: 0 });
  const wheelHubMat = mat(res, { color: c.wheelHub, roughness: 0.5, metalness: 0.6 });
  const barrelMat = mat(res, { color: c.barrel, roughness: 0.5, metalness: 0.6 });
  const fenderMat = mat(res, { color: c.fender, roughness: 0.86, metalness: 0.1 });

  const group = new Group();

  // 车体
  addMesh(res, group, makeWedgeGeometry({
    bottomHalfX: data.hull.bottomHalfX, topHalfX: data.hull.topHalfX,
    bottomHalfZ: data.hull.bottomHalfZ, topHalfZ: data.hull.topHalfZ,
    height: data.hull.height, centerY: data.hull.centerY,
  }), hullMat);

  // 车首斜板
  const fs = data.hull.frontSlope;
  const glacis = addMesh(res, group, makeGlacisGeometry(fs.halfX, fs.halfDepth, fs.halfHeight), hullMat);
  glacis.position.set(fs.x, fs.y, fs.z);

  // 履带(含交错轮 + 侧裙)
  const leftTrackTex = makeTrackTexture(data.track.texRepeat);
  const rightTrackTex = makeTrackTexture(data.track.texRepeat);
  res.textures.push(leftTrackTex, rightTrackTex);
  const wheelMats = { trackMetal: trackMetalMat, wheelRubber: wheelRubberMat, wheelHub: wheelHubMat, fender: fenderMat };
  buildTrackAssembly(res, -1, group, data.track, data.roadWheel, data.fender, wheelMats, leftTrackTex, {
    stagger: data.roadWheelStagger, sideSkirt: data.sideSkirt,
  });
  buildTrackAssembly(res, 1, group, data.track, data.roadWheel, data.fender, wheelMats, rightTrackTex, {
    stagger: data.roadWheelStagger, sideSkirt: data.sideSkirt,
  });

  // 炮塔(前后非对称楔形)
  const turret = new Group();
  turret.position.set(data.turret.offset.x, data.turret.offset.y, data.turret.offset.z);
  const tb = data.turret.body;
  const turretGeo = makeWedgeTurretGeometry({
    bottomHalfX: tb.bottomHalfX, topHalfX: tb.topHalfX,
    bottomHalfZ: tb.bottomHalfZ, frontHalfZ: tb.frontHalfZ, backHalfZ: tb.backHalfZ,
    height: tb.height, centerY: tb.centerY,
  });
  addMesh(res, turret, turretGeo, turretMat);

  // 指挥塔
  const cp = data.turret.cupola;
  addCyl(res, turret, cp.radius, cp.height, turretMat, { x: cp.x, y: cp.y, z: cp.z }, 14);
  // 战斗室加宽(尾部)
  const bs = data.turret.bustle;
  addBox(res, turret, { x: bs.halfX, y: bs.halfY, z: bs.halfZ }, turretMat, { x: bs.x, y: bs.y, z: bs.z });
  // 前脸防盾
  const fsh = data.turret.frontShield;
  addBox(res, turret, { x: fsh.halfX, y: fsh.halfY, z: fsh.halfZ }, turretMat, { x: fsh.x, y: fsh.y, z: fsh.z });

  // 编号 + 黑十字贴花
  addNumberAndCrossDecals(res, turret, 'static', { bottomHalfX: tb.bottomHalfX, centerY: tb.centerY }, data.number, data.decal);

  group.add(turret);

  // 炮管(88mm + 炮口制退器)
  const barrel = new Group();
  barrel.position.set(data.barrel.offset.x, data.barrel.offset.y, data.barrel.offset.z);
  const bLen = data.barrel.length;
  const barrelMesh = addCyl(res, barrel, data.barrel.radius, bLen, barrelMat, { x: 0, y: 0, z: bLen / 2 });
  barrelMesh.rotation.x = Math.PI / 2;

  // 炮盾
  const mn = data.mantlet;
  const mantlet = addCyl(res, barrel, mn.radius, mn.halfZ * 2, barrelMat, { x: 0, y: 0, z: mn.halfZ });
  mantlet.rotation.x = Math.PI / 2;

  // 炮口制退器
  const mb = data.muzzleBrake;
  const mbMesh = addCyl(res, barrel, mb.radius, mb.length, barrelMat, { x: 0, y: 0, z: bLen + mb.length / 2 });
  mbMesh.rotation.x = Math.PI / 2;

  const muzzle = new Object3D();
  muzzle.position.set(0, 0, bLen);
  barrel.add(muzzle);
  turret.add(barrel);

  return {
    group, turret, barrel, muzzle,
    leftTrackTex, rightTrackTex,
    barrelBaseZ: data.barrel.offset.z,
    resources: res,
  };
}

// ============================================================
// M1 艾布拉姆斯构建
// ============================================================

function buildAbrams(data: AbramsData, ctx: BuildContext): BuiltVisuals {
  const res = newResources();
  const c = data.colors;
  const camo = resolveCamo(c.camo, ctx.camoOverride);

  const camoCanvas = makeCamouflageCanvas(camo, { seed: ctx.camoSeed });
  const hullCamoTex = tex(res, camoCanvas, 3, 2);
  const turretCamoTex = tex(res, camoCanvas, 4, 1);
  const hullMat = mat(res, { map: hullCamoTex, roughness: 0.88, metalness: 0.1 });
  const turretMat = mat(res, { map: turretCamoTex, roughness: 0.82, metalness: 0.1 });
  const trackMetalMat = mat(res, { color: c.trackMetal, roughness: 0.55, metalness: 0.5 });
  const wheelRubberMat = mat(res, { color: c.wheelRubber, roughness: 0.95, metalness: 0 });
  const wheelHubMat = mat(res, { color: c.wheelHub, roughness: 0.5, metalness: 0.6 });
  const barrelMat = mat(res, { color: c.barrel, roughness: 0.5, metalness: 0.6 });
  const detailMat = mat(res, { color: c.detail, roughness: 0.6, metalness: 0.4 });
  const fenderMat = mat(res, { color: c.fender, roughness: 0.86, metalness: 0.1 });

  const group = new Group();
  const h = data.hull;

  // 车体
  addMesh(res, group, makeWedgeGeometry({
    bottomHalfX: h.bottomHalfX, topHalfX: h.topHalfX,
    bottomHalfZ: h.bottomHalfZ, topHalfZ: h.topHalfZ,
    height: h.height, centerY: h.centerY,
  }), hullMat);

  // 驾驶舱凸起
  const fh = h.frontHatch;
  addBox(res, group, { x: fh.halfX, y: fh.halfY, z: fh.halfZ }, hullMat, { x: fh.x, y: fh.y, z: fh.z });
  // 首下斜板
  const fs = h.frontSlope;
  const glacis = addMesh(res, group, makeGlacisGeometry(fs.halfX, fs.halfDepth, fs.halfHeight), hullMat);
  glacis.position.set(fs.x, fs.y, fs.z);

  // 履带(含托带轮 + 带齿主动轮 + 侧裙)
  const leftTrackTex = makeTrackTexture(data.track.texRepeat);
  const rightTrackTex = makeTrackTexture(data.track.texRepeat);
  res.textures.push(leftTrackTex, rightTrackTex);
  const wheelMats = { trackMetal: trackMetalMat, wheelRubber: wheelRubberMat, wheelHub: wheelHubMat, fender: fenderMat };
  buildTrackAssembly(res, -1, group, data.track, data.roadWheel, data.fender, wheelMats, leftTrackTex, {
    returnRoller: data.returnRoller, toothedSprocket: data.toothedSprocket, sideSkirt: data.sideSkirt,
  });
  buildTrackAssembly(res, 1, group, data.track, data.roadWheel, data.fender, wheelMats, rightTrackTex, {
    returnRoller: data.returnRoller, toothedSprocket: data.toothedSprocket, sideSkirt: data.sideSkirt,
  });

  // 炮塔(楔形)
  const turret = new Group();
  turret.position.set(data.turret.offset.x, data.turret.offset.y, data.turret.offset.z);
  const tb = data.turret.body;
  const turretGeo = makeWedgeTurretGeometry({
    bottomHalfX: tb.bottomHalfX, topHalfX: tb.topHalfX,
    bottomHalfZ: tb.bottomHalfZ, frontHalfZ: tb.frontHalfZ, backHalfZ: tb.backHalfZ,
    height: tb.height, centerY: tb.centerY,
  });
  addMesh(res, turret, turretGeo, turretMat);

  // 指挥塔
  const cp = data.turret.cupola;
  addCyl(res, turret, cp.radius, cp.height, turretMat, { x: cp.x, y: cp.y, z: cp.z }, 14);
  // 车长瞄准镜
  const sg = data.turret.sight;
  addBox(res, turret, { x: sg.halfX, y: sg.halfY, z: sg.halfZ }, detailMat, { x: sg.x, y: sg.y, z: sg.z });
  // 装填手舱盖
  const lh = data.turret.loaderHatch;
  addCyl(res, turret, lh.radius, lh.height, turretMat, { x: lh.x, y: lh.y, z: lh.z }, 14);
  // 尾部储物篮
  const bs = data.turret.bustle;
  addBox(res, turret, { x: bs.halfX, y: bs.halfY, z: bs.halfZ }, turretMat, { x: bs.x, y: bs.y, z: bs.z });
  // 机枪站
  const mg = data.turret.mgStation;
  addBox(res, turret, mg.baseHalf, detailMat, mg.base);
  const mgBarrel = addCyl(res, turret, mg.barrelRadius, mg.barrelLen, barrelMat, {
    x: mg.barrel.x, y: mg.barrel.y, z: mg.barrel.z + mg.barrelLen / 2,
  }, 10);
  mgBarrel.rotation.x = Math.PI / 2;

  // 编号贴花(M1 无十字)
  addNumberAndCrossDecals(res, turret, 'static', { bottomHalfX: tb.bottomHalfX, centerY: tb.centerY }, data.number, data.decal);

  group.add(turret);

  // 炮管(120mm + 热护套)
  const barrel = new Group();
  barrel.position.set(data.barrel.offset.x, data.barrel.offset.y, data.barrel.offset.z);
  const bLen = data.barrel.length;
  const barrelMesh = addCyl(res, barrel, data.barrel.radius, bLen, barrelMat, { x: 0, y: 0, z: bLen / 2 });
  barrelMesh.rotation.x = Math.PI / 2;

  // 炮盾
  const mn = data.mantlet;
  const mantlet = addCyl(res, barrel, mn.radius, mn.halfZ * 2, barrelMat, { x: 0, y: 0, z: mn.halfZ });
  mantlet.rotation.x = Math.PI / 2;

  // 热护套
  const ts = data.thermalSleeve;
  const tsMesh = addCyl(res, barrel, ts.radius, ts.length, barrelMat, { x: 0, y: 0, z: bLen * ts.posRatio });
  tsMesh.rotation.x = Math.PI / 2;

  const muzzle = new Object3D();
  muzzle.position.set(0, 0, bLen);
  barrel.add(muzzle);
  turret.add(barrel);

  return {
    group, turret, barrel, muzzle,
    leftTrackTex, rightTrackTex,
    barrelBaseZ: data.barrel.offset.z,
    resources: res,
  };
}

// ============================================================
// 对外 API
// ============================================================

export const TankVisualBuilder = {
  buildT14,
  buildTiger,
  buildAbrams,

  /**
   * 释放资源(编辑器 rebuild 时释放旧模型;游戏实体销毁时也可用)。
   * 注意:不会从场景移除 group(由调用方负责,因为 parent 归属调用方管理)。
   */
  dispose(resources: BuiltResources): void {
    for (const g of resources.geometries) g.dispose();
    for (const m of resources.materials) m.dispose();
    for (const t of resources.textures) t.dispose();
    resources.geometries = [];
    resources.materials = [];
    resources.textures = [];
  },
};
