/**
 * TankSchema.ts — 坦克视觉数据的 schema 定义(zod)
 * ============================================================
 * 这是【游戏对编辑器产物的契约】:声明每种车型 JSON 必须包含的字段、类型、范围。
 *
 * 三方共用(单一真相源):
 *  - TankDataStore:加载 JSON 时 validate,非法数据进不来(失败明确报错 + 回退兜底)
 *  - 编辑器:实时校验,调参时即知是否合法(红色提示出错字段)
 *  - TS 类型:由 z.infer 推导,数据/类型/验证三者同源(DRY,无需手写 interface)
 *
 * 设计:
 *  - 每车型独立 schema(精确描述结构,错误信息准确:"T14 缺少 armata" 而非泛泛的缺字段)
 *  - 公共子 schema(hull/track/colors 等)组合复用,避免三份重复
 *  - 几何尺寸用 .positive()(防 0/负值导致 BufferGeometry 异常)
 *  - count 用 .int().min(1)(防 0 个负重轮导致除零/空循环)
 *  - 可选部件(车型差异,如 tiger 的 muzzleBrake / abrams 的 thermalSleeve)用 .optional()
 */
import { z } from 'zod';

// ============================================================
// 公共原子(复用于三个车型,避免重复定义)
// ============================================================

/** 任意数值(含负,如 centerY/offset 可能 < 0) */
const num = z.number();
/** 正数(几何尺寸,防 0/负导致 BufferGeometry 异常)。
 *  导出:元组件注册表(META_SHAPES)的参数 schema 复用,DRY。 */
export const pos = z.number().positive();
/** 正整数(count/texRepeat/segments 等,防 0 导致空循环或除零)。
 *  导出:同 pos,注册表复用。 */
export const intPos = z.number().int().min(1);
/** 任意数值(布尔语义字段单独用 z.boolean) */
/** 三维向量(偏移量) */
const vec3 = z.object({ x: num, y: num, z: num });
/** 半尺寸盒子 {x,y,z 全正}。
 *  导出:注册表 box 元组件参数 schema 复用。 */
export const halfBox = z.object({ x: pos, y: pos, z: pos });

// ============================================================
// 公共组件 schema(多车型共用的结构)
// ============================================================

/** 迷彩参数(配色子结构) */
const CamoSchema = z.object({
  base: num,
  blobDark: num,
  blobMid: num,
  /** 迷彩样式枚举(与 TankGeometryFactories.makeCamouflageCanvas 支持的样式对齐) */
  style: z.enum(['nato-blotch', 'stripe', 'splatter', 'two-tone', 'legacy']),
  /** 磨损度 0~1 */
  wear: num.min(0).max(1),
});

/**
 * 配色板
 * ------------------------------------------------------------
 * 注意:T-14 的 number 在 colors 下(历史结构),虎式/M1 的 number 在顶层。
 * 这里 ColorsSchema 不含 number(适配虎式/M1);T-14 schema 在 colors 上 extend number。
 * 此不一致待 B 阶段 TankVisualBuilder 重构时统一到顶层。
 *
 * mantlet 仅 T-14 用(虎式/M1 的炮盾用 barrel 色代替);设 optional 统一 schema。
 */
const ColorsSchema = z.object({
  hull: num,
  turret: num,
  camo: CamoSchema,
  trackMetal: num,
  wheelRubber: num,
  wheelHub: num,
  barrel: num,
  /** 仅 T-14 有;虎式/M1 缺省时 Builder 回退用 barrel 色 */
  mantlet: num.optional(),
  detail: num,
  fender: num,
});

/** 楔形车体基础结构(三车型共用) */
const HullBaseSchema = z.object({
  bottomHalfX: pos,
  topHalfX: pos,
  bottomHalfZ: pos,
  topHalfZ: pos,
  height: pos,
  centerY: num,
});

/** 履带基础(三车型共用;t14 额外有 rollScale,在各车型 schema 里 extend) */
const TrackBaseSchema = z.object({
  halfX: pos,
  halfY: pos,
  halfZ: pos,
  offsetX: pos,
  centerY: num,
  texRepeat: intPos,
});

/** 负重轮组(三车型共用) */
const RoadWheelSchema = z.object({
  count: intPos,
  radius: pos,
  halfWidth: pos,
  offsetX: pos,
  centerY: num,
  zSpan: pos,
});

/** 挡泥板(三车型共用) */
const FenderSchema = z.object({
  halfX: pos,
  halfY: pos,
  halfZ: pos,
  offsetX: pos,
  centerY: num,
});

