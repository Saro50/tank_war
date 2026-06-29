import { Logger } from '../utils/Logger';

const log = Logger.create('HUD');

/**
 * 平视显示器(HUD)
 * ------------------------------------------------------------
 * 职责：屏幕层 UI 元素（准星等），用 DOM 而非 Three 内绘制——
 * 原因：准星是 2D 像素精确元素，DOM 方式最锐利、最易调样式，
 *       且不占用 canvas 绘制开销。
 *
 * M2 仅含准星；M3 起补充弹药数/命中提示。
 */
export class HUD {
  private readonly crosshair: HTMLDivElement;
  private mounted = false;

  constructor(container: HTMLElement) {
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'tw-crosshair';
    this.crosshair.innerHTML = crosshairSVG;
    Object.assign(this.crosshair.style, crosshairStyle);
    container.appendChild(this.crosshair);
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
