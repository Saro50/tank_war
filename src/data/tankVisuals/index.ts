/**
 * 坦克视觉参数数据入口
 * ============================================================
 * 集中导出三个车型( T-14 / 虎式 / M1 )的视觉外形参数。
 *
 * 数据来源:车型对应的 .ts 文件(纯粹数据,无逻辑),从 config.ts 中
 *  抽离出来以保持"外形参数"与"物理/手感/系统参数"分离。
 *
 * 用途:
 *  - 游戏:config.ts 导入此处,通过 spread 合并到 CONFIG 对应位置。
 *  - 编辑器:直接读写此数据文件,修改后导回。
 *
 * 导入用法:
 *   import { t14, tiger, abrams } from './data/tankVisuals';
 *   CONFIG.tank.hull = t14.hull;   // 替换视觉参数
 */

export { default as t14, type T14Visual } from './t14';
export { default as tiger, type TigerVisual } from './tiger';
export { default as abrams, type AbramsVisual } from './abrams';