/** 炮盾(炮管根部加厚块,三车型都有) */
const MantletSchema = z.object({
  radius: pos,
  halfZ: pos,
});

/** 侧裙板(虎式/M1 有,T-14 无) */
const SideSkirtSchema = z.object({
  halfX: pos,
  halfY: pos,
  halfZ: pos,
  offsetX: pos,
  centerY: num,
});

/** 车首斜板(虎式/M1 有,T-14 无) */
const FrontSlopeSchema = z.object({
  halfX: pos,
  halfDepth: pos,
  halfHeight: pos,
  x: num,
  y: num,
  z: num,
});

// ============================================================
// T-14 Armata schema(玩家型,无人炮塔)
// ============================================================

export const T14Schema = z.object({
  hull: HullBaseSchema,

  /** T-14 履带多了 rollScale(履带纹理滚动系数,玩家驾驶用) */
  track: TrackBaseSchema.extend({ rollScale: num }),

  roadWheel: RoadWheelSchema,
  fender: FenderSchema,

  /** T-14 无人炮塔:Armata 楔形主体 + 传感器 + 遥控机枪 + 主动防御 + 天线 */
  turret: z.object({
    offset: vec3,
    armata: z.object({
      bottomHalfX: pos,
      topHalfX: pos,
      bottomHalfZ: pos,
      topHalfZ: pos,
      halfY: pos,
      offsetY: num,
      sightCmdr: z.object({ half: halfBox, offset: vec3 }),
      sightGunner: z.object({ half: halfBox, offset: vec3 }),
      rcws: z.object({
        half: halfBox,
        offset: vec3,
        barrelLen: pos,
        barrelRadius: pos,
      }),
    }),
    /** "阿富汗石"主动防御发射管 */
    afghanit: z.object({
      radius: pos,
      height: pos,
      count: intPos,
      offsetX: pos,
      zSpan: pos,
      offsetY: num,
    }),
    /** 通讯天线 */
    antenna: z.object({
      radius: pos,
      length: pos,
      baseX: num,
      baseY: num,
      baseZ: num,
      tilt: num,
    }),
  }),

  /** T-14 炮管:炮盾 + 抽烟器 + 炮口装置(无人炮塔专属配置) */
  barrel: z.object({
    offset: vec3,
    length: pos,
    mantlet: MantletSchema,
    fumeExtractor: z.object({ radius: pos, length: pos, posRatio: num }),
    muzzleDevice: z.object({ radius: pos, length: pos }),
  }),

  /** 车体附件:发动机格栅 + 驾驶员舱盖(T-14 独有) */
  stowage: z.object({
    engineGrille: z.object({
      count: intPos,
      halfX: pos,
      halfY: pos,
      halfThick: pos,
      z: num,
      y: num,
    }),
    driverHatch: z.object({
      radius: pos,
      height: pos,
      x: num,
      z: num,
      y: num,
    }),
  }),

  /** T-14 战术编号在 colors 下(历史结构);重构时统一到顶层 */
  colors: ColorsSchema.extend({ number: z.string().min(1, '战术编号不能为空') }),
});

// ============================================================
// 虎式 Tiger I schema(二战重型,交错负重轮)
// ============================================================

export const TigerSchema = z.object({
  /** 虎式车体含车首斜板 */
  hull: HullBaseSchema.extend({
    frontSlope: FrontSlopeSchema,
  }),

  track: TrackBaseSchema,
  roadWheel: RoadWheelSchema,

  /** 虎式标志:交错式负重轮(内排轮偏移半距) */
  roadWheelStagger: z.object({
    radius: pos,
    halfWidth: pos,
    offsetX: pos,
    centerY: num,
    zSpan: pos,
    /** 半距偏移开关(数据里有,当前渲染未读;保留兼容) */
    zHalfStep: z.boolean().optional(),
  }),

  fender: FenderSchema,
  sideSkirt: SideSkirtSchema,

  /** 虎式炮塔:前后非对称楔形 + 指挥塔 + 战斗室加宽 + 前脸防盾 */
  turret: z.object({
    offset: vec3,
    body: z.object({
      bottomHalfX: pos,
      topHalfX: pos,
      bottomHalfZ: pos,
      topHalfZ: pos,
      frontHalfZ: pos,
      backHalfZ: pos,
      height: pos,
      centerY: num,
    }),
    cupola: z.object({ radius: pos, height: pos, x: num, y: num, z: num }),
    bustle: z.object({ halfX: pos, halfY: pos, halfZ: pos, x: num, y: num, z: num }),
    frontShield: z.object({ halfX: pos, halfY: pos, halfZ: pos, x: num, y: num, z: num }),
  }),

  /** 88mm 炮 + 炮口制退器 */
  barrel: z.object({
    offset: vec3,
    length: pos,
    radius: pos,
  }),
  muzzleBrake: z.object({ radius: pos, length: pos }),
  mantlet: MantletSchema,

  colors: ColorsSchema,
  number: z.string().min(1),

  /** 德军黑十字贴花 */
  decal: z.object({
    cross: z.boolean(),
    crossColor: num,
  }),
});

