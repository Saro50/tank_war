/**
 * M1 艾布拉姆斯(Abrams)视觉参数
 * ============================================================
 * 现代主战:倾斜复合装甲+楔形炮塔+7对负重轮+托带轮+沙漠迷彩+战术编号。
 * 仅外形参数(不包含 maxHp/debugDrive 等非视觉字段)。
 */
const abrams = {
  /** 倾斜复合装甲(上窄下宽)+驾驶舱凸起+首下斜板 */
  hull: {
    bottomHalfX: 1.35,
    topHalfX: 1.15,
    bottomHalfZ: 2.6,
    topHalfZ: 2.4,
    height: 1.0,
    centerY: 0.85,
    /** 车首驾驶舱凸起(M1 标志性前凸) */
    frontHatch: {
      halfX: 0.4,
      halfY: 0.22,
      halfZ: 0.45,
      x: 0,
      y: 1.3,
      z: 1.6,
    },
    /** 车首大倾角下斜板(lower glacis) */
    frontSlope: {
      halfX: 1.35,
      halfDepth: 0.45,
      halfHeight: 0.5,
      x: 0,
      y: 0.85,
      z: 3.05,
    },
  },

  track: {
    halfX: 0.32,
    halfY: 0.32,
    halfZ: 2.6,
    offsetX: 1.35,
    centerY: 0.4,
    texRepeat: 13,
  },

  roadWheel: {
    count: 7,
    radius: 0.36,
    halfWidth: 0.2,
    offsetX: 1.35,
    centerY: 0.4,
    zSpan: 2.2,
  },

  /** 托带轮(履带上方回程支撑轮) */
  returnRoller: {
    radius: 0.12,
    halfWidth: 0.1,
    offsetX: 1.32,
    centerY: 0.72,
    count: 5,
    zSpan: 1.6,
  },

  /** 前主动轮带齿 */
  toothedSprocket: true,

  roadWheelStagger: undefined,

  fender: {
    halfX: 0.28,
    halfY: 0.05,
    halfZ: 2.65,
    offsetX: 1.55,
    centerY: 0.82,
  },

  /** 侧裙板(只遮履带上半,露出下排大负重轮) */
  sideSkirt: {
    halfX: 0.06,
    halfY: 0.26,
    halfZ: 2.3,
    offsetX: 1.62,
    centerY: 0.72,
  },

  /** 炮塔(前后非对称楔形+车长镜+装填手舱盖+储物篮+机枪站) */
  turret: {
    offset: { x: 0, y: 1.35, z: 0.1 },
    body: {
      bottomHalfX: 0.95,
      topHalfX: 0.68,
      bottomHalfZ: 1.1,
      topHalfZ: 0.85,
      frontHalfZ: 0.85,
      backHalfZ: 0.4,
      height: 0.7,
      centerY: 0.35,
    },
    /** 车长指挥塔(独立周视镜,右后) */
    cupola: {
      radius: 0.22,
      height: 0.24,
      x: 0.35,
      y: 0.78,
      z: -0.25,
    },
    /** 车长瞄准镜(前部柱状) */
    sight: {
      halfX: 0.13,
      halfY: 0.2,
      halfZ: 0.13,
      x: 0.32,
      y: 0.82,
      z: 0.28,
    },
    /** 装填手舱盖(左侧不对称) */
    loaderHatch: {
      radius: 0.22,
      height: 0.12,
      x: -0.35,
      y: 0.78,
      z: 0.0,
    },
    /** 炮塔尾部储物篮(扁平篮筐) */
    bustle: {
      halfX: 0.68,
      halfY: 0.28,
      halfZ: 0.4,
      x: 0,
      y: 0.42,
      z: -1.1,
    },
    frontShield: undefined,
    /** 车长机枪站(12.7mm 底座+枪管) */
    mgStation: {
      baseHalf: { x: 0.16, y: 0.1, z: 0.18 },
      base: { x: -0.35, y: 0.95, z: -0.1 },
      barrelRadius: 0.025,
      barrelLen: 0.7,
      barrel: { x: -0.35, y: 1.1, z: 0.15 },
    },
  },

  /** M256 120mm 滑膛炮(带热护套) */
  barrel: {
    offset: { x: 0, y: 0.3, z: 0.55 },
    length: 2.9,
    radius: 0.1,
  },

  muzzleBrake: undefined,

  /** 热护套(炮管中段分段加粗) */
  thermalSleeve: {
    radius: 0.14,
    length: 1.6,
    posRatio: 0.45,
  },

  /** 炮盾 */
  mantlet: {
    radius: 0.2,
    halfZ: 0.4,
  },

  /** 沙漠黄三色迷彩 */
  colors: {
    hull: 0xb5a06a,
    turret: 0xb5a06a,
    camo: {
      base: 0xb5a06a,
      blobDark: 0x8a7445,
      blobMid: 0xd4c089,
      style: 'nato-blotch' as const,
      wear: 0.35,
    },
    trackMetal: 0x333333,
    wheelRubber: 0x1a1a1a,
    wheelHub: 0x555555,
    barrel: 0x8a7445,
    detail: 0x3a3520,
    fender: 0xa08a55,
  },

  number: 'A11',

  /** 贴花:战术编号(无十字,美军风格) */
  decal: {
    cross: false,
    crossColor: 0x1a1a1a,
  },
} as const;

export default abrams;
export type AbramsVisual = typeof abrams;
