/**
 * convertLegacy.ts — 现有坦克(固定字段 schema)→ 部件组合式 TankModel 的等价转换器
 * ============================================================
 * 设计目标:把 T14/Tiger/Abrams 的视觉数据"全量精确"转为 TankModel.parts,
 * 保证 Phase B buildCustom(TankModel) 能 1:1 复现现有 buildT14/buildTiger/buildAbrams 的渲染。
 *
 * 转换对照基准:src/entities/TankVisualBuilder.ts 的 buildT14/buildTiger/buildAbrams
 *  + buildTrackAssembly(履带总成,三车型共用)。每个 part 的几何/位置/旋转/材质键/分段数/
 *  重复实例,均严格对照 Builder 实际创建 mesh 的代码,不增不减。
 *
 * 数据模型扩展(相对 docs/custom-tank-design.md §1,为保证零回归所必需,见 TankSchema 注释):
 *  - instances:负重轮组/格栅/afghanit 等"count 循环生成的重复 mesh" → 一个 part + instances 偏移数组
 *  - materialKey:partType(击中区域)与材质不完全对应时显式指定(如主动轮 partType=track 但用 trackMetal 材质)
 *  - segments:圆柱分段数(负重轮20/轮毂16/主动轮12或24/afghanit10...各不同,必须保留)
 *  - wedge.mode='glacis':车首斜板(三角楔)归入 wedge 元组件的 glacis 子模式(2024 重构,不再独立 shape)
 *  - mateTo:炮塔级/炮管级归属(值为父 part id)
 *
 * 层级约定:
 *  - root 级(mateTo 缺省):车体/履带/负重轮/挡泥板/侧裙/格栅等,随坦克根移动
 *  - 炮塔级(mateTo='turret'):炮塔主体(armata/body)及其附件 + 炮管部件(扁平化,炮管俯仰由 Phase C 实体处理)
 *  hullSway(T14 车身摇晃)是运行时视觉特效,不进数据,由 T14Tank 实体自管。
 *
 * 调用方:
 *  - Phase C 渲染切换:TankDataStore 加载 T14Data 后调 convertT14ToModel 转 TankModel,交 buildCustom
 *  - TankDataStore 兜底:convertXxxFromConfig 从 CONFIG + 内置 tankVisuals 组装(JSON 失败时用)
 *  - 编辑器"复制现有车型新建":convertXxxFromConfig 生成基线 TankModel 供用户改
 */
import type {
  AbramsData,
  Drive,
  MaterialKey,
  PartRole,
  PartType,
  T14Data,
  TankModel,
  TankPart,
  TigerData,
} from './TankSchema';
import { extractDriveFromTankConfig } from './modelOps';
import type { T14Visual } from './tankVisuals/t14';
import type { TigerVisual } from './tankVisuals/tiger';
import type { AbramsVisual } from './tankVisuals/abrams';
import { CONFIG } from '../config';

// ============================================================
// 公共类型与常量
// ============================================================

type Vec3 = { x: number; y: number; z: number };
type InstanceOffset = { dx: number; dy: number; dz: number };

/** π/2,圆柱侧放常用旋转(rotation.z 或 rotation.x = 此值)。 */
const HALF_PI = Math.PI / 2;

/** 部件构造公共参数(helper 共用)。 */
interface PartCommon {
  id: string;
  name: string;
  partType: PartType;
  position: Vec3;
  color: number;
  /** 材质键(覆盖 partType 默认推断)。 */
  materialKey?: MaterialKey;
  rotation?: Vec3;
  /** 归属父 part id(炮塔级='turret' 等)。缺省=root 级。 */
  mateTo?: string;
  /** 重复实例(逻辑组)。存在时按偏移生成多 mesh。 */
  instances?: InstanceOffset[];
  /** 运行时角色锚点(主炮塔/主炮管/左右履带)。转换器按 id 约定标(markRoles)。 */
  role?: PartRole;
}

// ============================================================
// 部件 helper(减少重复,集中字段组装)
// ============================================================

function box(p: PartCommon & { half: Vec3 }): TankPart {
  return {
    id: p.id,
    name: p.name,
    partType: p.partType,
    shape: 'box',
    half: p.half,
    position: p.position,
    color: p.color,
    materialKey: p.materialKey,
    rotation: p.rotation,
    mateTo: p.mateTo,
    instances: p.instances,
    role: p.role,
  };
}

function cyl(p: PartCommon & { radius: number; height: number; segments?: number }): TankPart {
  return {
    id: p.id,
    name: p.name,
    partType: p.partType,
    shape: 'cylinder',
    radius: p.radius,
    height: p.height,
    segments: p.segments,
    position: p.position,
    color: p.color,
    materialKey: p.materialKey,
    rotation: p.rotation,
    mateTo: p.mateTo,
    instances: p.instances,
    role: p.role,
  };
}

/** wedge 元组件(斜切体),按 mode 分 symmetric/asymmetric/glacis 三子模式。
 *  参数类型为 TankPart['wedge'] 联合,调用方传具体 mode 对象(TS 自动 narrow 字段)。
 *  对应工厂:symmetric→makeWedgeGeometry / asymmetric→makeWedgeTurretGeometry / glacis→makeGlacisGeometry。 */
function wedge(p: PartCommon & { wedge: NonNullable<TankPart['wedge']> }): TankPart {
  return {
    id: p.id,
    name: p.name,
    partType: p.partType,
    shape: 'wedge',
    wedge: p.wedge,
    position: p.position,
    color: p.color,
    materialKey: p.materialKey,
    rotation: p.rotation,
    mateTo: p.mateTo,
    instances: p.instances,
    role: p.role,
  };
}

// ============================================================
// 重复实例分布 helper(与 buildTrackAssembly 公式完全一致)
// ============================================================

/** 负重轮/托带轮 z 分布:count 个,均匀铺在 [-zSpan, +zSpan]。
 *  对照 buildTrackAssembly: wz = -zSpan + 2*zSpan*i/(count-1)。count=1 时居中(避免除零)。 */
function distributeZ(count: number, zSpan: number): InstanceOffset[] {
  return Array.from({ length: count }, (_, i) => ({
    dx: 0,
    dy: 0,
    dz: count === 1 ? 0 : -zSpan + (2 * zSpan * i) / (count - 1),
  }));
}

/** 主动轮两端 z 偏移:[-wheelZ, +wheelZ]。wheelZ = track.halfZ - track.halfY(履带直段半长)。 */
function sprocketZ(wheelZ: number): InstanceOffset[] {
  return [
    { dx: 0, dy: 0, dz: -wheelZ },
    { dx: 0, dy: 0, dz: +wheelZ },
  ];
}

/** 虎式交错轮 z 分布(内排轮偏移半距)。
 *  对照 buildTrackAssembly extras.stagger: sc=roadWheel.count-1; 循环 i∈[0,sc);
 *  wz = -st.zSpan + 2*st.zSpan*i/max(1,sc-1) + st.zSpan/roadWheel.count。 */
