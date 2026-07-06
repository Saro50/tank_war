/**
 * 虎式坦克(Tiger I)视觉参数
 * ============================================================
 * 二战德军:垂直方盒装甲+长88炮+交错负重轮+德军迷彩+黑十字贴花。
 * 仅外形参数(不包含 maxHp/debugDrive 等非视觉字段)。
 */
const tiger = {
  /** 垂直方盒装甲(加厚敦实) */
  hull: {
    bottomHalfX: 1.18,
    topHalfX: 1.18,
    bottomHalfZ: 2.4,
    topHalfZ: 2.4,
    height: 1.3,
    centerY: 0.9,
    /** 车首下斜板(三角楔) */
    frontSlope: {
      halfX: 1.18,
      halfDepth: 0.5,
      halfHeight: 0.65,
      x: 0,
      y: 0.9,
      z: 2.9,
    },
  },

  track: {
    halfX: 0.28,
    halfY: 0.3,
    halfZ: 2.4,
    offsetX: 1.18,
    centerY: 0.45,
    texRepeat: 12,
  },

  roadWheel: {
    count: 8,
    radius: 0.3,
    halfWidth: 0.16,
    offsetX: 1.18,
    centerY: 0.45,
    zSpan: 2.1,
  },

  /** 交错式负重轮(虎式标志):内排轮偏移半距 */
  roadWheelStagger: {
    radius: 0.26,
    halfWidth: 0.16,
    offsetX: 1.05,
    centerY: 0.45,
    zSpan: 2.1,
    zHalfStep: true,
  },

  fender: {
    halfX: 0.24,
    halfY: 0.05,
    halfZ: 2.45,
    offsetX: 1.36,
    centerY: 1.05,
  },

  /** 侧裙板(Schürzen 护板,仅遮履带顶端) */
  sideSkirt: {
    halfX: 0.05,
    halfY: 0.18,
    halfZ: 2.2,
    offsetX: 1.42,
    centerY: 0.78,
  },

  /** 炮塔(前后非对称楔形+车长指挥塔+战斗室加宽+前脸防盾) */
  turret: {
    offset: { x: 0, y: 1.55, z: -0.3 },
    body: {
      bottomHalfX: 0.78,
      topHalfX: 0.6,
      bottomHalfZ: 1.05,
      topHalfZ: 0.85,
      frontHalfZ: 0.85,
      backHalfZ: 0.45,
      height: 0.6,
      centerY: 0.3,
    },
    /** 车长指挥塔(炮塔顶圆柱) */
    cupola: {
      radius: 0.22,
      height: 0.2,
      x: 0,
      y: 0.7,
      z: -0.5,
    },
    sight: undefined,
    loaderHatch: undefined,
    /** 炮塔后部战斗室加宽段 */
    bustle: {
      halfX: 0.78,
      halfY: 0.22,
      halfZ: 0.3,
      x: 0,
      y: 0.32,
      z: -1.15,
    },
    /** 前脸厚防盾(88mm 炮根处) */
    frontShield: {
      halfX: 0.42,
      halfY: 0.32,
      halfZ: 0.18,
      x: 0,
      y: 0.32,
      z: 1.0,
    },
  },

  /** 88mm 长炮 */
  barrel: {
    offset: { x: 0, y: 0.25, z: 0.5 },
    length: 3.0,
    radius: 0.09,
  },

  /** 炮口制退器(双室,虎式标志) */
  muzzleBrake: {
    radius: 0.13,
    length: 0.4,
  },

  thermalSleeve: undefined,

  /** 炮盾(炮管根部加厚) */
  mantlet: {
    radius: 0.17,
    halfZ: 0.32,
  },

  /** 德军灰绿+褐黄三色迷彩 */
  colors: {
    hull: 0x6b6a55,
    turret: 0x6b6a55,
    camo: {
      base: 0x6b6a55,
      blobDark: 0x4a4a35,
      blobMid: 0x8a7d4a,
      style: 'nato-blotch' as const,
      wear: 0.55,
    },
    trackMetal: 0x333333,
    wheelRubber: 0x1a1a1a,
    wheelHub: 0x555555,
    barrel: 0x4a4a35,
    detail: 0x2a2a20,
    fender: 0x5a5a45,
  },

  number: '231',

  /** 贴花:德军黑十字(Balkenkreuz) */
  decal: {
    cross: true,
    crossColor: 0x1a1a1a,
  },
} as const;

export default tiger;
export type TigerVisual = typeof tiger;