// ============================================================
// M1 艾布拉姆斯 schema(现代主战,楔形炮塔+托带轮)
// ============================================================

export const AbramsSchema = z.object({
  /** M1 车体:驾驶舱凸起 + 首下斜板 */
  hull: HullBaseSchema.extend({
    frontHatch: z.object({ halfX: pos, halfY: pos, halfZ: pos, x: num, y: num, z: num }),
    frontSlope: FrontSlopeSchema,
  }),

  track: TrackBaseSchema,
  roadWheel: RoadWheelSchema,

  /** 托带轮(履带上方回程支撑轮,M1 标志) */
  returnRoller: z.object({
    radius: pos,
    halfWidth: pos,
    offsetX: pos,
    centerY: num,
    count: intPos,
    zSpan: pos,
  }),
  /** 前主动轮带齿(布尔,M1 标志) */
  toothedSprocket: z.boolean(),

  fender: FenderSchema,
  sideSkirt: SideSkirtSchema,

  /** M1 炮塔:楔形 + 车长镜 + 装填手舱盖 + 储物篮 + 机枪站 */
  turret: z.object({
    offset: vec3,
    body: z.object({
      bottomHalfX: pos,
      topHalfX: pos,
      bottomHalfZ: pos,
      topHalfZ: pos,
      frontHalfZ: pos,
      backHalfZ: pos,
      height: pos,
      centerY: num,
    }),
    cupola: z.object({ radius: pos, height: pos, x: num, y: num, z: num }),
    sight: z.object({ halfX: pos, halfY: pos, halfZ: pos, x: num, y: num, z: num }),
    loaderHatch: z.object({ radius: pos, height: pos, x: num, y: num, z: num }),
    bustle: z.object({ halfX: pos, halfY: pos, halfZ: pos, x: num, y: num, z: num }),
    /** 12.7mm 车长机枪站 */
    mgStation: z.object({
      baseHalf: halfBox,
      base: vec3,
      barrelRadius: pos,
      barrelLen: pos,
      barrel: vec3,
    }),
  }),

  /** M256 120mm 滑膛炮 + 热护套 */
  barrel: z.object({
    offset: vec3,
    length: pos,
    radius: pos,
  }),
  thermalSleeve: z.object({ radius: pos, length: pos, posRatio: num }),
  mantlet: MantletSchema,

  colors: ColorsSchema,
  number: z.string().min(1),

  /** 战术编号贴花(无十字,美军风格) */
  decal: z.object({
    cross: z.boolean(),
    crossColor: num,
  }),
});

// ============================================================
// 类型推导(z.infer,无需手写 interface)
// ============================================================

export type T14Data = z.infer<typeof T14Schema>;
export type TigerData = z.infer<typeof TigerSchema>;
export type AbramsData = z.infer<typeof AbramsSchema>;

// ============================================================
// variant 注册表(加载器/编辑器按名查 schema)
// ============================================================

/** 支持的车型标识(联合类型,全代码共用) */
export const TANK_VARIANTS = ['t14', 'tiger', 'abrams'] as const;
export type TankVariant = (typeof TANK_VARIANTS)[number];

/** 车型中文名(编辑器/HUD 显示用) */
export const TANK_VARIANT_LABELS: Record<TankVariant, string> = {
  t14: 'T-14 Armata',
  tiger: '虎式 Tiger I',
  abrams: 'M1 艾布拉姆斯',
};

/** variant → schema 映射(加载器按 variant 名查对应 schema 验证) */
export const TankSchemaByVariant: Record<TankVariant, z.ZodType> = {
  t14: T14Schema,
  tiger: TigerSchema,
  abrams: AbramsSchema,
};

/** 任意车型的数据(联合类型;加载后按 variant 收窄) */
export type TankData = T14Data | TigerData | AbramsData;

