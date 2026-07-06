/**
 * assemblyRules.ts —— 装配邻接声明(关系层)
 * ============================================================
 * 声明"哪个子字段贴哪个命名面"。纯声明,无公式(公式在 geometryFaces)。
 *
 * Phase 2 完整覆盖:位置 Mate(部件贴父某面)+ 尺寸 Align(子尺寸跟随父尺寸)。
 * 两者机制相同(相对偏移维持),只是 child 是位置字段还是尺寸字段。
 *
 * 新增邻接:加一行 { child, face, label }。face 已存在则零公式。
 */
import type { TankVariant } from '../data/TankSchema';
import type { FaceKey } from './geometryFaces';

/** 一条邻接约束 */
export interface Mate {
  /** 子字段路径(点分),如 'turret.offset.y' */
  child: string;
  /** 父面标识(在 FACES 里查),如 'hull.top' */
  face: FaceKey;
  /** 人类可读描述 */
  label: string;
}

/**
 * 三车型共用的邻接(车体→炮塔/履带,履带→负重轮/挡泥板)。
 * 含位置 Mate + 尺寸 Align(履带长度跟随车体、负重轮/挡泥板跟随履带)。
 */
const COMMON_MATES: Mate[] = [
  // —— 位置 Mate ——
  { child: 'turret.offset.y', face: 'hull.top', label: '炮塔贴车体顶面' },
  { child: 'track.offsetX', face: 'hull.side', label: '履带贴车体侧面' },
  { child: 'track.centerY', face: 'hull.bottom', label: '履带高度贴车体底面' },
  { child: 'roadWheel.offsetX', face: 'track.centerX', label: '负重轮对齐履带' },
  { child: 'roadWheel.centerY', face: 'track.centerY', label: '负重轮同履带高度' },
  { child: 'fender.offsetX', face: 'track.outer', label: '挡泥板贴履带外侧' },
  { child: 'fender.centerY', face: 'track.top', label: '挡泥板贴履带上方' },
  // —— 尺寸 Align(长度跟随,链式:车体→履带→负重轮/挡泥板)——
  { child: 'track.halfZ', face: 'hull.front', label: '履带长度跟随车体' },
  { child: 'roadWheel.zSpan', face: 'track.span', label: '负重轮跨度跟随履带' },
  { child: 'fender.halfZ', face: 'track.length', label: '挡泥板长度跟随履带' },
];

/** 按车型返回完整邻接规则 */
export function getAssemblyRules(variant: TankVariant): Mate[] {
  const rules = [...COMMON_MATES];

  if (variant === 't14') {
    // T14:炮管 + 阿富汗石 + 天线 + 瞄准镜/机枪 + 车体附件
    rules.push(
      { child: 'barrel.offset.z', face: 'armata.front', label: '炮管贴 Armata 前端' },
      { child: 'barrel.offset.y', face: 'armata.centerY', label: '炮管高度贴 Armata 中心' },
      { child: 'turret.afghanit.offsetX', face: 'armata.side', label: '阿富汗石贴炮塔两侧' },
      { child: 'turret.afghanit.offsetY', face: 'armata.centerY', label: '阿富汗石同炮塔中心高度' },
      { child: 'turret.afghanit.zSpan', face: 'armata.front', label: '阿富汗石跨度跟随炮塔长度' },
      { child: 'turret.antenna.baseY', face: 'armata.top', label: '天线贴炮塔顶' },
      { child: 'turret.antenna.baseZ', face: 'armata.back', label: '天线贴炮塔后部' },
      { child: 'turret.armata.sightCmdr.offset.y', face: 'armata.top', label: '车长镜贴炮塔顶' },
      { child: 'turret.armata.sightGunner.offset.y', face: 'armata.top', label: '炮长镜贴炮塔顶' },
      { child: 'turret.armata.rcws.offset.y', face: 'armata.top', label: '遥控机枪贴炮塔顶' },
      { child: 'stowage.engineGrille.z', face: 'hull.back', label: '发动机格栅贴车体后部' },
      { child: 'stowage.engineGrille.y', face: 'hull.top', label: '发动机格栅贴车体顶' },
      { child: 'stowage.driverHatch.z', face: 'hull.front', label: '驾驶舱盖贴车体前部' },
      { child: 'stowage.driverHatch.y', face: 'hull.top', label: '驾驶舱盖贴车体顶' },
    );
  } else if (variant === 'tiger') {
    // 虎式:炮管 + 指挥塔 + 战斗室 + 防盾 + 交错轮 + 侧裙
    rules.push(
      { child: 'barrel.offset.z', face: 'body.front', label: '炮管贴炮塔前端' },
      { child: 'barrel.offset.y', face: 'body.centerY', label: '炮管高度贴炮塔中心' },
      { child: 'turret.cupola.y', face: 'body.top', label: '指挥塔贴炮塔顶' },
      { child: 'turret.bustle.z', face: 'body.back', label: '战斗室贴炮塔后部' },
      { child: 'turret.frontShield.z', face: 'body.front', label: '前脸防盾贴炮塔前端' },
      { child: 'roadWheelStagger.zSpan', face: 'track.length', label: '交错轮跨度跟随履带' },
      { child: 'roadWheelStagger.offsetX', face: 'roadWheel.centerX', label: '交错轮对齐负重轮' },
      { child: 'sideSkirt.offsetX', face: 'track.outer', label: '侧裙贴履带外侧' },
      { child: 'sideSkirt.halfZ', face: 'track.length', label: '侧裙长度跟随履带' },
    );
  } else {
    // M1 艾布拉姆斯:炮管 + 指挥塔/镜/舱盖/储物篮/机枪 + 托带轮 + 驾驶舱凸起
    rules.push(
      { child: 'barrel.offset.z', face: 'body.front', label: '炮管贴炮塔前端' },
      { child: 'barrel.offset.y', face: 'body.centerY', label: '炮管高度贴炮塔中心' },
      { child: 'turret.cupola.y', face: 'body.top', label: '指挥塔贴炮塔顶' },
      { child: 'turret.sight.y', face: 'body.top', label: '车长镜贴炮塔顶' },
      { child: 'turret.loaderHatch.y', face: 'body.top', label: '装填手舱盖贴炮塔顶' },
      { child: 'turret.bustle.z', face: 'body.back', label: '储物篮贴炮塔后部' },
      { child: 'turret.mgStation.base.y', face: 'body.top', label: '机枪站贴炮塔顶' },
      { child: 'returnRoller.zSpan', face: 'track.length', label: '托带轮跨度跟随履带' },
      { child: 'returnRoller.offsetX', face: 'track.centerX', label: '托带轮对齐履带' },
      { child: 'hull.frontHatch.y', face: 'hull.top', label: '驾驶舱凸起贴车体顶' },
      { child: 'hull.frontHatch.z', face: 'hull.front', label: '驾驶舱凸起贴车体前部' },
    );
  }
  return rules;
}
