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
  /** 绑定：一个刚体对应一个渲染网格 */
  bind(body: RAPIER.RigidBody, obj: Object3D): void {
    if (registry.has(body)) {
      log.warn('bind: body already bound, overwriting');
    }
    registry.set(body, obj);
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

  /** 每帧同步：把所有绑定刚体的位姿写入网格 */
  sync(): void {
    for (const [body, obj] of registry) {
      const t = body.translation();
      const r = body.rotation();
      _pos.set(t.x, t.y, t.z);
      _quat.set(r.x, r.y, r.z, r.w);
      obj.position.copy(_pos);
      obj.quaternion.copy(_quat);
    }
  },
};
