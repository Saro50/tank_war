import type { Fragment } from './Destructible';

/**
 * 可损坏实体统一契约(玩家坦克 / 静态坦克 / 未来 AI 坦克共用)。
 * ------------------------------------------------------------
 * 设计:用 interface 而非基类。Tank 与 StaticTank 现有结构差异较大
 *      (dynamic 可动 vs fixed 静态、可动炮塔 vs 静态炮塔),
 *      强抽公共基类改动大且无收益;接口让两者"形式统一"接入
 *      DestructionSystem 的伤害分发,且互不耦合。
 *
 * DestructionSystem.applyDamage 用 Damageable 的统一形式遍历所有可受击目标,
 * 对每个目标按爆心距离衰减后调用 takeHit。未来 AI 坦克只需实现本接口即可接入。
 */
export interface Damageable {
  /** 受击物理刚体的 collider handle,DestructionSystem 反查定位用 */
  readonly colliderHandle: number;
  /** 物理刚体,读位置算爆心距离衰减用(结构上兼容 RAPIER.RigidBody) */
  readonly body: { translation(): { x: number; y: number; z: number } };
  /** 状态:完好 / 已击毁(击毁后不再受击,takeHit 直接返回空) */
  state: 'intact' | 'destroyed';
  /**
   * 受击入口(由 DestructionSystem.applyDamage 调用,与炮击/撞击统一)。
   * @param epicenter 爆心(世界坐标)
   * @param damage    本次衰减后的伤害值
   * @returns 击毁时返回飞溅碎片(由 DestructionSystem 维护寿命);未击毁返回空数组。
   */
  takeHit(epicenter: { x: number; y: number; z: number }, damage: number): Fragment[];
}
