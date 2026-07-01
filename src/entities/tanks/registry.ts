import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import type { TankBase } from './TankBase';
import { T14Tank } from './T14Tank';
import { TigerTank } from './TigerTank';
import { AbramsTank } from './AbramsTank';

/**
 * 坦克工厂:variant 字符串 → 具体子类实例。
 * ------------------------------------------------------------
 * 新增坦克型号时,这里加一个 case 是唯一的接线点
 * (配合:子类文件 + config 型号参数 + CONFIG.tanks spawn 条目)。
 *
 * spawn.y 统一为【地面高度】,各子类构造内部按需抬高
 * (T14Tank 抬高到车身中心;StaticTankBase 用 collider offset 抬高),
 * 调用方(createTank/buildTanks)无需关心几何差异。
 *
 * 未知 variant 抛异常——as const 下编译期不会发生,运行期兜底由调用方 try/catch。
 */
export function createTank(
  variant: string,
  physics: PhysicsWorld,
  render: RenderScene,
  spawn: { x: number; y: number; z: number },
  yaw: number,
): TankBase {
  switch (variant) {
    case 't14':
      return new T14Tank(physics, render, spawn, yaw);
    case 'tiger':
      return new TigerTank(physics, render, spawn, yaw);
    case 'abrams':
      return new AbramsTank(physics, render, spawn, yaw);
    default:
      throw new Error(`unknown tank variant: ${variant}`);
  }
}