function staggerZ(roadWheelCount: number, zSpan: number): InstanceOffset[] {
  const sc = roadWheelCount - 1;
  return Array.from({ length: sc }, (_, i) => ({
    dx: 0,
    dy: 0,
    dz: -zSpan + (2 * zSpan * i) / Math.max(1, sc - 1) + zSpan / roadWheelCount,
  }));
}

/** afghanit 两侧×count 实例:每 i 对应 z,两侧各一。 */
function afghanitInstances(count: number, zSpan: number, offsetX: number): InstanceOffset[] {
  const out: InstanceOffset[] = [];
  for (let i = 0; i < count; i++) {
    const z = count === 1 ? 0 : -zSpan + (2 * zSpan * i) / (count - 1);
    out.push({ dx: -offsetX, dy: 0, dz: z });
    out.push({ dx: +offsetX, dy: 0, dz: z });
  }
  return out;
}

/** 按 id 约定标记 4 个必备 role(主炮塔/主炮管/左右履带)。
 *  三车型 id 约定一致:turret=炮塔主体 / barrel=主炮管 / track-l,track-r=左右履带。
 *  这是 buildCustom 识别运行时锚点的依据(替代旧 id 硬编码)。
 *  markRoles 集中处理,避免在每个 part 构造调用里散落 role 参数(DRY)。 */
function markRoles(parts: TankPart[]): TankPart[] {
  return parts.map((p) => {
    if (p.id === 'turret') return { ...p, role: 'turret-body' as const };
    if (p.id === 'barrel') return { ...p, role: 'main-barrel' as const };
    if (p.id === 'track-l') return { ...p, role: 'left-track' as const };
    if (p.id === 'track-r') return { ...p, role: 'right-track' as const };
    return p;
  });
}

// ============================================================
// 物理参数(转换器注入,非视觉)
// ============================================================

export interface PhysParams {
  mass: number;
  /** 静态展示坦克标志(虎式/M1=true)。解释 mass 语义,见 TankSchema TankModelSchema.isStatic。 */
  isStatic?: boolean;
  maxHp: number;
  damage?: TankModel['damage'];
  // —— P1 扩展:游戏物理/驾驶/冒烟(转换器写入,官方坦克零回归)——
  /** 整车碰撞体半尺寸。T14=CONFIG.tank.bodyHalf;静态从 hull+track 算。 */
  bodyHalf?: Vec3;
  /** 碰撞体偏移。静态坦克 y=hull.height;动态 undefined。 */
  colliderOffset?: Vec3;
  /** 炮塔物理体半尺寸(击毁炸飞用)。T14 玩家坦克不炸炮塔,undefined。 */
  turretHalf?: Vec3;
  /** 冒烟挂载点。T14={0,1.2,0};静态={0,1.0,0}。 */
  smokeOffset?: Vec3;
  /** 脱战回血(玩家坦克有,静态无)。 */
  regenDelay?: number;
  regenRate?: number;
  /** 驾驶手感。T14=extractDriveFromTankConfig();静态=其 + debugDrive 覆盖。 */
  drive?: Drive;
}

// ============================================================
// T-14 Armata 转换
// ============================================================

/**
 * T-14 视觉数据 → TankModel。全量精确(对照 buildT14 + buildTrackAssembly)。
 * 期望展开 mesh 数:63(不含 2 编号贴花;贴花在顶层 decal,由 buildCustom 复用 addNumberAndCrossDecals 生成)。
 */
