import RAPIER from '@dimforge/rapier3d-compat';
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
 * 视线检测:observer 到 target 之间是否有障碍(建筑/树/山/坦克)遮挡。
 * ------------------------------------------------------------
 * 从观察者炮塔中部(y=1.5)水平射射线,命中中间 collider(toi < 距离-容差)
 * 即视为遮挡。排除观察者自身 body 防自射;目标 body 命中在终点附近
 * (toi≈距离)不算挡。
 *
 * 用于:NPC engage 判定/开火时机(不透视打墙后目标);
 *       配合玩家躲建筑后脱战回血(NPC 看不见就不打)。
 */
export function hasLineOfSight(
  physics: PhysicsWorld,
  observer: IControllableTank,
  target: IControllableTank,
): boolean {
  const from = observer.body.translation();
  const to = target.body.translation();
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const hDist = Math.hypot(dx, dz);
  if (hDist < 0.5) return true; // 太近视为可见(避免除零/自身重叠)
  const dir = { x: dx / hDist, y: 0, z: dz / hDist }; // 水平单位向量
  // 射线起点抬高到炮塔中部,避免贴地误判地面 collider
  const origin = { x: from.x, y: 1.5, z: from.z };
  const ray = new RAPIER.Ray(origin, dir);
  // 排除 observer 自身 body(防起点在自身 collider 内被命中)。
  // castRay 返回 RayColliderHit(含 .collider):若命中 target 自身 collider
  //  = target 前缘(不挡自己)= 通畅;命中其他 = 中间障碍 = 被挡。精确无容差。
  const hit = physics.world.castRay(ray, hDist, true, undefined, undefined, undefined, observer.body);
  if (hit === null) return true; // 未命中任何 collider(到 maxToi 无障碍) = 通畅
  return hit.collider.handle === target.colliderHandle; // 命中 target 自己=通畅,否则被挡
}
