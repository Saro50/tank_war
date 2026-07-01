import type { IControllableTank } from '../entities/IControllableTank';
import type { ResupplyPoint } from '../entities/ResupplyPoint';
import type { WeaponSystem } from './WeaponSystem';

/** 已注册的待装填坦克(坦克提供者 + 其武器系统) */
interface RegisteredTank {
  /** 坦克提供者:玩家 Tab 切换时动态返回当前 activeTank;NPC 固定返回自身 */
  getTank: () => IControllableTank;
  weapon: WeaponSystem;
}

/**
 * 补给/装填系统(M5)
 * ============================================================
 * 职责:
 *  1. 持有所有补给点,每帧推进其生命周期(被毁后的再生倒计时 + 标识旋转)。
 *  2. 装填判定:对每辆已注册坦克,检查是否驶入任一【可用】补给点半径内,
 *     是则调 weapon.resupply(dt) 自动回弹(无需按键)。
 *  3. 提供 nearestActivePoint():供 NpcController 导航到最近可用补给点。
 *
 * 注册来源:
 *  - 玩家:main 创建后 register(playerTank, playerWeapon)。
 *  - NPC:DirectorSystem.initNpcs 创建每个 NPC 时 register(由 main 把本系统传给 director)。
 *
 * 时序(main 主循环):physics.step 之后、render 之前调 update——
 *  用最新同步的坦克位置做装填判定(位置已由 SyncBridge 刷过)。
 *
 * 设计:坦克与武器解耦——本系统只认 (tank 位置, weapon 弹药) 两个接口,
 *  不关心坦克型号/NPC或玩家,统一装填逻辑。
 */
export class ResupplySystem {
  private points: ResupplyPoint[] = [];
  private tanks: RegisteredTank[] = [];

  /** 注册补给点(同时应由 main 调 destruction.addResupplyPoint 接入伤害链) */
  addPoint(rp: ResupplyPoint): void {
    this.points.push(rp);
  }

  /**
   * 注册一辆待装填坦克(玩家或 NPC)。
   * @param tankOrGetter 坦克对象(NPC,固定) 或 坦克提供者(玩家,切换时动态)。
   *  玩家用 getter:Tab 切换附身坦克后,装填自动跟随新的 activeTank。
   */
  register(tankOrGetter: IControllableTank | (() => IControllableTank), weapon: WeaponSystem): void {
    const getTank =
      typeof tankOrGetter === 'function'
        ? (tankOrGetter as () => IControllableTank)
        : () => tankOrGetter;
    this.tanks.push({ getTank, weapon });
  }

  /** 每帧:补给点生命周期 + 装填判定 */
  update(dt: number): void {
    // 1. 补给点更新(destroyed 倒计时再生;intact 标识旋转)
    for (const rp of this.points) rp.update(dt);

    // 2. 装填判定:坦克驶入任一可用补给点半径内 → 自动回弹
    for (const { getTank, weapon } of this.tanks) {
      const tank = getTank();
      if (tank.state !== 'intact') continue;
      if (weapon.getAmmo() >= weapon.getMaxAmmo()) continue; // 满弹药不装填(省调用)
      const p = tank.body.translation();
      for (const rp of this.points) {
        if (rp.contains({ x: p.x, z: p.z })) {
          weapon.resupply(dt);
          break; // 在一个补给点范围内即装填,无需叠加多源
        }
      }
    }
  }

  /**
   * 最近【可用】补给点位置(NPC 导航用)。
   * 摧毁中的(destroyed)补给点不计——NPC 不会白跑去一个被毁的点。
   * @returns 最近可用补给点位置;全部被毁时返回 undefined(等再生)。
   */
  nearestActivePoint(pos: { x: number; z: number }): { x: number; z: number } | undefined {
    let best: { x: number; z: number } | undefined;
    let bestD2 = Infinity;
    for (const rp of this.points) {
      if (rp.state !== 'intact') continue;
      const p = rp.position;
      const d2 = (p.x - pos.x) ** 2 + (p.z - pos.z) ** 2;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = p;
      }
    }
    return best;
  }

  /** 诊断 */
  get stats(): { points: number; activePoints: number; tanks: number } {
    let activePoints = 0;
    for (const rp of this.points) if (rp.state === 'intact') activePoints++;
    return { points: this.points.length, activePoints, tanks: this.tanks.length };
  }
}
