import type RAPIER from '@dimforge/rapier3d-compat';
import { Object3D, Quaternion, Vector3 } from 'three';
import { Logger } from '../utils/Logger';

const log = Logger.create('SyncBridge');

/**
 * 物理 → 渲染 同步桥
 * ============================================================
 * 核心架构约束（务必遵守）：
 *   物理层是「唯一真相源」，本桥是「单向只读」通道——
 *   每帧把刚体的位姿复制到对应网格，渲染层绝不反向写回物理。
 *
 * 为什么这样做：
 *   1. 视觉永不与物理错位（只要这里同步对，画面就对）；
 *   2. 出问题时只需查这一处，定位成本最低；
 *   3. 物理可独立于渲染运行/调试。
 *
 * 业务如何接入：
 *   创建实体时 SyncBridge.bind(body, mesh)；
 *   销毁实体时务必 SyncBridge.unbind(body)，否则访问已移除刚体会报错；
 *   每帧 SyncBridge.sync()（在 physics.step() 之后、render() 之前）。
 */
const registry = new Map<RAPIER.RigidBody, Object3D>();

// 复用临时对象，避免每帧 GC 压力（同步每帧高频调用）
const _pos = new Vector3();
const _quat = new Quaternion();

export const SyncBridge = {
  /** 绑定：一个刚体对应一个渲染网格。
   *  建立映射后立即同步一次位姿(syncOne)——防动态生成实体(NPC 补充生成/击毁碎片)
   *  在首帧 render 时 mesh 仍停留在世界原点 (0,0,0) 造成"闪现"。
   *  (spawn 在 director.update 内、即本帧 sync() 之后执行,若不立即对齐,
   *   要等下一帧 sync() 才会把 mesh 搬到 body 真实位置,中间一帧渲染错位。) */
  bind(body: RAPIER.RigidBody, obj: Object3D): void {
    if (registry.has(body)) {
      log.warn('bind: body already bound, overwriting');
    }
    registry.set(body, obj);
    this.syncOne(body);
  },

  /** 解绑：销毁实体前必须调用，防止悬空引用 */
  unbind(body: RAPIER.RigidBody): void {
    registry.delete(body);
  },

  /** 清空（场景重置时） */
  clear(): void {
    registry.clear();
  },

  /** 当前绑定数量（调试用） */
  get size(): number {
    return registry.size;
  },

  /**
   * 同步单个绑定:立即把 body 的位姿写入其 mesh。
   * ------------------------------------------------------------
   * bind 时自动调用(防动态生成实体首帧原点闪烁);
   * 也可独立调用以强制刷新单个实体的视觉位姿(调试/特殊场景用)。
   * body 未绑定则空转(防御,不抛异常——bind 前调用是合法的"预演"场景)。
   */
  syncOne(body: RAPIER.RigidBody): void {
    const obj = registry.get(body);
    if (!obj) return;
    const t = body.translation();
    const r = body.rotation();
    _pos.set(t.x, t.y, t.z);
    _quat.set(r.x, r.y, r.z, r.w);
    obj.position.copy(_pos);
    obj.quaternion.copy(_quat);
  },

  /** 每帧同步：遍历所有绑定调用 syncOne(复用单对同步逻辑,DRY) */
  sync(): void {
    for (const body of registry.keys()) this.syncOne(body);
  },
};
