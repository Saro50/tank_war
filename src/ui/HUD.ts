import type { AmmoType } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { Objective } from '../systems/Objective';
import type { SkillId } from '../systems/SkillSystem';
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
  private readonly ammoInfo: HTMLDivElement;
  private readonly killText: HTMLDivElement;
  private readonly killBarInner: HTMLDivElement;
  /** 技能栏 3 格(M3):维修/过载/装甲,按 E/R/F 激活 */
  private readonly skillCells: HTMLDivElement[] = [];
  private mounted = false;

  constructor(container: HTMLElement) {
    this.crosshair = document.createElement('div');
    this.crosshair.className = 'tw-crosshair';
    this.crosshair.innerHTML = crosshairSVG;
    Object.assign(this.crosshair.style, crosshairStyle);
    container.appendChild(this.crosshair);

    // 弹药信息(右下角):弹药数 + 低弹药预警 + 耗尽闪烁 + 装填提示
    this.ammoInfo = document.createElement('div');
    Object.assign(this.ammoInfo.style, ammoInfoStyle);
    this.ammoInfo.textContent = '';
    container.appendChild(this.ammoInfo);

    // 技能栏(M3,弹药栏上方):3 格 维修/过载/装甲,按 E/R/F 激活。
    // 状态视觉引导:激活=金色 ● / 可用=绿色 ✓ / 冷却中=灰色+百分比
    const skillBar = document.createElement('div');
    Object.assign(skillBar.style, skillBarStyle);
    for (const m of SKILL_META) {
      const cell = document.createElement('div');
      Object.assign(cell.style, skillCellStyle);
      cell.textContent = `${m.key} ${m.label}`;
      skillBar.appendChild(cell);
      this.skillCells.push(cell);
    }
    container.appendChild(skillBar);

    // 耗尽闪烁动画(注入一次性 <style>;用视觉强引导"必须去补给")
    const styleEl = document.createElement('style');
    styleEl.textContent =
      '@keyframes tw-blink{0%,100%{opacity:1}50%{opacity:0.25}}.tw-blink{animation:tw-blink 0.6s steps(2) infinite}';
    container.appendChild(styleEl);

    // 目标进度(左上 tankInfo 下方):击毁 X/N + 进度条。数据驱动(读 Objective 通用字段)
    const killInfo = document.createElement('div');
    Object.assign(killInfo.style, killInfoStyle);
    this.killText = document.createElement('div');
    killInfo.appendChild(this.killText);
    const barOuter = document.createElement('div');
    Object.assign(barOuter.style, barOuterStyle);
    this.killBarInner = document.createElement('div');
    Object.assign(this.killBarInner.style, barInnerStyle);
    barOuter.appendChild(this.killBarInner);
    killInfo.appendChild(barOuter);
    container.appendChild(killInfo);

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
   *             含 AP/HE 各自库存 + 当前选种(HUD 高亮选种)。
   */
  update(
    _tank: IControllableTank,
    ammo?: {
      ap: number;
      he: number;
      maxAp: number;
      maxHe: number;
      /** 当前选弹(HUD 用方括号高亮该栏) */
      selected: AmmoType;
      resupplying: boolean;
    },
    objective?: Objective,
    /** 技能栏数据(M3,顺序 repair/boost/armor);缺省不更新技能栏 */
    skills?: ReadonlyArray<{ id: SkillId; cdRatio: number; active: boolean }>,
  ): void {
    if (!this.mounted) return;

    // 弹药状态(三栏:AP/HE 各自库存,当前选种用方括号高亮;空仓弹种加 ⚠;选种耗尽强提示)
    if (ammo) {
      const apEmpty = ammo.ap < 1;
      const heEmpty = ammo.he < 1;
      const selEmpty = ammo.selected === 'ap' ? apEmpty : heEmpty;
      if (selEmpty) {
        // 当前选种耗尽:红闪烁强引导(切换弹种或回补给)
        this.ammoInfo.textContent = `${ammo.selected.toUpperCase()} 弹耗尽 — 切换弹种(1/2)或前往补给点`;
        this.ammoInfo.style.color = '#ff5252';
        this.ammoInfo.classList.add('tw-blink');
      } else if (ammo.resupplying) {
        this.ammoInfo.textContent = `装填中  AP ${ammo.ap}/${ammo.maxAp} │ HE ${ammo.he}/${ammo.maxHe}`;
        this.ammoInfo.style.color = '#7fff7f';
        this.ammoInfo.classList.remove('tw-blink');
      } else {
        // 三栏:选种用 [方括号] 高亮;空仓弹种前加 ⚠ 提醒;低弹药(≤3)橙色预警
        const apLow = ammo.ap <= 3;
        const heLow = ammo.he <= 3;
        const apStr = `${apEmpty ? '⚠ ' : ''}AP ${ammo.ap}/${ammo.maxAp}`;
        const heStr = `${heEmpty ? '⚠ ' : ''}HE ${ammo.he}/${ammo.maxHe}`;
        const apPart = ammo.selected === 'ap' ? `[${apStr}]` : apStr;
        const hePart = ammo.selected === 'he' ? `[${heStr}]` : heStr;
        this.ammoInfo.textContent = `${apPart}   │   ${hePart}`;
        this.ammoInfo.style.color = apLow || heLow ? '#ffaa33' : '#e6e6e6';
        this.ammoInfo.classList.remove('tw-blink');
      }
    } else {
      this.ammoInfo.textContent = '';
      this.ammoInfo.classList.remove('tw-blink');
    }

    // 目标进度(数据驱动:Objective 通用字段 progress/target/type)
    // 占领军(type='capture'):显示百分比 + 进度条蓝色(与据点玩家色一致);
    // 歼灭战(type='kill'):显示 X/N + 进度条黄色。
    if (objective) {
      const ratio = objective.target > 0 ? objective.progress / objective.target : 0;
      if (objective.type === 'capture') {
        const pct = Math.round(ratio * 100);
        this.killText.textContent = `占领 ${pct}%`;
        this.killBarInner.style.background = '#4a8aff'; // 玩家蓝(与据点配色一致)
      } else {
        this.killText.textContent = `击毁 ${objective.progress}/${objective.target}`;
        this.killBarInner.style.background = '#ffcc33'; // 歼灭战黄
      }
      this.killBarInner.style.width = `${Math.min(100, ratio * 100)}%`;
    } else {
      this.killText.textContent = '';
      this.killBarInner.style.width = '0%';
    }

    // 技能栏(M3):按顺序更新 3 格状态(激活=金色● / 可用=绿色 / 冷却中=灰色+百分比)
    if (skills) {
      for (let i = 0; i < this.skillCells.length; i++) {
        const cell = this.skillCells[i];
        const s = skills[i];
        if (!s) continue;
        const meta = SKILL_META[i];
        if (s.active) {
          cell.style.background = '#b8860b';
          cell.style.color = '#fff';
          cell.textContent = `${meta.key} ${meta.label} ●`;
        } else if (s.cdRatio >= 1) {
          cell.style.background = 'rgba(40,110,40,0.75)';
          cell.style.color = '#e6e6e6';
          cell.textContent = `${meta.key} ${meta.label}`;
        } else {
          cell.style.background = 'rgba(20,22,28,0.75)';
          cell.style.color = '#888';
          cell.textContent = `${meta.key} ${meta.label} ${Math.round(s.cdRatio * 100)}%`;
        }
      }
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

const killInfoStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  top: '44px',
  left: '12px',
  zIndex: '10',
  pointerEvents: 'none',
  fontFamily: 'monospace',
  fontSize: '14px',
  fontWeight: 'bold',
  color: '#ffcc33',
  background: 'rgba(20,22,28,0.75)',
  padding: '6px 10px',
  borderRadius: '6px',
  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
  minWidth: '140px',
};

const barOuterStyle: Partial<CSSStyleDeclaration> = {
  marginTop: '5px',
  width: '100%',
  height: '6px',
  background: 'rgba(255,255,255,0.12)',
  borderRadius: '3px',
  overflow: 'hidden',
};

const barInnerStyle: Partial<CSSStyleDeclaration> = {
  width: '0%',
  height: '100%',
  background: '#ffcc33',
  borderRadius: '3px',
  transition: 'width 0.3s ease',
};

/** 技能栏元数据(M3):顺序必须与 SkillId(repair/boost/armor)及 main 传入 skills 数组一致 */
const SKILL_META = [
  { key: 'E', label: '维修' }, // repair
  { key: 'R', label: '过载' }, // boost
  { key: 'F', label: '装甲' }, // armor
] as const;

/** 技能栏容器:右下角,弹药栏上方,水平排列 3 格 */
const skillBarStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  bottom: '52px', // 弹药栏(bottom:12px + 高约30)上方留空
  right: '12px',
  zIndex: '10',
  pointerEvents: 'none',
  display: 'flex',
  gap: '6px',
};

/** 技能格:按键+名称+状态。颜色随状态变(激活金/可用绿/冷却灰) */
const skillCellStyle: Partial<CSSStyleDeclaration> = {
  fontFamily: 'monospace',
  fontSize: '13px',
  fontWeight: 'bold',
  color: '#e6e6e6',
  background: 'rgba(20,22,28,0.75)',
  padding: '5px 9px',
  borderRadius: '6px',
  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
  minWidth: '66px',
  textAlign: 'center',
};
