import type { IControllableTank } from '../entities/IControllableTank';
import type { PhysicsWorld } from '../core/PhysicsWorld';

/**
 * NPC 感知工具:目标搜索 + 视线检测
 * ------------------------------------------------------------
 * 首期简化:findNearestEnemy 仅按距离选最近敌方(全向感知,无扇形盲区);
 *           hasLineOfSight 占位恒 true(不判遮挡)——NPC 暂能"透视"。
 * 后续:hasLineOfSight 接入 rapier raycast 判断墙体/山体遮挡时,只改本函数,
 *       NpcController 无需改动(感知细节内聚于此)。
 *
 * 上下游:DirectorSystem 按 team 过滤出候选敌方后传给 NpcController;
 *         NpcController.scan 调用本模块选目标。
 */

/** 在候选中找感知范围内(水平距离)最近的存活目标。候选应由调用方按 team 预过滤 */
export function findNearestEnemy(
  self: IControllableTank,
  candidates: IControllableTank[],
  range: number,
): IControllableTank | undefined {
  const sp = self.body.translation();
  let best: IControllableTank | undefined;
  let bestD2 = range * range;
  for (const t of candidates) {
    if (t === self || t.state !== 'intact') continue;
    const tp = t.body.translation();
    const dx = tp.x - sp.x;
    const dz = tp.z - sp.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = t;
    }
  }
  return best;
}

/**
 * 视线检测:from 到 to 是否被遮挡。
 * 首期占位恒 true(无遮挡)——预留接口,后续接入 rapier castRay + collider
 * predicate 判断中间障碍(墙/山/树)。届时只改本函数体,NpcController 不动。
 */
export function hasLineOfSight(
  _physics: PhysicsWorld,
  _from: { x: number; y: number; z: number },
  _to: { x: number; y: number; z: number },
): boolean {
  return true;
}