// ============================================================
// 部件组合式数据模型(Phase A:自定义坦克基座)
// ============================================================
// 设计背景:见 docs/custom-tank-design.md。
// 上方 T14Schema/TigerSchema/AbramsSchema 是"每车型一套固定字段",
// 本区块定义统一的"部件列表组合式" TankModel,所有车型(含未来用户自定义)共用一套。
// 现有 3 车型通过 src/data/convertLegacy.ts 等价转换为本模型(视觉零回归)。
//
// 相对文档 §1 的扩展(为保证"全量精确零回归"所必需,已确认):
//  1. TankPart.instances   —— "逻辑组"语义。现有 Builder 有大量 count 循环生成的
//     重复 mesh(负重轮组/格栅/afghanit...)。一个 part 携带 instances 偏移数组,
//     buildCustom 遍历时共享几何/材质生成多个 mesh,避免把 N 个相同轮子拆成 N 个 part。
//  2. TankPart.materialKey —— 材质键。partType 决定"击中区域",但与"用哪种材质"不完全
//     对应(主动轮 partType=track 却用 trackMetal 材质;挡泥板 partType=track 却用 fender 材质)。
//     缺省按 partType 推断,materialKey 显式覆盖,保证零回归。
//  3. TankPart.segments    —— 圆柱分段数。现有圆柱分段各异(负重轮20/轮毂16/主动轮12或24/
//     afghanit10...),不存则圆滑度不一致,破坏零回归。缺省 16(与 Builder addCyl 默认一致)。
//  4. TankModel.materials + camo —— 材质定义上移到顶层(用户确认)。part.color 仍存原始色
//     用于编辑器拾色/显示;实际渲染材质由顶层 materials(各键色值)+ camo(迷彩纹理参数)+
//     partType/materialKey(查 PBR 预设,预设表在 Phase B buildCustom 内固定)决定。
//  5. TankModel.decal          —— 整车级贴花(战术编号/黑十字),用 PlaneGeometry,不属于几何 part。
//  6. TankModel.trackTexRepeat —— 履带链节纹理重复数(每车型不同:T14=6/虎=12/M1=13)。
//  7. wedge schema 超集        —— 同时支持对称(topHalfZ)与非对称(frontHalfZ+backHalfZ)楔形。
//
// 关于层级(hullSway/turret/barrel 等运行时 group):
//  TankModel.parts 是扁平列表,通过 mateTo(值为父 part id)表达归属。
//  - root 级:mateTo 缺省(车体/履带/负重轮等,随坦克根移动)
//  - 炮塔级:mateTo='turret'(炮塔主体 part 的 id,随炮塔旋转)
//  - 炮管级:扁平化进炮塔级(mateTo='turret'),炮管俯仰由 Phase C 游戏实体按 partType='barrel' 识别处理
//  hullSway(车身摇晃,T14 专属)是运行时视觉特效,不进数据模型,由 T14Tank 实体自管。
// ============================================================

/** 部位类型 —— 兼顾"击中区域(战斗集成)"与"材质推断默认键"。
 *  击中语义见文档 §1.3;材质推断规则(缺省,可被 materialKey 覆盖):
 *   hull→hull材质 / turret→turret材质 / barrel→barrel材质 /
 *   track→trackMetal材质 / wheel→wheelRubber材质 / decorative→detail材质 */
export const PART_TYPES = ['hull', 'turret', 'barrel', 'track', 'wheel', 'decorative'] as const;
export type PartType = (typeof PART_TYPES)[number];

/** 部件形状(元组件) —— buildCustom 按 shape 选几何工厂。
 *  三种元组件(对齐文档 §8 决策2 的用户形状选择器),按几何族划分,正交且覆盖全部现有形状:
 *   - box:      六面体族(标准方块 + 8角圆弧形变 → 圆角立方体,Phase B)
 *   - cylinder: 回转体族(标准圆柱)
 *   - wedge:    斜切体族(所有"斜面体"),含 3 子模式(symmetric/asymmetric/glacis),
 *               覆盖现有楔形车体/炮塔 + 车首斜板。见 WedgeSpecSchema。
 *  设计理由(2024 重构):wedge 与 glacis 本质同属"斜切体"(glacis 是顶面退化成线的楔形),
 *  归为同一元组件的子模式,比平级 shape 更内聚;box/cylinder/wedge 三族正交,用户心智清晰。 */
export const PART_SHAPES = ['box', 'cylinder', 'wedge'] as const;
export type PartShape = (typeof PART_SHAPES)[number];

