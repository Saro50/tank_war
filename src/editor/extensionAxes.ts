/**
 * extensionAxes.ts —— 部件延展方向声明(生长规则)
 * ============================================================
 * 声明每个"可延展字段"(如炮管长度)的延展属性:
 *  - axis:延展轴(拉长时沿此方向)
 *  - fixedEnd:固定端(延展时此端不动,另一端延伸)
 *  - minLength:最短限制(防缩进穿透/视觉异常)
 *
 * "不穿透"原理(无需碰撞检测):
 *  Phase 2 约束维持部件的固定端贴父(如炮管根部贴炮塔前端)。
 *  延展沿自由方向(远离父),物理上不可能穿透。
 *  minLength 仅防御极端缩短(如误操作把炮管拖到 0.1m)。
 *
 * Phase 4 UI 用此声明:在 3D 视口显示延展方向箭头。
 */
import type { TankVariant } from '../data/TankSchema';

export interface ExtensionRule {
  /** 延展字段路径(如 'barrel.length') */
  field: string;
  /** 延展轴 */
  axis: 'x' | 'y' | 'z';
  /** 固定端:min=负方向端固定 / max=正方向端固定 / center=中心固定(对称延展) */
  fixedEnd: 'min' | 'max' | 'center';
  /** 最短限制(防穿透);不设则不限制 */
  minLength?: number;
}

/** 三车型共用的延展规则(车体/履带中心固定,对称延展) */
const COMMON: ExtensionRule[] = [
  { field: 'hull.height', axis: 'y', fixedEnd: 'center', minLength: 0.3 },
  { field: 'hull.bottomHalfZ', axis: 'z', fixedEnd: 'center', minLength: 0.5 },
  { field: 'hull.bottomHalfX', axis: 'x', fixedEnd: 'center', minLength: 0.3 },
  { field: 'track.halfZ', axis: 'z', fixedEnd: 'center', minLength: 0.5 },
];

export function getExtensionRules(_variant: TankVariant): ExtensionRule[] {
  return [
    ...COMMON,
    // 炮管:根部固定(Phase 2 约束贴炮塔前端),向炮口 +z 延展,不穿透车身
    { field: 'barrel.length', axis: 'z', fixedEnd: 'min', minLength: 0.5 },
  ];
}
