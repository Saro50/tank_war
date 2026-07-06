/**
 * T-14 Armata 坦克视觉参数（车体几何/履带/负重轮/炮塔/武器/颜色）
 * ============================================================
 * 仅包含外形参数（非物理/手感/相机/损坏系统）。
 * 数据来源: config.ts CONFIG.tank 中视觉相关字段。
 * 编辑器读此文件后可直接修改并写回。
 */
const t14 = {
  /** 梯形车身(视觉楔形):上窄下宽 */
  hull: {
    bottomHalfX: 1.06,
    topHalfX: 0.9,
    bottomHalfZ: 2.15,
    topHalfZ: 1.65,
    height: 1.05,
    centerY: -0.05,
  },

  /** 履带(左右各一,胶囊形直段+两端圆柱) */
  track: {
    halfX: 0.27,
    halfY: 0.3,
    halfZ: 2.05,
    offsetX: 0.88,
    centerY: -0.48,
    texRepeat: 6,
    rollScale: 1.0,
  },

  /** 负重轮(每侧 7 对,辨识特征) */
  roadWheel: {
    count: 7,
    radius: 0.22,
    halfWidth: 0.1,
    offsetX: 0.66,
    centerY: -0.48,
    zSpan: 1.6,
  },

  /** 挡泥板(履带上方薄板) */
  fender: {
    halfX: 0.16,
    halfY: 0.025,
    halfZ: 2.1,
    offsetX: 0.88,
    centerY: -0.16,
  },

  /** 炮塔(无人炮塔:方形主体+传感器+遥控机枪+主动防御+天线) */
  turret: {
    offset: { x: 0, y: 0.48, z: -0.3 },
    /** T-14 Armata 楔形无人炮塔 */
    armata: {
      bottomHalfX: 0.88,
      topHalfX: 0.6,
      bottomHalfZ: 1.05,
      topHalfZ: 0.85,
      halfY: 0.26,
      offsetY: 0.3,
      sightCmdr: {
        half: { x: 0.2, y: 0.13, z: 0.16 },
        offset: { x: 0, y: 0.46, z: -0.4 },
      },
      sightGunner: {
        half: { x: 0.13, y: 0.11, z: 0.12 },
        offset: { x: 0.28, y: 0.42, z: 0.3 },
      },
      rcws: {
        half: { x: 0.16, y: 0.09, z: 0.16 },
        offset: { x: 0.42, y: 0.42, z: 0.05 },
        barrelLen: 0.5,
        barrelRadius: 0.022,
      },
    },
    /** "阿富汗石"主动防御发射管(炮塔两侧小柱) */
    afghanit: {
      radius: 0.045,
      height: 0.16,
      count: 5,
      offsetX: 0.88,
      zSpan: 0.7,
      offsetY: 0.2,
    },
    /** 通讯天线(炮塔后部,随炮塔旋转) */
    antenna: {
      radius: 0.014,
      length: 1.0,
      baseX: 0.6,
      baseY: 0.42,
      baseZ: -0.7,
      tilt: 0.3,
    },
  },

  /** 武器(炮管+炮盾+抽烟器+炮口装置) */
  barrel: {
    offset: { x: 0, y: 0.28, z: 0.4 },
    length: 1.9,
    /** 炮盾(炮管根部加厚块) */
    mantlet: {
      radius: 0.2,
      halfZ: 0.18,
    },
    /** 炮管中段抽烟器 */
    fumeExtractor: {
      radius: 0.15,
      length: 0.4,
      posRatio: 0.66,
    },
    /** 炮口装置(消焰器) */
    muzzleDevice: {
      radius: 0.13,
      length: 0.18,
    },
  },

  /** 车体附件(发动机格栅+驾驶员舱盖) */
  stowage: {
    engineGrille: {
      count: 5,
      halfX: 0.5,
      halfY: 0.16,
      halfThick: 0.018,
      z: -2.1,
      y: 0.0,
    },
    driverHatch: {
      radius: 0.22,
      height: 0.1,
      x: 0,
      z: 1.5,
      y: 0.5,
    },
  },

  /** 配色(俄军橄榄绿系:漆面哑光+金属高反射+橡胶全哑光) */
  colors: {
    hull: 0x4a5535,
    turret: 0x434d30,
    camo: {
      base: 0x4a5535,
      blobDark: 0x2a2e18,
      blobMid: 0x38401e,
      style: 'nato-blotch' as const,
      wear: 0.25,
    },
    number: '03',
    trackMetal: 0x2a2d33,
    wheelRubber: 0x1a1c1f,
    wheelHub: 0x3a3d42,
    barrel: 0x33373d,
    mantlet: 0x2e3137,
    detail: 0x141619,
    fender: 0x4a5424,
  },
} as const;

export default t14;
export type T14Visual = typeof t14;