/** 材质键 —— 指向 TankModel.materials 的色值表;PBR 预设(roughness/metalness/纹理类型)在
 *  Phase B buildCustom 内按此 key 查固定表(三车型 PBR 参数一致,只色值与 camo 随车型)。
 *  与 partType 解耦:partType=逻辑归属,materialKey=外观材质。
 *  例:主动轮 partType=track(归属履带,被击中触发履带 debuff)但 materialKey=trackMetal(金属外观)。 */
export const MATERIAL_KEYS = [
  'hull', 'turret', 'trackMetal', 'wheelRubber', 'wheelHub',
  'barrel', 'mantlet', 'detail', 'fender',
] as const;
export type MaterialKey = (typeof MATERIAL_KEYS)[number];

/** 部件运行时角色(锚点) —— 受 partType 约束(role 必须匹配 partType,见 TankPartSchema refine)。
 *  partType 表"击中区域"(战斗层 debuff 分发,粗粒度 6 种,所有 part 都有);
 *  role 表"运行时功能锚点"(buildCustom/物理派生用,从同类 partType 多件中选主角)。
 *  匹配约束:turret-body→turret / main-barrel→barrel / left-track,right-track→track;
 *           hull/wheel/decorative 不允许有 role。
 *
 *  一辆完整坦克必须含齐 4 个必备 role(见 TankModelSchema refine),
 *  否则炮塔不转/开火点错位/履带不滚 —— 这是"模型保证动画与游戏效果"的硬约束。
 *
 *  缺省 undefined = 普通装饰件(无运行时锚点职责)。
 *  例:主炮管 partType='barrel'+role='main-barrel';机枪管 partType='barrel'+无 role(不建 muzzle)。 */
export const PART_ROLES = ['turret-body', 'main-barrel', 'left-track', 'right-track'] as const;
export type PartRole = (typeof PART_ROLES)[number];

/** 楔体参数(wedge 元组件,按 mode 分 3 子模式)。
 *  wedge 元组件 = 所有"斜切体",按斜切方式区分,各对应一个现有几何工厂:
 *   - symmetric:  对称楔形(顶面整体收窄,前后等宽)。车体/T-14 炮塔。 → makeWedgeGeometry
 *   - asymmetric: 非对称楔形(顶面前后独立收窄,前厚后薄)。虎式/M1 炮塔。 → makeWedgeTurretGeometry
 *   - glacis:     三角楔(顶面退化成前缘线,即车首下斜板)。 → makeGlacisGeometry
 *  用 discriminatedUnion('mode') 严格区分:3 种参数集不同,buildCustom 按 mode switch 选工厂。
 *  centerY 是几何内部 y 偏移(与现有工厂签名一致);glacis 无 centerY(其几何原点已含定位)。
 *  导出:元组件注册表(META_SHAPES)wedge 项的 paramsSchema 复用。 */
export const WedgeSpecSchema = z.discriminatedUnion('mode', [
  // 对称楔形
  z.object({
    mode: z.literal('symmetric'),
    bottomHalfX: pos, topHalfX: pos,
    bottomHalfZ: pos, topHalfZ: pos,
    height: pos, centerY: num,
  }),
  // 非对称楔形(炮塔前厚后薄)
  z.object({
    mode: z.literal('asymmetric'),
    bottomHalfX: pos, topHalfX: pos,
    bottomHalfZ: pos,
    frontHalfZ: pos, backHalfZ: pos,
    height: pos, centerY: num,
  }),
  // 三角楔/车首下斜板(顶面退化成线)
  z.object({
    mode: z.literal('glacis'),
    halfX: pos, halfDepth: pos, halfHeight: pos,
  }),
]);

/** 单个实例相对 part.position 的偏移(logical-group 语义)。 */
const InstanceOffsetSchema = z.object({ dx: num, dy: num, dz: num });

/** 部件 schema —— 自定义坦克的原子单位。
 *  一个 part = 一种几何(可经 instances 复制为多个 mesh,共享几何/材质)。 */