export function convertT14ToModel(v: T14Data | T14Visual, phys: PhysParams): TankModel {
  const c = v.colors;
  const wheelZ = v.track.halfZ - v.track.halfY; // 履带直段半长(减两端轮区)

  // —— 发动机格栅(逻辑组 ×count)—— 派生参数对照 buildT14
  const eg = v.stowage.engineGrille;
  const barH = (eg.halfY * 2 * 0.7) / eg.count; // 单根横杆高
  const yStep = (eg.halfY * 2) / (eg.count - 1); // 杆间 y 步进

  // —— afghanit 实例(两侧 ×count)——
  const af = v.turret.afghanit;

  // —— 天线(倾斜圆柱,算旋转后几何中心位置)——
  // 对照 buildT14:antPivot 在 (baseX,baseY,baseZ) 绕 x 转 -tilt;cyl 在 pivot 局部 (0,length/2,0)。
  // 绕 x 转 θ=-tilt:y'=y*cosθ, z'=y*sinθ。cyl 中心世界位置 = pivot + (0, len/2*cos(tilt), -len/2*sin(tilt))。
  const ac = v.turret.antenna;
  const antHalf = ac.length / 2;
  const antPos: Vec3 = {
    x: ac.baseX,
    y: ac.baseY + antHalf * Math.cos(ac.tilt),
    z: ac.baseZ - antHalf * Math.sin(ac.tilt),
  };

  const rw = v.roadWheel;
  const wheelInst = distributeZ(rw.count, rw.zSpan);

  const parts: TankPart[] = [
    // ============ 车体级(root) ============
    // 车体楔形(对称)。Builder: addMesh(hullSway, makeWedgeGeometry(hull), hullMat)。centerY 在 geometry 内,part.position=原点。
    wedge({
      id: 'hull', name: '车体', partType: 'hull',
      wedge: {
        mode: 'symmetric',
        bottomHalfX: v.hull.bottomHalfX, topHalfX: v.hull.topHalfX,
        bottomHalfZ: v.hull.bottomHalfZ, topHalfZ: v.hull.topHalfZ,
        height: v.hull.height, centerY: v.hull.centerY,
      },
      position: { x: 0, y: 0, z: 0 },
      color: c.hull, materialKey: 'hull',
    }),

    // 驾驶员舱盖(cyl,沿 y 轴无旋转)。Builder: addCyl(hullSway, radius, height, hullMat, {x,y,z}, 16)。
    cyl({
      id: 'driver-hatch', name: '驾驶员舱盖', partType: 'hull',
      radius: v.stowage.driverHatch.radius, height: v.stowage.driverHatch.height, segments: 16,
      position: { x: v.stowage.driverHatch.x, y: v.stowage.driverHatch.y, z: v.stowage.driverHatch.z },
      color: c.hull, materialKey: 'hull',
    }),

    // 发动机格栅(count 根横杆,逻辑组)。Builder: 循环 addBox(hullSway, {halfX,barH/2,halfThick}, detailMat, {0, y-i*yStep, z})。
    box({
      id: 'engine-grille', name: '发动机格栅', partType: 'decorative',
      half: { x: eg.halfX, y: barH / 2, z: eg.halfThick },
      position: { x: 0, y: eg.y - eg.halfY, z: eg.z },
      color: c.detail, materialKey: 'detail',
      instances: Array.from({ length: eg.count }, (_, i) => ({ dx: 0, dy: i * yStep, dz: 0 })),
    }),

    // ============ 履带总成(左右对称) ============
    // 履带直段(box,带链节纹理→trackMetal 材质)。
    box({
      id: 'track-l', name: '左履带', partType: 'track',
      half: { x: v.track.halfX, y: v.track.halfY, z: wheelZ },
      position: { x: -v.track.offsetX, y: v.track.centerY, z: 0 },
      color: c.trackMetal, materialKey: 'trackMetal',
    }),
    box({
      id: 'track-r', name: '右履带', partType: 'track',
      half: { x: v.track.halfX, y: v.track.halfY, z: wheelZ },
      position: { x: +v.track.offsetX, y: v.track.centerY, z: 0 },
      color: c.trackMetal, materialKey: 'trackMetal',
    }),

    // 主动轮(每侧2,两端 z=±wheelZ)。T14 无齿→24 段、spR=halfY。
    cyl({
      id: 'sprocket-l', name: '左主动轮', partType: 'track',
      radius: v.track.halfY, height: v.track.halfX * 2, segments: 24,
      position: { x: -v.track.offsetX, y: v.track.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.trackMetal, materialKey: 'trackMetal',
      instances: sprocketZ(wheelZ),
    }),
    cyl({
      id: 'sprocket-r', name: '右主动轮', partType: 'track',
      radius: v.track.halfY, height: v.track.halfX * 2, segments: 24,
      position: { x: +v.track.offsetX, y: v.track.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.trackMetal, materialKey: 'trackMetal',
      instances: sprocketZ(wheelZ),
    }),

    // 负重轮(每侧 count 个)。Builder: CylinderGeometry(radius, radius, halfWidth*2, 20)。
    cyl({
      id: 'road-wheel-l', name: '左负重轮', partType: 'wheel',
      radius: rw.radius, height: rw.halfWidth * 2, segments: 20,
      position: { x: -rw.offsetX, y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: wheelInst,
    }),
    cyl({
      id: 'road-wheel-r', name: '右负重轮', partType: 'wheel',
      radius: rw.radius, height: rw.halfWidth * 2, segments: 20,
      position: { x: +rw.offsetX, y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: wheelInst,
    }),

    // 轮毂(每侧 count 个,在轮外侧 offsetX+halfWidth)。Builder: CylinderGeometry(radius*0.6, ..., halfWidth*1.2, 16)。
    cyl({
      id: 'wheel-hub-l', name: '左轮毂', partType: 'wheel',
      radius: rw.radius * 0.6, height: rw.halfWidth * 1.2, segments: 16,
      position: { x: -(rw.offsetX + rw.halfWidth), y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: wheelInst,
    }),
    cyl({
      id: 'wheel-hub-r', name: '右轮毂', partType: 'wheel',
      radius: rw.radius * 0.6, height: rw.halfWidth * 1.2, segments: 16,
      position: { x: +(rw.offsetX + rw.halfWidth), y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: wheelInst,
    }),

    // 挡泥板(每侧1)。partType=track(履带总成归属)但材质 fender。
    box({
      id: 'fender-l', name: '左挡泥板', partType: 'track',
      half: { x: v.fender.halfX, y: v.fender.halfY, z: v.fender.halfZ },
      position: { x: -v.fender.offsetX, y: v.fender.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),
    box({
      id: 'fender-r', name: '右挡泥板', partType: 'track',
      half: { x: v.fender.halfX, y: v.fender.halfY, z: v.fender.halfZ },
      position: { x: +v.fender.offsetX, y: v.fender.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),

    // ============ 炮塔级(mateTo='turret') ============
    // 炮塔主体 armata(对称楔形)。此 part id='turret',其他炮塔级 part mateTo 指向它。
    // Builder: turret group position=offset;armata geometry centerY=offsetY 内嵌。
    wedge({
      id: 'turret', name: '无人炮塔', partType: 'turret',
      wedge: {
        mode: 'symmetric',
        bottomHalfX: v.turret.armata.bottomHalfX, topHalfX: v.turret.armata.topHalfX,
        bottomHalfZ: v.turret.armata.bottomHalfZ, topHalfZ: v.turret.armata.topHalfZ,
        height: v.turret.armata.halfY * 2, centerY: v.turret.armata.offsetY,
      },
      position: { x: v.turret.offset.x, y: v.turret.offset.y, z: v.turret.offset.z },
      color: c.turret, materialKey: 'turret',
    }),

    // 车长瞄准镜(box,炮塔材质含迷彩)。
    box({
      id: 'sight-cmdr', name: '车长瞄准镜', partType: 'turret',
      half: v.turret.armata.sightCmdr.half,
      position: v.turret.armata.sightCmdr.offset,
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),
    // 炮手瞄准镜
    box({
      id: 'sight-gunner', name: '炮手瞄准镜', partType: 'turret',
      half: v.turret.armata.sightGunner.half,
      position: v.turret.armata.sightGunner.offset,
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),

    // 遥控机枪站底座(box,detail 材质)
    box({
      id: 'rcws', name: '遥控机枪站', partType: 'decorative',
      half: v.turret.armata.rcws.half,
      position: v.turret.armata.rcws.offset,
      color: c.detail, materialKey: 'detail', mateTo: 'turret',
    }),
    // 遥控机枪管(cyl,沿 +z)。Builder: addCyl(turret, barrelRadius, barrelLen, barrelMat, {offset + half.z + len/2}, 10).rotation.x=π/2。
    cyl({
      id: 'rcws-barrel', name: '遥控机枪管', partType: 'barrel',
      radius: v.turret.armata.rcws.barrelRadius, height: v.turret.armata.rcws.barrelLen, segments: 10,
      position: {
        x: v.turret.armata.rcws.offset.x,
        y: v.turret.armata.rcws.offset.y,
        z: v.turret.armata.rcws.offset.z + v.turret.armata.rcws.half.z + v.turret.armata.rcws.barrelLen / 2,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'turret',
    }),

    // 阿富汗石主动防御(两侧×count 发射管,逻辑组)。Builder: 循环 addCyl(turret, radius, height, detailMat, {±offsetX, offsetY, z}, 10).rotation.z=π/2。
    cyl({
      id: 'afghanit', name: '阿富汗石主动防御', partType: 'decorative',
      radius: af.radius, height: af.height, segments: 10,
      position: { x: 0, y: af.offsetY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.detail, materialKey: 'detail', mateTo: 'turret',
      instances: afghanitInstances(af.count, af.zSpan, af.offsetX),
    }),

    // 通讯天线(倾斜 cyl,见 antPos 推导)。
    cyl({
      id: 'antenna', name: '通讯天线', partType: 'decorative',
      radius: ac.radius, height: ac.length, segments: 8,
      position: antPos,
      rotation: { x: -ac.tilt, y: 0, z: 0 },
      color: c.detail, materialKey: 'detail', mateTo: 'turret',
    }),

    // ============ 炮管级(扁平化进炮塔,mateTo='turret';炮管俯仰由 Phase C 实体按 partType='barrel' 识别) ============
    // 主炮管(cyl)。T14 炮管半径硬编码 0.11(数据无此字段,保持与游戏一致)。位置含 barrel.offset(扁平化)。
    cyl({
      id: 'barrel', name: '主炮管', partType: 'barrel',
      radius: 0.11, height: v.barrel.length, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.length / 2,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),

    // 炮盾(cyl,根部加厚)。Builder: addCyl(barrel, radius, halfZ*2, mantletMat, {0,0,halfZ}, 20)。
    cyl({
      id: 'mantlet', name: '炮盾', partType: 'barrel',
      radius: v.barrel.mantlet.radius, height: v.barrel.mantlet.halfZ * 2, segments: 20,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.mantlet.halfZ,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.mantlet ?? c.barrel, materialKey: 'mantlet', mateTo: 'barrel',
    }),

    // 抽烟器(cyl,炮管中段)。Builder: addCyl(barrel, radius, length, barrelMat, {0,0,bLen*posRatio}, 18)。
    cyl({
      id: 'fume-extractor', name: '抽烟器', partType: 'barrel',
      radius: v.barrel.fumeExtractor.radius, height: v.barrel.fumeExtractor.length, segments: 18,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.length * v.barrel.fumeExtractor.posRatio,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),

    // 炮口装置(cyl,炮口端)。Builder: addCyl(barrel, radius, length, barrelMat, {0,0,bLen-length/2}, 16)。
    cyl({
      id: 'muzzle-device', name: '炮口装置', partType: 'barrel',
      radius: v.barrel.muzzleDevice.radius, height: v.barrel.muzzleDevice.length, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.length - v.barrel.muzzleDevice.length / 2,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),
  ];

  return {
    id: 't14',
    name: 'T-14 Armata',
    parts: markRoles(parts),
    mass: phys.mass,
    isStatic: phys.isStatic,
    maxHp: phys.maxHp,
    damage: {
      ...phys.damage,
      smokeOffset: phys.smokeOffset,
      regenDelay: phys.regenDelay,
      regenRate: phys.regenRate,
    },
    physics: phys.bodyHalf
      ? { bodyHalf: phys.bodyHalf, colliderOffset: phys.colliderOffset, turretHalf: phys.turretHalf }
      : undefined,
    materials: {
      hull: c.hull,
      turret: c.turret,
      trackMetal: c.trackMetal,
      wheelRubber: c.wheelRubber,
      wheelHub: c.wheelHub,
      barrel: c.barrel,
      mantlet: c.mantlet ?? c.barrel,
      detail: c.detail,
      fender: c.fender,
    },
    camo: c.camo,
    trackTexRepeat: v.track.texRepeat,
    decal: { number: c.number }, // T14 无黑十字
    drive: phys.drive,
  };
}

// ============================================================
// 虎式 Tiger I 转换
// ============================================================

/**
 * 虎式视觉数据 → TankModel。全量精确(对照 buildTiger + buildTrackAssembly with stagger+sideSkirt)。
 * 差异于 T14:车首斜板(glacis)/交错轮/侧裙板/非对称楔形炮塔/炮口制退器(无抽烟器与炮口装置)/黑十字贴花。
 */
export function convertTigerToModel(v: TigerData | TigerVisual, phys: PhysParams): TankModel {
  const c = v.colors;
  const wheelZ = v.track.halfZ - v.track.halfY;

  const rw = v.roadWheel;
  const wheelInst = distributeZ(rw.count, rw.zSpan);
  const stagger = v.roadWheelStagger;
  const staggerInst = staggerZ(rw.count, stagger.zSpan); // 交错轮数 = roadWheel.count - 1

  const parts: TankPart[] = [
    // ============ 车体级 ============
    // 车体(垂直方盒楔形,bottomHalfX=topHalfX)。Builder: addMesh(group, makeWedgeGeometry(hull), hullMat)。
    wedge({
      id: 'hull', name: '车体', partType: 'hull',
      wedge: {
        mode: 'symmetric',
        bottomHalfX: v.hull.bottomHalfX, topHalfX: v.hull.topHalfX,
        bottomHalfZ: v.hull.bottomHalfZ, topHalfZ: v.hull.topHalfZ,
        height: v.hull.height, centerY: v.hull.centerY,
      },
      position: { x: 0, y: 0, z: 0 },
      color: c.hull, materialKey: 'hull',
    }),

    // 车首下斜板(wedge glacis 子模式,三角楔)。Builder: addMesh(group, makeGlacisGeometry(halfX,halfDepth,halfHeight), hullMat).position(fs.x,y,z)。
    wedge({
      id: 'front-slope', name: '车首斜板', partType: 'hull',
      wedge: {
        mode: 'glacis',
        halfX: v.hull.frontSlope.halfX,
        halfDepth: v.hull.frontSlope.halfDepth,
        halfHeight: v.hull.frontSlope.halfHeight,
      },
      position: { x: v.hull.frontSlope.x, y: v.hull.frontSlope.y, z: v.hull.frontSlope.z },
      color: c.hull, materialKey: 'hull',
    }),

    // ============ 履带总成(含交错轮 + 侧裙)============
    // 履带直段
    box({
      id: 'track-l', name: '左履带', partType: 'track',
      half: { x: v.track.halfX, y: v.track.halfY, z: wheelZ },
      position: { x: -v.track.offsetX, y: v.track.centerY, z: 0 },
      color: c.trackMetal, materialKey: 'trackMetal',
    }),
    box({
      id: 'track-r', name: '右履带', partType: 'track',
      half: { x: v.track.halfX, y: v.track.halfY, z: wheelZ },
      position: { x: +v.track.offsetX, y: v.track.centerY, z: 0 },
      color: c.trackMetal, materialKey: 'trackMetal',
    }),

    // 主动轮(每侧2,无齿→24 段)
    cyl({
      id: 'sprocket-l', name: '左主动轮', partType: 'track',
      radius: v.track.halfY, height: v.track.halfX * 2, segments: 24,
      position: { x: -v.track.offsetX, y: v.track.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.trackMetal, materialKey: 'trackMetal',
      instances: sprocketZ(wheelZ),
    }),
    cyl({
      id: 'sprocket-r', name: '右主动轮', partType: 'track',
      radius: v.track.halfY, height: v.track.halfX * 2, segments: 24,
      position: { x: +v.track.offsetX, y: v.track.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.trackMetal, materialKey: 'trackMetal',
      instances: sprocketZ(wheelZ),
    }),

    // 负重轮(每侧 count=8)
    cyl({
      id: 'road-wheel-l', name: '左负重轮', partType: 'wheel',
      radius: rw.radius, height: rw.halfWidth * 2, segments: 20,
      position: { x: -rw.offsetX, y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: wheelInst,
    }),
    cyl({
      id: 'road-wheel-r', name: '右负重轮', partType: 'wheel',
      radius: rw.radius, height: rw.halfWidth * 2, segments: 20,
      position: { x: +rw.offsetX, y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: wheelInst,
    }),

    // 轮毂(每侧 count=8)
    cyl({
      id: 'wheel-hub-l', name: '左轮毂', partType: 'wheel',
      radius: rw.radius * 0.6, height: rw.halfWidth * 1.2, segments: 16,
      position: { x: -(rw.offsetX + rw.halfWidth), y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: wheelInst,
    }),
    cyl({
      id: 'wheel-hub-r', name: '右轮毂', partType: 'wheel',
      radius: rw.radius * 0.6, height: rw.halfWidth * 1.2, segments: 16,
      position: { x: +(rw.offsetX + rw.halfWidth), y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: wheelInst,
    }),

    // 交错负重轮(虎式标志,内排轮偏移半距,每侧 count-1=7 个)。Builder: CylinderGeometry(st.radius, ..., st.halfWidth*2, 18)。
    cyl({
      id: 'stagger-wheel-l', name: '左交错轮', partType: 'wheel',
      radius: stagger.radius, height: stagger.halfWidth * 2, segments: 18,
      position: { x: -stagger.offsetX, y: stagger.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: staggerInst,
    }),
    cyl({
      id: 'stagger-wheel-r', name: '右交错轮', partType: 'wheel',
      radius: stagger.radius, height: stagger.halfWidth * 2, segments: 18,
      position: { x: +stagger.offsetX, y: stagger.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: staggerInst,
    }),

    // 挡泥板(每侧1)
    box({
      id: 'fender-l', name: '左挡泥板', partType: 'track',
      half: { x: v.fender.halfX, y: v.fender.halfY, z: v.fender.halfZ },
      position: { x: -v.fender.offsetX, y: v.fender.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),
    box({
      id: 'fender-r', name: '右挡泥板', partType: 'track',
      half: { x: v.fender.halfX, y: v.fender.halfY, z: v.fender.halfZ },
      position: { x: +v.fender.offsetX, y: v.fender.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),

    // 侧裙板(每侧1,挡履带上半)。Builder: addBox(parent, {halfX,halfY,halfZ}, fenderMat, {±offsetX,centerY,0})。
    box({
      id: 'side-skirt-l', name: '左侧裙板', partType: 'track',
      half: { x: v.sideSkirt.halfX, y: v.sideSkirt.halfY, z: v.sideSkirt.halfZ },
      position: { x: -v.sideSkirt.offsetX, y: v.sideSkirt.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),
    box({
      id: 'side-skirt-r', name: '右侧裙板', partType: 'track',
      half: { x: v.sideSkirt.halfX, y: v.sideSkirt.halfY, z: v.sideSkirt.halfZ },
      position: { x: +v.sideSkirt.offsetX, y: v.sideSkirt.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),

    // ============ 炮塔级 ============
    // 炮塔主体(前后非对称楔形:frontHalfZ 厚/backHalfZ 薄)。Builder: makeWedgeTurretGeometry(body)。
    wedge({
      id: 'turret', name: '炮塔', partType: 'turret',
      wedge: {
        mode: 'asymmetric',
        bottomHalfX: v.turret.body.bottomHalfX, topHalfX: v.turret.body.topHalfX,
        bottomHalfZ: v.turret.body.bottomHalfZ,
        frontHalfZ: v.turret.body.frontHalfZ, backHalfZ: v.turret.body.backHalfZ,
        height: v.turret.body.height, centerY: v.turret.body.centerY,
      },
      position: { x: v.turret.offset.x, y: v.turret.offset.y, z: v.turret.offset.z },
      color: c.turret, materialKey: 'turret',
    }),

    // 车长指挥塔(cyl,炮塔顶)。Builder: addCyl(turret, radius, height, turretMat, {x,y,z}, 14)。
    cyl({
      id: 'cupola', name: '车长指挥塔', partType: 'turret',
      radius: v.turret.cupola.radius, height: v.turret.cupola.height, segments: 14,
      position: { x: v.turret.cupola.x, y: v.turret.cupola.y, z: v.turret.cupola.z },
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),

    // 战斗室加宽(尾部 bustle,box)
    box({
      id: 'bustle', name: '战斗室加宽', partType: 'turret',
      half: { x: v.turret.bustle.halfX, y: v.turret.bustle.halfY, z: v.turret.bustle.halfZ },
      position: { x: v.turret.bustle.x, y: v.turret.bustle.y, z: v.turret.bustle.z },
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),

    // 前脸防盾(box)
    box({
      id: 'front-shield', name: '前脸防盾', partType: 'turret',
      half: { x: v.turret.frontShield.halfX, y: v.turret.frontShield.halfY, z: v.turret.frontShield.halfZ },
      position: { x: v.turret.frontShield.x, y: v.turret.frontShield.y, z: v.turret.frontShield.z },
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),

    // ============ 炮管级 ============
    // 主炮管(88mm)。Builder: addCyl(barrel, data.barrel.radius, bLen, barrelMat, {0,0,bLen/2}).rotation.x=π/2。
    cyl({
      id: 'barrel', name: '88mm 主炮', partType: 'barrel',
      radius: v.barrel.radius, height: v.barrel.length, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.length / 2,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),

    // 炮盾(cyl,顶层 mantlet 字段)。虎式无独立 mantlet 色,用 barrel 色。Builder: addCyl(barrel, radius, halfZ*2, barrelMat, {0,0,halfZ})。
    cyl({
      id: 'mantlet', name: '炮盾', partType: 'barrel',
      radius: v.mantlet.radius, height: v.mantlet.halfZ * 2, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.mantlet.halfZ,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),

    // 炮口制退器(双室,cyl 在炮口外端)。Builder: addCyl(barrel, radius, length, barrelMat, {0,0,bLen+length/2}).rotation.x=π/2。
    cyl({
      id: 'muzzle-brake', name: '炮口制退器', partType: 'barrel',
      radius: v.muzzleBrake.radius, height: v.muzzleBrake.length, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.length + v.muzzleBrake.length / 2,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),
  ];

  return {
    id: 'tiger',
    name: '虎式 Tiger I',
    parts: markRoles(parts),
    mass: phys.mass,
    isStatic: phys.isStatic,
    maxHp: phys.maxHp,
    damage: {
      ...phys.damage,
      smokeOffset: phys.smokeOffset,
      // 静态坦克不回血,不设 regen(undefined)
    },
    physics: phys.bodyHalf
      ? { bodyHalf: phys.bodyHalf, colliderOffset: phys.colliderOffset, turretHalf: phys.turretHalf }
      : undefined,
    materials: {
      hull: c.hull,
      turret: c.turret,
      trackMetal: c.trackMetal,
      wheelRubber: c.wheelRubber,
      wheelHub: c.wheelHub,
      barrel: c.barrel,
      mantlet: c.barrel, // 虎式无 mantlet 色,用 barrel(与 Builder 一致)
      detail: c.detail,
      fender: c.fender,
    },
    camo: c.camo,
    trackTexRepeat: v.track.texRepeat,
    decal: { number: v.number, cross: v.decal.cross, crossColor: v.decal.crossColor },
    drive: phys.drive,
  };
}

// ============================================================
// M1 艾布拉姆斯转换
// ============================================================

/**
 * M1 视觉数据 → TankModel。全量精确(对照 buildAbrams + buildTrackAssembly with returnRoller+toothedSprocket+sideSkirt)。
 * 差异:驾驶舱凸起/托带轮/带齿主动轮(12 段 radius×1.12)/热护套(无制退器)/机枪站。
 */
export function convertAbramsToModel(v: AbramsData | AbramsVisual, phys: PhysParams): TankModel {
  const c = v.colors;
  const wheelZ = v.track.halfZ - v.track.halfY;

  const rw = v.roadWheel;
  const wheelInst = distributeZ(rw.count, rw.zSpan);
  const rr = v.returnRoller;
  const rollerInst = distributeZ(rr.count, rr.zSpan); // 托带轮按 count 均匀分布

  const parts: TankPart[] = [
    // ============ 车体级 ============
    // 车体(倾斜复合装甲楔形)
    wedge({
      id: 'hull', name: '车体', partType: 'hull',
      wedge: {
        mode: 'symmetric',
        bottomHalfX: v.hull.bottomHalfX, topHalfX: v.hull.topHalfX,
        bottomHalfZ: v.hull.bottomHalfZ, topHalfZ: v.hull.topHalfZ,
        height: v.hull.height, centerY: v.hull.centerY,
      },
      position: { x: 0, y: 0, z: 0 },
      color: c.hull, materialKey: 'hull',
    }),

    // 驾驶舱凸起(box)。Builder: addBox(group, frontHatch.half, hullMat, frontHatch.{x,y,z})。
    box({
      id: 'front-hatch', name: '驾驶舱凸起', partType: 'hull',
      half: { x: v.hull.frontHatch.halfX, y: v.hull.frontHatch.halfY, z: v.hull.frontHatch.halfZ },
      position: { x: v.hull.frontHatch.x, y: v.hull.frontHatch.y, z: v.hull.frontHatch.z },
      color: c.hull, materialKey: 'hull',
    }),

    // 车首下斜板(wedge glacis 子模式)
    wedge({
      id: 'front-slope', name: '车首斜板', partType: 'hull',
      wedge: {
        mode: 'glacis',
        halfX: v.hull.frontSlope.halfX,
        halfDepth: v.hull.frontSlope.halfDepth,
        halfHeight: v.hull.frontSlope.halfHeight,
      },
      position: { x: v.hull.frontSlope.x, y: v.hull.frontSlope.y, z: v.hull.frontSlope.z },
      color: c.hull, materialKey: 'hull',
    }),

    // ============ 履带总成(含托带轮 + 带齿主动轮 + 侧裙)============
    // 履带直段
    box({
      id: 'track-l', name: '左履带', partType: 'track',
      half: { x: v.track.halfX, y: v.track.halfY, z: wheelZ },
      position: { x: -v.track.offsetX, y: v.track.centerY, z: 0 },
      color: c.trackMetal, materialKey: 'trackMetal',
    }),
    box({
      id: 'track-r', name: '右履带', partType: 'track',
      half: { x: v.track.halfX, y: v.track.halfY, z: wheelZ },
      position: { x: +v.track.offsetX, y: v.track.centerY, z: 0 },
      color: c.trackMetal, materialKey: 'trackMetal',
    }),

    // 主动轮(M1 带齿 toothedSprocket=true → 12 段、radius=halfY*1.12)。Builder: spR=isDrive?halfY*1.12:halfY; seg=isDrive?12:24。
    cyl({
      id: 'sprocket-l', name: '左主动轮', partType: 'track',
      radius: v.track.halfY * 1.12, height: v.track.halfX * 2, segments: 12,
      position: { x: -v.track.offsetX, y: v.track.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.trackMetal, materialKey: 'trackMetal',
      instances: sprocketZ(wheelZ),
    }),
    cyl({
      id: 'sprocket-r', name: '右主动轮', partType: 'track',
      radius: v.track.halfY * 1.12, height: v.track.halfX * 2, segments: 12,
      position: { x: +v.track.offsetX, y: v.track.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.trackMetal, materialKey: 'trackMetal',
      instances: sprocketZ(wheelZ),
    }),

    // 托带轮(每侧 count=5,履带上方回程支撑轮)。Builder: addCyl(parent, rr.radius, rr.halfWidth*2, wheelHub, {±offsetX,centerY,wz}, 14).rotation.z=π/2。
    cyl({
      id: 'return-roller-l', name: '左托带轮', partType: 'wheel',
      radius: rr.radius, height: rr.halfWidth * 2, segments: 14,
      position: { x: -rr.offsetX, y: rr.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: rollerInst,
    }),
    cyl({
      id: 'return-roller-r', name: '右托带轮', partType: 'wheel',
      radius: rr.radius, height: rr.halfWidth * 2, segments: 14,
      position: { x: +rr.offsetX, y: rr.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: rollerInst,
    }),

    // 负重轮(每侧 count=7)
    cyl({
      id: 'road-wheel-l', name: '左负重轮', partType: 'wheel',
      radius: rw.radius, height: rw.halfWidth * 2, segments: 20,
      position: { x: -rw.offsetX, y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: wheelInst,
    }),
    cyl({
      id: 'road-wheel-r', name: '右负重轮', partType: 'wheel',
      radius: rw.radius, height: rw.halfWidth * 2, segments: 20,
      position: { x: +rw.offsetX, y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelRubber, materialKey: 'wheelRubber',
      instances: wheelInst,
    }),

    // 轮毂(每侧 count=7)
    cyl({
      id: 'wheel-hub-l', name: '左轮毂', partType: 'wheel',
      radius: rw.radius * 0.6, height: rw.halfWidth * 1.2, segments: 16,
      position: { x: -(rw.offsetX + rw.halfWidth), y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: wheelInst,
    }),
    cyl({
      id: 'wheel-hub-r', name: '右轮毂', partType: 'wheel',
      radius: rw.radius * 0.6, height: rw.halfWidth * 1.2, segments: 16,
      position: { x: +(rw.offsetX + rw.halfWidth), y: rw.centerY, z: 0 },
      rotation: { x: 0, y: 0, z: HALF_PI },
      color: c.wheelHub, materialKey: 'wheelHub',
      instances: wheelInst,
    }),

    // 挡泥板
    box({
      id: 'fender-l', name: '左挡泥板', partType: 'track',
      half: { x: v.fender.halfX, y: v.fender.halfY, z: v.fender.halfZ },
      position: { x: -v.fender.offsetX, y: v.fender.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),
    box({
      id: 'fender-r', name: '右挡泥板', partType: 'track',
      half: { x: v.fender.halfX, y: v.fender.halfY, z: v.fender.halfZ },
      position: { x: +v.fender.offsetX, y: v.fender.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),

    // 侧裙板
    box({
      id: 'side-skirt-l', name: '左侧裙板', partType: 'track',
      half: { x: v.sideSkirt.halfX, y: v.sideSkirt.halfY, z: v.sideSkirt.halfZ },
      position: { x: -v.sideSkirt.offsetX, y: v.sideSkirt.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),
    box({
      id: 'side-skirt-r', name: '右侧裙板', partType: 'track',
      half: { x: v.sideSkirt.halfX, y: v.sideSkirt.halfY, z: v.sideSkirt.halfZ },
      position: { x: +v.sideSkirt.offsetX, y: v.sideSkirt.centerY, z: 0 },
      color: c.fender, materialKey: 'fender',
    }),

    // ============ 炮塔级 ============
    // 炮塔主体(非对称楔形)
    wedge({
      id: 'turret', name: '炮塔', partType: 'turret',
      wedge: {
        mode: 'asymmetric',
        bottomHalfX: v.turret.body.bottomHalfX, topHalfX: v.turret.body.topHalfX,
        bottomHalfZ: v.turret.body.bottomHalfZ,
        frontHalfZ: v.turret.body.frontHalfZ, backHalfZ: v.turret.body.backHalfZ,
        height: v.turret.body.height, centerY: v.turret.body.centerY,
      },
      position: { x: v.turret.offset.x, y: v.turret.offset.y, z: v.turret.offset.z },
      color: c.turret, materialKey: 'turret',
    }),

    // 车长指挥塔(cyl)
    cyl({
      id: 'cupola', name: '车长指挥塔', partType: 'turret',
      radius: v.turret.cupola.radius, height: v.turret.cupola.height, segments: 14,
      position: { x: v.turret.cupola.x, y: v.turret.cupola.y, z: v.turret.cupola.z },
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),

    // 车长瞄准镜(box,detail 材质)
    box({
      id: 'sight', name: '车长瞄准镜', partType: 'decorative',
      half: { x: v.turret.sight.halfX, y: v.turret.sight.halfY, z: v.turret.sight.halfZ },
      position: { x: v.turret.sight.x, y: v.turret.sight.y, z: v.turret.sight.z },
      color: c.detail, materialKey: 'detail', mateTo: 'turret',
    }),

    // 装填手舱盖(cyl)
    cyl({
      id: 'loader-hatch', name: '装填手舱盖', partType: 'turret',
      radius: v.turret.loaderHatch.radius, height: v.turret.loaderHatch.height, segments: 14,
      position: { x: v.turret.loaderHatch.x, y: v.turret.loaderHatch.y, z: v.turret.loaderHatch.z },
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),

    // 尾部储物篮(box)
    box({
      id: 'bustle', name: '尾部储物篮', partType: 'turret',
      half: { x: v.turret.bustle.halfX, y: v.turret.bustle.halfY, z: v.turret.bustle.halfZ },
      position: { x: v.turret.bustle.x, y: v.turret.bustle.y, z: v.turret.bustle.z },
      color: c.turret, materialKey: 'turret', mateTo: 'turret',
    }),

    // 机枪站底座(box,detail 材质)
    box({
      id: 'mg-station', name: '车长机枪站', partType: 'decorative',
      half: v.turret.mgStation.baseHalf,
      position: v.turret.mgStation.base,
      color: c.detail, materialKey: 'detail', mateTo: 'turret',
    }),

    // 机枪管(cyl,沿 +z)。Builder: addCyl(turret, barrelRadius, barrelLen, barrelMat, {barrel + len/2}, 10).rotation.x=π/2。
    cyl({
      id: 'mg-barrel', name: '机枪管', partType: 'barrel',
      radius: v.turret.mgStation.barrelRadius, height: v.turret.mgStation.barrelLen, segments: 10,
      position: {
        x: v.turret.mgStation.barrel.x,
        y: v.turret.mgStation.barrel.y,
        z: v.turret.mgStation.barrel.z + v.turret.mgStation.barrelLen / 2,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'turret',
    }),

    // ============ 炮管级 ============
    // 主炮管(120mm 滑膛)
    cyl({
      id: 'barrel', name: 'M256 主炮', partType: 'barrel',
      radius: v.barrel.radius, height: v.barrel.length, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.length / 2,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),

    // 炮盾(cyl,顶层 mantlet)
    cyl({
      id: 'mantlet', name: '炮盾', partType: 'barrel',
      radius: v.mantlet.radius, height: v.mantlet.halfZ * 2, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.mantlet.halfZ,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),

    // 热护套(cyl,炮管中段分段加粗)。Builder: addCyl(barrel, radius, length, barrelMat, {0,0,bLen*posRatio}).rotation.x=π/2。
    cyl({
      id: 'thermal-sleeve', name: '热护套', partType: 'barrel',
      radius: v.thermalSleeve.radius, height: v.thermalSleeve.length, segments: 16,
      position: {
        x: v.barrel.offset.x,
        y: v.barrel.offset.y,
        z: v.barrel.offset.z + v.barrel.length * v.thermalSleeve.posRatio,
      },
      rotation: { x: HALF_PI, y: 0, z: 0 },
      color: c.barrel, materialKey: 'barrel', mateTo: 'barrel',
    }),
  ];

  return {
    id: 'abrams',
    name: 'M1 艾布拉姆斯',
    parts: markRoles(parts),
    mass: phys.mass,
    isStatic: phys.isStatic,
    maxHp: phys.maxHp,
    damage: {
      ...phys.damage,
      smokeOffset: phys.smokeOffset,
      // 静态坦克不回血,不设 regen(undefined)
    },
    physics: phys.bodyHalf
      ? { bodyHalf: phys.bodyHalf, colliderOffset: phys.colliderOffset, turretHalf: phys.turretHalf }
      : undefined,
    materials: {
      hull: c.hull,
      turret: c.turret,
      trackMetal: c.trackMetal,
      wheelRubber: c.wheelRubber,
      wheelHub: c.wheelHub,
      barrel: c.barrel,
      mantlet: c.barrel, // M1 无 mantlet 色,用 barrel
      detail: c.detail,
      fender: c.fender,
    },
    camo: c.camo,
    trackTexRepeat: v.track.texRepeat,
    decal: { number: v.number, cross: v.decal.cross, crossColor: v.decal.crossColor }, // M1 无十字
    drive: phys.drive,
  };
}

// ============================================================
// 便捷入口:从 CONFIG + 内置视觉数据组装(应用层,JSON 加载失败/编辑器复制时用)
// ============================================================
// 职责边界:以上 convertXxxToModel 是纯函数(visual data + phys → TankModel),无副作用可单测;
//          以下 convertXxxFromConfig 依赖 CONFIG(应用层聚合),负责把 CONFIG 中散布的视觉数据
//          (tankVisuals/*.ts)与物理参数(tank/staticTank)组装后调用纯转换函数。
// 注:convertLegacy → config → tankVisuals,无反向依赖,无循环。

/** T-14:视觉取 CONFIG.tank(已 spread t14 视觉),物理取 CONFIG.tank(mass + damage)。 */
export function convertT14FromConfig(): TankModel {
  const t = CONFIG.tank;
  return convertT14ToModel(t as T14Data, {
    mass: t.mass,
    maxHp: t.damage.maxHp,
    damage: {
      smokeThreshold: t.damage.smokeThreshold,
      destroyExplosionScale: t.damage.destroyExplosionScale,
      destroySmokeScale: t.damage.destroySmokeScale,
    },
    // T14 玩家坦克:碰撞体=CONFIG.tank.bodyHalf;冒烟={0,1.2,0};有脱战回血;驾驶=CONFIG.tank 提取
    bodyHalf: { x: t.bodyHalf.x, y: t.bodyHalf.y, z: t.bodyHalf.z },
    smokeOffset: { x: 0, y: 1.2, z: 0 },
    regenDelay: t.damage.regenDelay,
    regenRate: t.damage.regenRate,
    drive: extractDriveFromTankConfig(),
  });
}

/** 虎式:视觉取 CONFIG.staticTank.tiger(spread tigerVisual),物理取 staticTank 顶层。
 *  注:虎式/M1 是静态展示坦克,运行时 fixed(无限质量);mass 用 destroyedMass(击毁转 dynamic 后的附加质量)。 */
export function convertTigerFromConfig(): TankModel {
  const st = CONFIG.staticTank;
  const v = st.tiger as TigerData;
  const dd = st.tiger.debugDrive;
  return convertTigerToModel(v, {
    mass: st.destroyedMass,
    isStatic: true,
    maxHp: st.tiger.maxHp,
    damage: {
      smokeThreshold: st.smokeThreshold,
      destroyExplosionScale: st.destroyExplosionScale,
      destroySmokeScale: st.destroySmokeScale,
    },
    // 静态虎式:碰撞体从 hull+track 算(同 StaticTankBase.getSpec);炮塔体从 turret.body;冒烟={0,1,0}
    bodyHalf: { x: v.hull.topHalfX + v.track.halfX, y: v.hull.height, z: v.hull.bottomHalfZ },
    colliderOffset: { x: 0, y: v.hull.height, z: 0 },
    turretHalf: { x: v.turret.body.bottomHalfX, y: v.turret.body.height / 2, z: Math.max(v.turret.body.frontHalfZ, v.turret.body.backHalfZ) },
    smokeOffset: { x: 0, y: 1.0, z: 0 },
    // 静态驾驶:CONFIG.tank 基础手感 + debugDrive 覆盖 track/camera(适配更大车身)
    drive: {
      ...extractDriveFromTankConfig(),
      track: { offsetX: dd.trackOffsetX, halfZ: dd.trackHalfZ, rollScale: CONFIG.tank.track.rollScale },
      camera: { offset: dd.cameraOffset, lookOffset: dd.cameraLookOffset, lerp: CONFIG.tank.camera.lerp },
    },
  });
}

/** M1:同虎式。 */
export function convertAbramsFromConfig(): TankModel {
  const st = CONFIG.staticTank;
  const v = st.abrams as AbramsData;
  const dd = st.abrams.debugDrive;
  return convertAbramsToModel(v, {
    mass: st.destroyedMass,
    isStatic: true,
    maxHp: st.abrams.maxHp,
    damage: {
      smokeThreshold: st.smokeThreshold,
      destroyExplosionScale: st.destroyExplosionScale,
      destroySmokeScale: st.destroySmokeScale,
    },
    // 静态 M1:同虎式公式,数据取 abrams
    bodyHalf: { x: v.hull.topHalfX + v.track.halfX, y: v.hull.height, z: v.hull.bottomHalfZ },
    colliderOffset: { x: 0, y: v.hull.height, z: 0 },
    turretHalf: { x: v.turret.body.bottomHalfX, y: v.turret.body.height / 2, z: Math.max(v.turret.body.frontHalfZ, v.turret.body.backHalfZ) },
    smokeOffset: { x: 0, y: 1.0, z: 0 },
    drive: {
      ...extractDriveFromTankConfig(),
      track: { offsetX: dd.trackOffsetX, halfZ: dd.trackHalfZ, rollScale: CONFIG.tank.track.rollScale },
      camera: { offset: dd.cameraOffset, lookOffset: dd.cameraLookOffset, lerp: CONFIG.tank.camera.lerp },
    },
  });
}

// ============================================================
// 验证辅助(转换自检 + 调试用)
// ============================================================

/** 统计 TankModel 展开后的 mesh 总数(parts 求和 instances?.length ?? 1)。
 *  用于和 Builder 实际创建 mesh 数对照,验证转换无遗漏。
 *  期望值:T14=63 / 虎式=65 / M1=61(均不含贴花,贴花在顶层 decal,由 buildCustom 复用
 *  addNumberAndCrossDecals 生成)。核对依据:逐 part 数与 buildT14/buildTiger/buildAbrams 一致。 */
export function expandMeshCount(m: TankModel): number {
  return m.parts.reduce((sum, p) => sum + (p.instances?.length ?? 1), 0);
}

/** 打印 TankModel 部件清单(调试/核对用)。返回多行字符串,逐 part 显示
 *  id/name/partType/shape/材质键/实例数。 */
export function describeTankModel(m: TankModel): string {
  const lines: string[] = [];
  lines.push(`=== TankModel: ${m.name} (${m.id}) ===`);
  lines.push(`mass=${m.mass} maxHp=${m.maxHp} parts=${m.parts.length} meshes=${expandMeshCount(m)}`);
  lines.push(`camo: base=${m.materials.hull.toString(16)} style=${m.camo.style} wear=${m.camo.wear}`);
  if (m.decal) lines.push(`decal: number=${m.decal.number} cross=${m.decal.cross ?? false}`);
  lines.push('--- parts ---');
  for (const p of m.parts) {
    const n = p.instances?.length ?? 1;
    const parent = p.mateTo ?? 'root';
    lines.push(
      `  [${p.partType}/${p.shape}] ${p.id}(${p.name}) ` +
        `mat=${p.materialKey ?? '(by partType)'} parent=${parent} ×${n}`,
    );
  }
  return lines.join('\n');
}
