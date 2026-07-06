import type { AmmoType } from '../config';
import type { SkillId } from './SkillSystem';
import { Logger } from '../utils/Logger';

const log = Logger.create('Input');

/**
 * 输入状态快照
 * ------------------------------------------------------------
 * 控制映射：
 *   移动：↑前进 ↓后退 ←左转 →右转
 *   炮塔：Q 左转 / W 右转   (turretDir: +1=右 -1=左)
 *   炮管：A 抬起 / S 放下   (barrelDir: +1=抬 -1=放)
 *   开火：Space             (fire: 是否按下)
 *   切换：Tab               (switchNext: 是否按下，需边沿触发)
 *   选弹：1 穿甲弹 / 2 高爆弹 (switchAmmo: 当前按下的弹种;WeaponSystem 内部去重)
 *   技能：E 维修 / R 引擎过载 / F 装甲倾斜 (skill: 当前按下的技能;SkillSystem 内部 CD 去重)
 */
export interface InputState {
  forward: number;
  turn: number;
  turretDir: number;
  barrelDir: number;
  fire: boolean;
  switchNext: boolean;
  /** 当前按下的弹种(1=AP/2=HE),未按=null。WeaponSystem.switchAmmo 内部按"同弹种不切"去重 */
  switchAmmo: AmmoType | null;
  /** 当前按下的技能(E/R/F),未按=null。SkillSystem.tryActivate 内部按 CD/激活去重 */
  skill: SkillId | null;
  /** 鼠标在窗口客户区的像素坐标，供 HUD 准星使用 */
  mouseX: number;
  mouseY: number;
}

const BLOCKED_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Tab',
  'Space',
]);

/**
 * 键盘输入系统
 * ------------------------------------------------------------
 * 监听全局 keydown/keyup，对外提供统一 InputState 快照。
 * 失焦清空按键，防止切窗口后"按键卡住"。
 */
export class InputSystem {
  private keys = new Set<string>();
  private attached = false;
  private mouseX = 0;
  private mouseY = 0;

  attach(): void {
    if (this.attached) {
      log.warn('already attached, ignore');
      return;
    }
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    window.addEventListener('mousemove', this.onMouseMove);
    this.attached = true;
    log.info('input attached', { hint: '↑↓←→ 移动 / Q W 炮塔 / A S 炮管 / Space 开火 / 1 2 选弹 / E R F 技能 / Tab 切换坦克' });
  }

  /** 解绑监听器(场景重置/卸载用)，防 hot-reload 后重复监听与按键卡住 */
  detach(): void {
    if (!this.attached) return;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    window.removeEventListener('mousemove', this.onMouseMove);
    this.keys.clear();
    this.attached = false;
    log.debug('input detached');
  }

  get state(): InputState {
    return {
      forward: (this.has('ArrowUp') ? 1 : 0) - (this.has('ArrowDown') ? 1 : 0),
      turn: (this.has('ArrowRight') ? 1 : 0) - (this.has('ArrowLeft') ? 1 : 0),
      turretDir: (this.has('KeyW') ? 1 : 0) - (this.has('KeyQ') ? 1 : 0),
      barrelDir: (this.has('KeyA') ? 1 : 0) - (this.has('KeyS') ? 1 : 0),
      fire: this.has('Space'),
      switchNext: this.has('Tab'),
      switchAmmo: this.has('Digit1') ? 'ap' : this.has('Digit2') ? 'he' : null,
      skill: this.has('KeyE') ? 'repair' : this.has('KeyR') ? 'boost' : this.has('KeyF') ? 'armor' : null,
      mouseX: this.mouseX,
      mouseY: this.mouseY,
    };
  }

  private has(code: string): boolean {
    return this.keys.has(code);
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    // 防方向键/空格/Tab 触发浏览器默认行为（滚动、切焦点）
    if (BLOCKED_KEYS.has(e.code)) e.preventDefault();
    this.keys.add(e.code);
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private onBlur = (): void => {
    this.keys.clear();
    log.debug('window blur, keys cleared');
  };

  private onMouseMove = (e: MouseEvent): void => {
    this.mouseX = e.clientX;
    this.mouseY = e.clientY;
  };
}