export const TankPartSchema = z.object({
  id: z.string().min(1, '部件 id 不能为空'),
  name: z.string().min(1, '部件名不能为空'),
  partType: z.enum(PART_TYPES),
  /** 受击细粒度标签(可选,与 partType 正交)。用于同类 partType 内部差异化受击表现。
   *
   *  设计理由(健壮性):partType 同时承担"击中区域语义(debuff 分发,粗粒度6种)"和
   *  "受击表现分类(伤害倍率/特效)"两个职责,粒度可能不够。例:
   *   - 天线/储物篮都 partType=decorative,但受击表现不同(天线弯折 vs 篮子碎片)
   *   - 主动轮/负重轮都 partType=track/wheel,但材质不同(金属火花 vs 橡胶黑烟)
   *  hitTag 提供细粒度逃生口:天线 hitTag='antenna'、储物篮 hitTag='basket',
   *  规则表按 fallback 链查询(见下方语义约定)。
   *
   *  受击语义约定(实现健壮性,行为层必须遵守):
   *   1. 受击按【命中的 part 自身 partType + hitTag】算,与 mateTo 归属无关。
   *      打中挂在炮塔上的天线(hitTag='antenna', partType=decorative) = 打中 decorative,
   *      不是打中炮塔(不触发炮塔 debuff)。
   *   2. 行为层规则表查询 fallback:CONFIG.combat.partHits[hitTag] → [...][partType] → 默认。
   *      hitTag 缺省时退化为 partType 规则(向后兼容,现有3车型转换器无需配 hitTag)。
   *   3. instances(重复件)的部位 collider 由 Phase C buildCustom 按 partType 默认策略生成
   *      (不进数据):track/wheel 用 part 级包络、decorative 不生成、hull/turret/barrel 每part一个。
   *      特殊 part 需覆盖策略时,由 buildCustom 内部规则定,不在此字段表达。 */
  hitTag: z.string().optional(),
  shape: z.enum(PART_SHAPES),

  // —— box 专属 ——
  half: halfBox.optional(),

  // —— cylinder 专属 ——
  radius: pos.optional(),
  height: pos.optional(),
  /** 圆柱周向分段数(越大越圆滑)。缺省 16(与 Builder addCyl 默认一致)。 */
  segments: intPos.optional(),
  /** 弧面截取(仅 cylinder):截取一段圆柱面作弧形曲面(如弧形装甲/铸造首上)。
   *  start=起始角度(弧度,0=+x 轴,绕 y 逆时针),length=弧长(弧度,2π=完整圆柱)。
   *  缺省=完整圆柱(无 arc)。截取时两端径向封口(防开口看到背面)。
   *  例:弧形首上面朝 +z(前),用 start=0 length=π 配合 rotation 朝前。 */
  arc: z.object({ start: num, length: pos }).optional(),

  // —— wedge 专属(斜切体,按 mode 分 symmetric/asymmetric/glacis)——
  wedge: WedgeSpecSchema.optional(),

  // —— 通用 ——
  position: vec3,
  rotation: vec3.optional(),
  /** 原始色(编辑器拾色/显示用)。实际渲染材质色由 materialKey ?? partType 默认 → 顶层 materials 查。 */
  color: num,
  /** 装配/归属标记。值为父 part 的 id(如 'turret'),表示此 part 挂到父 part 的 group 下,
   *  随父级变换(炮塔旋转时炮塔级 part 跟着转)。缺省=挂在坦克根(root 级)。
   *  Phase D 编辑器可扩展为"命名面"(如 'hull.top')做精确吸附。 */
  mateTo: z.string().optional(),

  /** 逻辑组:重复实例偏移列表。存在时此 part 作"模板",按各 offset 叠加 part.position
   *  生成多个 mesh(共享 geometry/material)。用于负重轮组/格栅/afghanit 等程序化重复件。
   *  不存在 → 单实例(标准 part,只生成 1 个 mesh)。 */
  instances: z.array(InstanceOffsetSchema).optional(),

  /** 材质键(覆盖 partType 默认推断)。保证 partType 与材质不完全对应时仍零回归。
   *  缺省时按 partType 推断:hull→hull, turret→turret, barrel→barrel,
   *  track→trackMetal, wheel→wheelRubber, decorative→detail。 */
  materialKey: z.enum(MATERIAL_KEYS).optional(),

  // —— 运行时锚点(受 partType 约束,见 PART_ROLES + 下方 refine)——
  /** 运行时角色。buildCustom 用 role 识别主炮塔/主炮管/左右履带(替代旧 id 硬编码)。
   *  一辆坦克每种 role 最多一个(TankModelSchema refine 校验必备 4 role 齐全)。
   *  role 必须匹配 partType(见下方 refine):turret-body→turret / main-barrel→barrel / track→left,right。 */
  role: z.enum(PART_ROLES).optional(),
  /** 炮管根部锚点(世界坐标)。buildCustom 用此定位 barrel group 俯仰中心。
   *  缺省:从 role='main-barrel' 部件 position 沿 +z 回退 height/2(假设炮管沿 z 轴,现有3车型成立)。
   *  自定义炮管非 z 轴朝向时必填,否则俯仰轴错位、后坐力方向错。 */
  pivot: vec3.optional(),
})
  // shape 与尺寸字段匹配
  .refine(
    (p) => {
      if (p.shape === 'box') return p.half !== undefined;
      if (p.shape === 'cylinder') return p.radius !== undefined && p.height !== undefined;
      if (p.shape === 'wedge') return p.wedge !== undefined;
      return false;
    },
    { message: 'shape 与尺寸字段不匹配(box 需 half;cylinder 需 radius+height;wedge 需 wedge)' },
  )
  // role 与 partType 匹配约束(turret-body 需 turret / main-barrel 需 barrel / left,right-track 需 track)
  .refine(
    (p) => {
      if (!p.role) return true;
      const required: Record<PartRole, PartType> = {
        'turret-body': 'turret',
        'main-barrel': 'barrel',
        'left-track': 'track',
        'right-track': 'track',
      };
      return p.partType === required[p.role];
    },
    { message: 'role 与 partType 不匹配(turret-body→turret / main-barrel→barrel / left-track,right-track→track)' },
  );

