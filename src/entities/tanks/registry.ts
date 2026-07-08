import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import type { NpcTier } from '../../config';
import type { TankBase } from './TankBase';
import { T14Tank } from './T14Tank';
import { TigerTank } from './TigerTank';
import { AbramsTank } from './AbramsTank';
import { GltfTank } from './GltfTank';

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
 * tier(可选):仅 NPC 传,决定外观配色+军衔标识(M3+)。玩家 T-14/中立不传(undefined→原配色)。
 * 未知 variant 抛异常——as const 下编译期不会发生,运行期兜底由调用方 try/catch。
 */
export function createTank(
  variant: string,
  physics: PhysicsWorld,
  render: RenderScene,
  spawn: { x: number; y: number; z: number },
  yaw: number,
  tier?: NpcTier,
): TankBase {
  switch (variant) {
    case 't14':
      return new T14Tank(physics, render, spawn, yaw); // 玩家 T-14 无 tier(始终原配色)
    case 'gltf':
      // 精细化美术资产(外部 glb)。GltfTankAsset 必须 main 启动时已 load。
      return new GltfTank(physics, render, spawn, yaw);
    case 'tiger':
      return new TigerTank(physics, render, spawn, yaw, tier);
    case 'abrams':
      return new AbramsTank(physics, render, spawn, yaw, tier);
    default:
      throw new Error(`unknown tank variant: ${variant}`);
  }
}
