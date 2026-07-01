import type { IControllableTank } from '../entities/IControllableTank';
import { Logger } from '../utils/Logger';

const log = Logger.create('HUD');

/**
 * 平视显示器(HUD)
 * ------------------------------------------------------------
 * 职责：屏幕层 UI 元素（准星、当前坦克信息等），用 DOM 而非 Three 内绘制——
 * 原因：准星是 2D 像素精确元素，DOM 方式最锐利、最易调样式，
 *       且不占用 canvas 绘制开销。
 *
 * M2 仅含准星；M3 起补充弹药数/命中提示；调试模式补充当前附身坦克名称/HP。
 */
export class HUD {
  private readonly crosshair: HTMLDivElement;
  private readonly tankInfo: HTMLDivElement;
  private readonly ammoInfo: HTMLDivElement;
  private mounted = false;

  constructor(container: HTMLElement) {
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'tw-crosshair';
    this.crosshair.innerHTML = crosshairSVG;
    Object.assign(this.crosshair.style, crosshairStyle);
    container.appendChild(this.crosshair);

    this.tankInfo = document.createElement('div');
    Object.assign(this.tankInfo.style, tankInfoStyle);
    this.tankInfo.textContent = '';
    container.appendChild(this.tankInfo);

    // 弹药信息(右下角):弹药数 + 低弹药预警 + 耗尽闪烁 + 装填提示
    this.ammoInfo = document.createElement('div');
    Object.assign(this.ammoInfo.style, ammoInfoStyle);
    this.ammoInfo.textContent = '';
    container.appendChild(this.ammoInfo);

    // 耗尽闪烁动画(注入一次性 <style>;用视觉强引导"必须去补给")
    const styleEl = document.createElement('style');
    styleEl.textContent =
      '@keyframes tw-blink{0%,100%{opacity:1}50%{opacity:0.25}}.tw-blink{animation:tw-blink 0.6s steps(2) infinite}';
    container.appendChild(styleEl);

    this.mounted = true;
    log.info('HUD ready');
  }

  /**
   * 更新准星到鼠标屏幕位置
   * @param clientX/Y 鼠标 client 坐标（像素）
   */
  setCrosshair(clientX: number, clientY: number): void {
    if (!this.mounted) return;
    // 用 transform 而非 left/top，性能更好（不触发布局）
    this.crosshair.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
  }

  /**
   * 每帧更新当前附身坦克信息。
   * @param ammo 弹药信息(可选,main 从玩家 weapon 读取传入);缺省则不显示弹药(兼容旧调用)。
   */
  update(tank: IControllableTank, ammo?: { current: number; max: number; resupplying: boolean }): void {
    if (!this.mounted) return;
    const hp = Math.max(0, tank.getHp());
    const state = tank.state === 'intact' ? '完好' : '已击毁';
    this.tankInfo.textContent = `${tank.name}  |  HP ${hp}  |  ${state}`;

    // 弹药状态(视觉引导:满=白 / 低=橙 / 耗尽=红闪烁 / 装填=绿)
    if (ammo) {
      const empty = ammo.current < 1;
      const resupplying = ammo.resupplying && !empty;
      if (empty) {
        this.ammoInfo.textContent = '弹药耗尽 — 前往补给点装填';
        this.ammoInfo.style.color = '#ff5252';
        this.ammoInfo.classList.add('tw-blink'); // 闪烁强引导
      } else if (resupplying) {
        this.ammoInfo.textContent = `装填中  ${ammo.current} / ${ammo.max}`;
        this.ammoInfo.style.color = '#7fff7f';
        this.ammoInfo.classList.remove('tw-blink');
      } else {
        this.ammoInfo.textContent = `弹药  ${ammo.current} / ${ammo.max}`;
        this.ammoInfo.style.color = ammo.current <= 5 ? '#ffaa33' : '#e6e6e6'; // 低弹药橙色预警
        this.ammoInfo.classList.remove('tw-blink');
      }
    } else {
      this.ammoInfo.textContent = '';
      this.ammoInfo.classList.remove('tw-blink');
    }
  }
}

// 准星 SVG：中心点 + 四角刻度，瞄准时视觉清晰
const crosshairSVG = `
<svg width="44" height="44" viewBox="0 0 44 44" xmlns="http://www.w3.org/2000/svg">
  <circle cx="22" cy="22" r="2" fill="#ff5252"/>
  <g stroke="#ff5252" stroke-width="2" fill="none" opacity="0.9">
    <line x1="22" y1="4"  x2="22" y2="12"/>
    <line x1="22" y1="32" x2="22" y2="40"/>
    <line x1="4"  y1="22" x2="12" y2="22"/>
    <line x1="32" y1="22" x2="40" y2="22"/>
  </g>
</svg>`;

const crosshairStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  left: '0',
  top: '0',
  pointerEvents: 'none', // 准星不拦截鼠标，否则无法点中画布
  zIndex: '10',
  willChange: 'transform',
};

const tankInfoStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  top: '12px',
  left: '12px',
  zIndex: '10',
  pointerEvents: 'none',
  fontFamily: 'monospace',
  fontSize: '14px',
  color: '#e6e6e6',
  background: 'rgba(20,22,28,0.75)',
  padding: '6px 10px',
  borderRadius: '6px',
  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
};

const ammoInfoStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  bottom: '12px',
  right: '12px',
  zIndex: '10',
  pointerEvents: 'none',
  fontFamily: 'monospace',
  fontSize: '15px',
  fontWeight: 'bold',
  color: '#e6e6e6',
  background: 'rgba(20,22,28,0.75)',
  padding: '6px 12px',
  borderRadius: '6px',
  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
};
