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
/** 正数(几何尺寸,防 0/负导致 BufferGeometry 异常) */
const pos = z.number().positive();
/** 正整数(count/texRepeat 等,防 0 导致空循环或除零) */
const intPos = z.number().int().min(1);
/** 任意数值(布尔语义字段单独用 z.boolean) */
/** 三维向量(偏移量) */
const vec3 = z.object({ x: num, y: num, z: num });
/** 半尺寸盒子 {x,y,z 全正} */
const halfBox = z.object({ x: pos, y: pos, z: pos });

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
