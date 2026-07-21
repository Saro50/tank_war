import type { DirectorSystem } from '../systems/DirectorSystem';
import type { IControllableTank } from '../entities/IControllableTank';
import { CONFIG, type NpcTier } from '../config';
import { Logger } from './Logger';

const log = Logger.create('Debug');

/** 浏览器控制台生成敌坦的参数(全可选,缺省用默认) */
interface SpawnOpts {
  /** 型号;缺省随机 tiger/abrams */
  variant?: 'tiger' | 'abrams';
  /** 难度;缺省随机 rookie/regular/veteran */
  tier?: NpcTier;
  /** 生成位置 x;缺省=玩家朝向前方 30m */
  x?: number;
  /** 生成位置 z;缺省=玩家朝向前方 30m */
  z?: number;
}

/** 暴露到 window 的调试 API 形状 */
interface DebugApi {
  spawnEnemy: (opts?: SpawnOpts) => void;
  revive: () => void;
  hp: (value?: number) => void;
  help: () => void;
}

/**
 * 浏览器调试控制台(便于调试 NPC 难度/玩家状态)。
 * ============================================================
 * 构造时把 API 暴露到 window.tw / window.tankWar,在 DevTools Console 调用:
 *   tw.spawnEnemy({variant:'tiger', tier:'veteran', x:0, z:30})  在指定位置生成敌坦
 *   tw.spawnEnemy()                  随机型号/tier,生成在玩家前方
 *   tw.revive()                      复活玩家(被毁→满血,焦黑残留不影响驾驶)
 *   tw.hp()                          查询玩家血量
 *   tw.hp(30)                        设置玩家血量(下限 0,可超出 maxHp)
 *   tw.help()                        帮助
 *
 * 设计:薄封装,委托 DirectorSystem.spawnEnemyAt / IControllableTank.revive|setDebugHp,
 *      不引入新业务逻辑,仅作运行时调试入口。
 */
export class DebugConsole {
  constructor(
    private readonly director: DirectorSystem,
    private readonly getPlayer: () => IControllableTank | undefined,
  ) {
    const api: DebugApi = {
      spawnEnemy: (opts) => this.spawnEnemy(opts),
      revive: () => this.revive(),
      hp: (value) => this.hp(value),
      help: () => this.help(),
    };
    // 双名:tw(短,常用)/tankWar(长,自描述)
    Object.assign(globalThis as Record<string, unknown>, { tw: api, tankWar: api });
    log.info('debug console ready', { hint: '控制台输入 tw.help() 查看调试命令' });
  }

  /**
   * 生成敌方坦克。参数全可选:缺省位置=玩家前方 30m,型号/tier 随机。
   * 委托 director.spawnEnemyAt(与波次生成同一入口,行为/接入完全一致)。
   */
  private spawnEnemy(opts?: SpawnOpts): void {
    const player = this.getPlayer();
    // 默认位置:玩家朝向前方 30m(避免生成在玩家身上)
    let x = 0;
    let z = 30;
    if (opts?.x !== undefined && opts?.z !== undefined) {
      x = opts.x;
      z = opts.z;
    } else if (player) {
      const p = player.body.translation();
      const q = player.body.rotation();
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.z * q.z));
      x = p.x + Math.sin(yaw) * 30;
      z = p.z + Math.cos(yaw) * 30;
    }
    const variant = opts?.variant ?? (Math.random() < 0.5 ? 'tiger' : 'abrams');
    const tiers: NpcTier[] = ['rookie', 'regular', 'veteran'];
    const tier = opts?.tier ?? tiers[Math.floor(Math.random() * 3)];
    this.director.spawnEnemyAt({ variant, tier, x, z });
    console.log(`[tw] 生成 ${variant}(${tier}) @ ${x.toFixed(0)},${z.toFixed(0)}`);
  }

  /** 复活玩家坦克(被毁→满血,清冒烟;焦黑视觉残留不影响驾驶) */
  private revive(): void {
    const player = this.getPlayer();
    if (!player) {
      console.warn('[tw] 玩家坦克不存在');
      return;
    }
    if (player.state === 'intact') {
      console.log('[tw] 玩家未死亡,无需复活');
      return;
    }
    player.revive();
    console.log(`[tw] 玩家已复活,HP=${player.getHp().toFixed(0)}`);
  }

  /** 查询/设置玩家血量。无参=查询,有参=设置(下限 0,可超出正常 maxHp)。 */
  private hp(value?: number): void {
    const player = this.getPlayer();
    if (!player) {
      console.warn('[tw] 玩家坦克不存在');
      return;
    }
    if (value === undefined) {
      console.log(`[tw] 玩家 HP = ${player.getHp().toFixed(0)} / ${CONFIG.tank.damage.maxHp}`);
      return;
    }
    player.setDebugHp(value);
    console.log(`[tw] 玩家 HP 设为 ${player.getHp().toFixed(0)} (正常 maxHp=${CONFIG.tank.damage.maxHp})`);
  }

  private help(): void {
    console.log(`[tw] 调试命令:
  tw.spawnEnemy({variant:'tiger'|'abrams', tier:'rookie'|'regular'|'veteran', x, z})
      生成敌坦(参数均可选;缺省随机型号/tier、玩家前方30m)
  tw.revive()         复活玩家(满血,焦黑残留不影响驾驶)
  tw.hp()             查询玩家血量
  tw.hp(30)           设置玩家血量(下限 0,可超出 maxHp)
  tw.help()           本帮助`);
  }
}
