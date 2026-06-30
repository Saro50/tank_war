import type { IControllableTank } from '../entities/IControllableTank';
import { Logger } from '../utils/Logger';

const log = Logger.create('TankSwitch');

/**
 * 坦克切换器
 * ------------------------------------------------------------
 * 维护所有可附身坦克列表，按 Tab 在完好坦克之间循环切换当前受控单位。
 * 切换时触发回调，由 main 统一更新 controller / weapon / destruction / hud。
 */
export class TankSwitcher {
  private readonly tanks: IControllableTank[];
  private activeIndex: number;
  /** 切换回调：参数为 (newTank, oldTank) */
  onSwitch?: (newTank: IControllableTank, oldTank: IControllableTank) => void;

  constructor(tanks: IControllableTank[], startIndex = 0) {
    this.tanks = tanks;
    this.activeIndex = this.clampAlive(startIndex);
    log.info('switcher ready', { active: this.activeTank.name });
  }

  get activeTank(): IControllableTank {
    return this.tanks[this.activeIndex];
  }

  /** 切换到下一辆完好坦克 */
  next(): void {
    this.switchTo(this.findNext(this.activeIndex + 1, 1));
  }

  /** 切换到上一辆完好坦克 */
  prev(): void {
    this.switchTo(this.findNext(this.activeIndex - 1, -1));
  }

  private switchTo(index: number): void {
    if (index === this.activeIndex) return;
    const oldTank = this.activeTank;
    const newTank = this.tanks[index];
    this.activeIndex = index;
    log.info('switch tank', { from: oldTank.name, to: newTank.name });
    this.onSwitch?.(newTank, oldTank);
  }

  /** 从 startIdx 开始沿 direction 寻找下一辆完好坦克；找不到返回当前索引 */
  private findNext(startIdx: number, direction: 1 | -1): number {
    const n = this.tanks.length;
    if (n === 0) return this.activeIndex;
    let idx = ((startIdx % n) + n) % n;
    for (let i = 0; i < n; i++) {
      if (this.tanks[idx].state === 'intact') return idx;
      idx = ((idx + direction) % n + n) % n;
    }
    return this.activeIndex;
  }

  private clampAlive(index: number): number {
    const n = this.tanks.length;
    if (n === 0) return 0;
    const start = ((index % n) + n) % n;
    for (let i = 0; i < n; i++) {
      const idx = ((start + i) % n + n) % n;
      if (this.tanks[idx].state === 'intact') return idx;
    }
    return 0;
  }
}