/** 迷彩纹理参数(复用现有 CamoSchema 结构,顶层化)。 */
const CamoParamsSchema = CamoSchema;

/** 贴花(整车级,非几何 part)。编号贴炮塔,十字贴炮塔两侧(PlaneGeometry,alphaTest 抠圆外)。 */
const DecalSchema = z.object({
  /** 战术编号文字(如 '03'/'231'/'A11') */
  number: z.string().min(1),
  /** 是否画德军黑十字(仅虎式 true) */
  cross: z.boolean().optional(),
  crossColor: num.optional(),
});

/** 损坏参数。全字段可选(resolveTankModel 用 CONFIG 兜底,JSON 只存车型差异值)。
 *  官方坦克转换器显式填全(零回归);自定义坦克留空走 CONFIG 缺省。 */
const DamageSchema = z.object({
  /** HP 低于 maxHp × 此比例 → 开始冒烟。缺省 CONFIG.staticTank.smokeThreshold(0.6) */
  smokeThreshold: num.optional(),
  /** 击毁大爆炸尺寸缩放。缺省 CONFIG.staticTank.destroyExplosionScale(4) */
  destroyExplosionScale: num.optional(),
  /** 击毁浓烟尺寸缩放。缺省 CONFIG.staticTank.destroySmokeScale(1.6) */
  destroySmokeScale: num.optional(),
  /** 冒烟挂载点(相对车身 group)。受击小烟/击毁浓烟都挂此位置。缺省 {0,1,0}(通用车顶) */
  smokeOffset: vec3.optional(),
  /** 脱战回血:最后受击后多少秒开始回血。缺省 CONFIG.tank.damage.regenDelay(8) */
  regenDelay: num.optional(),
  /** 回血速率(HP/秒)。缺省 CONFIG.tank.damage.regenRate(5) */
  regenRate: num.optional(),
});

/** 整车物理包络(游戏碰撞体/击毁物理用)。
 *  全块可选:resolveTankModel 缺省时从 parts 几何推算(自定义坦克);
 *  官方坦克转换器显式填(零回归,与原 fixed schema 公式一致)。 */
const PhysicsSchema = z.object({
  /** 整车碰撞体半尺寸(RAPIER cuboid,主 collider)。缺省=parts 轴对齐包围盒半尺寸。 */
  bodyHalf: vec3,
  /** 碰撞体偏移(相对车身中心)。缺省 {0,0,0};静态坦克通常 y=bodyHalf.y 上移到车体。 */
  colliderOffset: vec3.optional(),
  /** 炮塔物理体半尺寸(击毁炸飞炮塔的 dynamic 刚体)。缺省=role='turret-body' 部件尺寸。 */
  turretHalf: vec3.optional(),
});

/** 驾驶手感(每车独立)。全块可选:resolveTankModel 缺省从 CONFIG.tank 提取(动态基准手感)。
 *  官方坦克转换器从各自 CONFIG 路径显式填(T14 用 CONFIG.tank,静态用 CONFIG.tank+debugDrive)。 */
const DriveSchema = z.object({
  moveSpeed: num,
  turnSpeed: num,
  accelLerp: num,
  reverseScale: num,
  turret: z.object({ turnSpeed: num, omegaLerp: num }),
  barrel: z.object({ pitchRange: z.object({ min: num, max: num }), pitchSpeed: num }),
  track: z.object({ offsetX: num, halfZ: num, rollScale: num }),
  camera: z.object({ offset: vec3, lookOffset: vec3, lerp: num }),
  dust: z.object({ minSpeed: num, spawnPerMeter: num }),
  sway: z.object({ pitchScale: num, rollScale: num, lerp: num }),
});

