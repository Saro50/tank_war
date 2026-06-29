import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import { Logger } from '../utils/Logger';

const log = Logger.create('PhysicsWorld');

/** 标记 wasm 是否已初始化（整进程一次） */
let initialized = false;

/**
 * 物理世界封装
 * ------------------------------------------------------------
 * 全应用唯一持有 Rapier World 的入口。所有实体均通过本模块创建
 * 刚体与碰撞体，由此保证：
 *   - 物理状态只有「一个真相源」；
 *   - 渲染层只能读取位姿、绝不反向写回。
 *
 * 业务如何接入：
 *   const physics = await PhysicsWorld.create();   // 启动时一次
 *   const body = physics.world.createRigidBody(...);
 *   每帧 physics.step() 后由 SyncBridge 读 body 位姿刷给网格。
 */
export class PhysicsWorld {
  readonly world: RAPIER.World;
  /** 碰撞事件队列：M3 起用于命中判定 / 破坏触发 */
  readonly eventQueue: RAPIER.EventQueue;

  private constructor(world: RAPIER.World) {
    this.world = world;
    // true = 同时收集 contact(接触) 与 intersection(穿透) 事件
    this.eventQueue = new RAPIER.EventQueue(true);
  }

  /**
   * 异步初始化（需加载 wasm）。整个应用生命周期仅调用一次。
   * 失败直接抛错——绝不静默（引擎起不来后续都无意义）。
   */
  static async create(): Promise<PhysicsWorld> {
    if (initialized) {
      // 重复初始化多半是调用错误，明确抛出便于定位
      throw new Error('PhysicsWorld already initialized');
    }
    try {
      await RAPIER.init();
      initialized = true;
    } catch (e) {
      log.error('rapier wasm init failed', e);
      throw e;
    }

    const world = new RAPIER.World(CONFIG.physics.gravity);
    // 固定步长：与 CONFIG.loop.fixedTimeStep 对齐，
    // 即便主循环按真实帧率累积，单步物理仍以该步长推进，结果确定性可复现。
    world.integrationParameters.dt = CONFIG.loop.fixedTimeStep;

    log.info('rapier world ready', {
      gravity: CONFIG.physics.gravity,
      dt: CONFIG.loop.fixedTimeStep,
    });
    return new PhysicsWorld(world);
  }

  /** 推进一帧物理模拟（内部按已设定的固定步长） */
  step(): void {
    this.world.step(this.eventQueue);
  }
}
