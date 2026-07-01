/**
 * 坦克实例唯一 ID 生成器
 * ------------------------------------------------------------
 * 模块级自增计数器,每创建一辆坦克(Tank/StaticTank)在构造时调用 nextTankId() 取号。
 *
 * 为何需要:同一型号可能有多辆(如 2 辆 Tiger),仅靠 name(型号名)无法区分,
 * 日志/HUD/Tab 切换会显示重名。id 提供实例级唯一性,displayName = name + #id。
 *
 * 为何全局计数器而非每型号各自:跨型号统一编号,先创建的先拿小号,
 * 与 buildTanks 遍历 CONFIG.tanks 的顺序一致,便于按 id 排查"第几辆创建的"。
 *
 * 上下游:Tank/StaticTank 构造时各取一次;不重置(场景内坦克只增不减,重置靠刷新页面)。
 */
let counter = 0;

/** 取下一个坦克实例 ID(从 1 开始自增) */
export function nextTankId(): number {
  return ++counter;
}