/** TankModel schema —— 统一的"部件列表组合式"坦克模型(所有车型共用)。 */
export const TankModelSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** 部件列表(核心)。至少 1 个。 */
  parts: z.array(TankPartSchema).min(1, '至少一个部件'),

  // —— 非视觉参数(从 CONFIG 提取) ——
  /** 物理质量(kg)。语义随 isStatic 变化:
   *   - isStatic 缺省/false(动态坦克,如 T14):真实物理质量,运行时即用
   *   - isStatic=true(静态展示坦克,如虎式/M1):击毁转 dynamic 后的"附加质量"
   *     (与 CONFIG.staticTank.destroyedMass 一致;运行时 fixed 视为无限质量) */
  mass: num,
  /** 是否静态展示坦克(运行时 fixed,击毁转 dynamic)。缺省 false=动态可驾驶。
   *  此标志解释 mass 语义,并供 Phase C 游戏实体决定物理行为(T14Tank vs StaticTankBase)。 */
  isStatic: z.boolean().optional(),
  maxHp: num,
  damage: DamageSchema.optional(),
  /** 整车物理包络。缺省 resolveTankModel 从 parts 推算。 */
  physics: PhysicsSchema.optional(),
  /** 驾驶手感(每车独立)。缺省 resolveTankModel 兜底 CONFIG.tank。 */
  drive: DriveSchema.optional(),

  // —— 材质(零回归必需,顶层承载) ——
  /** 各材质键的色值。buildCustom 按 part.materialKey ?? partType 默认映射 → 查此表取色;
   *  PBR 预设(roughness/metalness/纹理类型)在 buildCustom 内按 key 查固定表。 */
  materials: z.object({
    hull: num,
    turret: num,
    trackMetal: num,
    wheelRubber: num,
    wheelHub: num,
    barrel: num,
    /** 炮盾色。虎式/M1 数据无此字段,转换器用 barrel 兜底填充。 */
    mantlet: num,
    detail: num,
    fender: num,
  }),
  /** 迷彩纹理参数(车体/炮塔的 CanvasTexture 用)。 */
  camo: CamoParamsSchema,
  /** 履带链节纹理重复数(每车型不同)。buildCustom 生成 trackTex 时用。 */
  trackTexRepeat: intPos.optional(),
  /** 整车贴花(可选)。T14/虎式/M1 都有编号;仅虎式有黑十字。 */
  decal: DecalSchema.optional(),
}).refine(
  (m) => {
    // 完整性约束:必须含齐 4 个必备 role(主炮塔/主炮管/左履带/右履带)。
    // 这是"模型保证动画与游戏效果"的硬约束 —— 缺任一,炮塔不转/开火点错位/履带不滚。
    const required: PartRole[] = ['turret-body', 'main-barrel', 'left-track', 'right-track'];
    const roles = new Set(m.parts.map((p) => p.role).filter((r): r is PartRole => r !== undefined));
    return required.every((r) => roles.has(r));
  },
  { message: '坦克必须含主炮塔/主炮管/左履带/右履带四个必备部件(role),否则动画/开火/履带滚动失效' },
);

// ============================================================
// 部件组合式类型推导
// ============================================================

export type TankPart = z.infer<typeof TankPartSchema>;
export type TankModel = z.infer<typeof TankModelSchema>;
export type Physics = z.infer<typeof PhysicsSchema>;
export type Drive = z.infer<typeof DriveSchema>;
/** resolve 后的 damage(全字段填充,游戏就绪)。 */
export interface ResolvedDamage {
  smokeThreshold: number;
  destroyExplosionScale: number;
  destroySmokeScale: number;
  smokeOffset: { x: number; y: number; z: number };
  // regenDelay/regenRate 已移除:回血移至补给点,不再需要脱战回血配置
}
/** resolve 后的 TankModel(全字段填充,游戏就绪)。加载层 resolveTankModel 产出此类型,
 *  保证游戏实体读取时永不缺值(防御:不因 JSON 缺字段崩溃)。 */
export type ResolvedTankModel = Omit<TankModel, 'physics' | 'damage' | 'drive'> & {
  physics: Physics;
  damage: ResolvedDamage;
  drive: Drive;
};
