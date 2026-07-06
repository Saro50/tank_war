/**
 * geometryFaces.ts —— 装配面值计算器(几何知识层)
 * ============================================================
 * 命名"面/基准",每个面 = 从坦克数据算面值的函数。
 * 集中所有几何公式,改一处全生效(DRY)。assemblyRules 只引用面名,不写公式。
 *
 * 命名约定:'部件路径.面名'
 *  - top/bottom:Y 方向顶/底面(centerY ± height/2)
 *  - side:X 方向侧面(半宽)/ outer:外缘
 *  - front/back:Z 方向前/后端(±halfZ)
 *  - centerY:几何中心高度 / span:有效跨度
 *
 * 几何事实(makeWedgeGeometry):height 是全高,顶/底面 = centerY ± height/2。
 */

/** 读点分路径数值;读不到或非数字返回 NaN */
export function num(data: Record<string, unknown>, path: string): number {
  const keys = path.split('.');
  let cur: unknown = data;
  for (const k of keys) {
    if (cur && typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[k];
    } else {
      return NaN;
    }
  }
  return typeof cur === 'number' ? cur : NaN;
}

export const FACES = {
  // —— 车体(height 全高)——
  'hull.top': (d: Record<string, unknown>) => num(d, 'hull.centerY') + num(d, 'hull.height') / 2,
  'hull.bottom': (d: Record<string, unknown>) => num(d, 'hull.centerY') - num(d, 'hull.height') / 2,
  'hull.side': (d: Record<string, unknown>) => num(d, 'hull.bottomHalfX'),
  'hull.front': (d: Record<string, unknown>) => num(d, 'hull.bottomHalfZ'),
  'hull.back': (d: Record<string, unknown>) => -num(d, 'hull.bottomHalfZ'),

  // —— T14 Armata 炮塔主体 ——
  'armata.front': (d: Record<string, unknown>) => num(d, 'turret.armata.bottomHalfZ'),
  'armata.back': (d: Record<string, unknown>) => -num(d, 'turret.armata.bottomHalfZ'),
  'armata.centerY': (d: Record<string, unknown>) => num(d, 'turret.armata.offsetY'),
  'armata.top': (d: Record<string, unknown>) => num(d, 'turret.armata.offsetY') + num(d, 'turret.armata.halfY'),
  'armata.side': (d: Record<string, unknown>) => num(d, 'turret.armata.bottomHalfX'),

  // —— 虎式/M1 炮塔主体 body ——
  'body.front': (d: Record<string, unknown>) => num(d, 'turret.body.frontHalfZ'),
  'body.back': (d: Record<string, unknown>) => -num(d, 'turret.body.backHalfZ'),
  'body.centerY': (d: Record<string, unknown>) => num(d, 'turret.body.centerY'),
  'body.top': (d: Record<string, unknown>) => num(d, 'turret.body.centerY') + num(d, 'turret.body.height') / 2,

  // —— 履带(供履带子部件 + 挡泥板/侧裙/负重轮引用)——
  'track.centerX': (d: Record<string, unknown>) => num(d, 'track.offsetX'),
  'track.centerY': (d: Record<string, unknown>) => num(d, 'track.centerY'),
  'track.outer': (d: Record<string, unknown>) => num(d, 'track.offsetX') + num(d, 'track.halfX'),
  'track.top': (d: Record<string, unknown>) => num(d, 'track.centerY') + num(d, 'track.halfY'),
  'track.length': (d: Record<string, unknown>) => num(d, 'track.halfZ'),
  'track.span': (d: Record<string, unknown>) => num(d, 'track.halfZ') - num(d, 'track.halfY'),

  // —— 负重轮(供交错轮内排引用)——
  'roadWheel.centerX': (d: Record<string, unknown>) => num(d, 'roadWheel.offsetX'),
} as const;

/** 合法面标识(字面量联合;用未定义的面编译期报错) */
export type FaceKey = keyof typeof FACES;
