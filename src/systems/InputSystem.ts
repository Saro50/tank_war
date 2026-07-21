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
 *   切弹药：Tab             (cycleAmmo: 循环切换,可扩展不增键位)
 *   技能：⇧+1 过载 / ⇧+2 装甲 / ⇧+~ 侦查 (skill: Shift+数字组合)
 */
export interface InputState {
  forward: number;
  turn: number;
  turretDir: number;
  barrelDir: number;
  fire: boolean;
  /** Tab 循环切换弹药类型(边沿触发由消费方 WeaponSystem 做) */
  cycleAmmo: boolean;
  /** 当前按下的技能(Shift+数字组合);未按=null。SkillSystem 内部 CD 去重 */
  skill: SkillId | null;
  /** 鼠标在窗口客户区的像素坐标，供 HUD 准星使用 */
  mouseX: number;
  mouseY: number;
}

/** 阻止默认行为的键(防方向键滚动/Tab 切焦点/Space 滚动) */
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
 *
 * 技能用 Shift+数字组合:用 e.code(物理键码)而非 e.key(字符值)——
 * Shift+1 的 e.key='!' 而非 '1';e.code='Digit1' 不受 Shift 影响。
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
    log.info('input attached', { hint: '↑↓←→ 移动 / Q W 炮塔 / A S 炮管 / Space 开火 / Tab 切弹药 / ⇧1 ⇧2 ⇧~ 技能' });
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
      cycleAmmo: this.has('Tab'),
      // Shift+数字组合技能:用 e.code(Digit1/Digit2/Backquote)判定
      // Shift 改变 e.key 字符(1→!,`→~)但不改变 e.code,故用 code 不受影响
      skill: this.shiftHeld()
        ? this.has('Digit1') ? 'boost'
          : this.has('Digit2') ? 'armor'
          : this.has('Backquote') ? 'scout'
          : null
        : null,
      mouseX: this.mouseX,
      mouseY: this.mouseY,
    };
  }

  /** Shift 是否按下(左 Shift 或右 Shift 均可) */
  private shiftHeld(): boolean {
    return this.has('ShiftLeft') || this.has('ShiftRight');
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
