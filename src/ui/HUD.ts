import type { AmmoType } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { Objective } from '../systems/Objective';
import type { SkillId } from '../systems/SkillSystem';
import { Logger } from '../utils/Logger';

const log = Logger.create('HUD');

// ============================================================
// 弹药 / 技能 元数据
// ============================================================

/** 弹药循环顺序(与 WeaponSystem.AMMO_ORDER 一致;Tab 按此顺序循环) */
const AMMO_ORDER: AmmoType[] = ['he', 'ap'];

/** 弹药类型元数据:名称/图标/颜色/徽章。新增弹种只需往此加一项 + AMMO_ORDER 加一项 */
const AMMO_META: Record<AmmoType, { name: string; icon: string; color: string; badge?: string }> = {
  he: { name: 'HE 高爆弹', icon: 'tw-ico-he', color: '#ffaa33' },
  ap: { name: 'AP 穿甲弹', icon: 'tw-ico-ap', color: '#e6e6e6', badge: '有限' },
};

/** 技能栏元数据:顺序必须与 SkillId(boost/armor/scout)及 main 传入 skills 数组一致 */
const SKILL_META = [
  { key: '⇧1', label: '过载', icon: 'tw-ico-boost' },
  { key: '⇧2', label: '装甲', icon: 'tw-ico-armor' },
  { key: '⇧~', label: '侦查', icon: 'tw-ico-scout' },
] as const;

// ============================================================
// SVG 图标定义(注入一次,各处用 <use> 引用)
// ============================================================

const SVG_DEFS = `
<svg style="position:absolute;width:0;height:0" aria-hidden="true">
  <defs>
    <symbol id="tw-ico-he" viewBox="0 0 24 24">
      <path d="M12 3 C8.5 3 8 6.5 8 9 L8 15 L16 15 L16 9 C16 6.5 15.5 3 12 3 Z" fill="currentColor"/>
      <rect x="7" y="15" width="10" height="2" fill="currentColor"/>
      <rect x="8" y="17" width="8" height="3" rx="0.5" fill="currentColor"/>
    </symbol>
    <symbol id="tw-ico-ap" viewBox="0 0 24 24">
      <path d="M12 2 L7.5 9 L7.5 15 L16.5 15 L16.5 9 Z" fill="currentColor"/>
      <rect x="7" y="15" width="10" height="2" fill="currentColor"/>
      <rect x="8" y="17" width="8" height="3" rx="0.5" fill="currentColor"/>
    </symbol>
    <symbol id="tw-ico-boost" viewBox="0 0 24 24">
      <path d="M13 2 L4 14 L10.5 14 L9 22 L20 9 L13.5 9 Z" fill="currentColor"/>
    </symbol>
    <symbol id="tw-ico-armor" viewBox="0 0 24 24">
      <path d="M12 2 L4 5 L4 11 C4 16.5 8 20.5 12 22 C16 20.5 20 16.5 20 11 L20 5 Z"
        fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    </symbol>
    <symbol id="tw-ico-scout" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/>
      <path d="M12 12 L12 3 A9 9 0 0 1 19 7 Z" fill="currentColor" opacity="0.35" stroke="none"/>
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>
    </symbol>
  </defs>
</svg>`;

// ============================================================
// CSS 样式(注入一次)
// ============================================================

const CSS = `
/* —— 弹药面板(右下) —— */
.tw-ammo-panel {
  position: absolute; bottom: 16px; right: 12px; z-index: 10;
  width: 224px; padding: 10px 12px 8px;
  background: rgba(20,22,28,0.85); border: 1px solid rgba(255,255,255,0.12);
  border-radius: 8px; backdrop-filter: blur(4px);
  transition: border-color 0.2s;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.tw-ammo-panel.resupply { border-color: rgba(127,255,127,0.35); }
.tw-ammo-current { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.tw-ammo-bigicon { width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.tw-ammo-namerow { display: flex; align-items: center; gap: 6px; margin-bottom: 2px; }
.tw-ammo-name { font-size: 12px; font-weight: bold; color: #ccc; }
.tw-ammo-badge {
  font-size: 9px; font-weight: bold; color: #ffaa33;
  background: rgba(255,170,51,0.12); border: 1px solid rgba(255,170,51,0.3);
  padding: 1px 5px; border-radius: 3px; text-transform: uppercase; letter-spacing: 0.5px;
}
.tw-ammo-count {
  font-size: 22px; font-weight: bold; color: #e6e6e6;
  font-variant-numeric: tabular-nums; line-height: 1;
  text-shadow: 0 1px 3px rgba(0,0,0,0.7);
}
.tw-ammo-count .max { color: #555; font-size: 14px; }
.tw-ammo-count.low { color: #ffaa33; }
.tw-ammo-count.empty { color: #ff5252; }
.tw-ammo-count.resupply { color: #7fff7f; }
.tw-ammo-progress { height: 4px; background: rgba(255,255,255,0.06); border-radius: 2px; margin-bottom: 8px; overflow: hidden; }
.tw-ammo-bar { height: 100%; transition: width 0.3s ease, background 0.2s; border-radius: 2px; }
.tw-ammo-seq { display: flex; align-items: center; gap: 6px; }
.tw-ammo-slot {
  width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
  border: 1.5px solid rgba(255,255,255,0.1); border-radius: 5px;
  opacity: 0.35; transition: all 0.15s; position: relative;
}
.tw-ammo-slot.current { border-color: #ffcc33; opacity: 1; box-shadow: 0 0 8px rgba(255,204,51,0.3); }
.tw-ammo-slot.current::after {
  content: ''; position: absolute; bottom: -5px; left: 50%; transform: translateX(-50%);
  width: 4px; height: 4px; border-radius: 50%; background: #ffcc33;
}
.tw-ammo-slot.empty { border-color: rgba(255,82,82,0.3); }
.tw-ammo-slot.empty svg { color: #ff5252 !important; }
.tw-ammo-tabhint { margin-left: auto; font-size: 10px; color: #555; display: flex; align-items: center; gap: 3px; }
.tw-ammo-tabhint kbd {
  background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1);
  border-radius: 3px; padding: 1px 5px; font-family: inherit; font-size: 9px; color: #888;
}

/* —— 技能栏(弹药面板上方) —— */
.tw-skill-bar { position: absolute; bottom: 204px; right: 12px; z-index: 10; display: flex; gap: 6px; }
.tw-skill-cell {
  width: 72px; height: 70px; display: flex; flex-direction: column;
  background: rgba(20,22,28,0.85); border: 2px solid rgba(255,255,255,0.12);
  border-radius: 8px; overflow: hidden; backdrop-filter: blur(4px);
  transition: border-color 0.2s, box-shadow 0.2s, opacity 0.2s;
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
.tw-skill-cell.ready { border-color: rgba(127,255,127,0.35); }
.tw-skill-cell.active {
  border-color: #ffcc33;
  box-shadow: 0 0 14px rgba(255,204,51,0.35), inset 0 0 12px rgba(255,204,51,0.08);
}
.tw-skill-cell.cooldown { opacity: 0.55; }
.tw-skill-top { display: flex; align-items: center; justify-content: space-between; padding: 4px 6px 0; }
.tw-skill-icon { width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; color: #ccc; }
.tw-skill-cell.ready .tw-skill-icon { color: #7fff7f; }
.tw-skill-cell.active .tw-skill-icon { color: #ffcc33; }
.tw-skill-key {
  font-size: 10px; font-weight: bold; color: #aaa;
  background: rgba(255,255,255,0.08); padding: 2px 5px; border-radius: 3px; line-height: 1;
}
.tw-skill-cell.active .tw-skill-key { color: #ffcc33; background: rgba(255,204,51,0.12); }
.tw-skill-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; line-height: 1.2; }
.tw-skill-value {
  font-size: 16px; font-weight: bold; color: #e6e6e6;
  font-variant-numeric: tabular-nums; text-shadow: 0 1px 3px rgba(0,0,0,0.7);
}
.tw-skill-cell.ready .tw-skill-value { color: #7fff7f; }
.tw-skill-cell.active .tw-skill-value { color: #ffcc33; }
.tw-skill-label { font-size: 9px; color: #777; text-transform: uppercase; letter-spacing: 1px; margin-top: 1px; }
.tw-skill-cell.active .tw-skill-label { color: #ffcc33; }
.tw-skill-bar { height: 4px; background: rgba(255,255,255,0.06); }
.tw-skill-bar-fill { height: 100%; transition: width 0.3s ease; }
.tw-skill-cell.ready .tw-skill-bar-fill { background: rgba(127,255,127,0.5); }
.tw-skill-cell.active .tw-skill-bar-fill { background: #ffcc33; }
.tw-skill-cell.cooldown .tw-skill-bar-fill { background: #6a7545; }
`;

// ============================================================
// 准星 SVG + 样式(保留不变)
// ============================================================

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
  position: 'absolute', left: '0', top: '0',
  pointerEvents: 'none', zIndex: '10', willChange: 'transform',
};

const killInfoStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute', top: '44px', left: '12px', zIndex: '10',
  pointerEvents: 'none', fontFamily: 'monospace', fontSize: '14px',
  fontWeight: 'bold', color: '#ffcc33',
  background: 'rgba(20,22,28,0.75)', padding: '6px 10px',
  borderRadius: '6px', textShadow: '0 1px 2px rgba(0,0,0,0.6)', minWidth: '140px',
};
const barOuterStyle: Partial<CSSStyleDeclaration> = {
  marginTop: '5px', width: '100%', height: '6px',
  background: 'rgba(255,255,255,0.12)', borderRadius: '3px', overflow: 'hidden',
};
const barInnerStyle: Partial<CSSStyleDeclaration> = {
  width: '0%', height: '100%', background: '#ffcc33', borderRadius: '3px', transition: 'width 0.3s ease',
};

// ============================================================
// HUD 主类
// ============================================================

/**
 * 平视显示器(HUD)
 * ============================================================
 * 屏幕层 UI 元素(准星/弹药面板/技能栏/目标进度),用 DOM 而非 Three 内绘制——
 * 准星是 2D 像素精确元素,DOM 方式最锐利、最易调样式,且不占用 canvas 绘制开销。
 *
 * 弹药面板(右下):大图标+名称+数量+进度条+序列指示器+Tab 提示。
 *  可扩展架构:新增弹种只需往 AMMO_META + AMMO_ORDER 加一项,UI 自动适配。
 *
 * 技能栏(弹药面板上方):3 格 boost/armor/scout,按 Shift+数字激活。
 *  状态视觉:可用=绿色 / 激活=金色光晕 / 冷却=半透灰+进度条。
 */
export class HUD {
  private mounted = false;

  // 准星
  private readonly crosshair: HTMLDivElement;

  // 弹药面板元素引用
  private readonly ammoPanel: HTMLDivElement;
  private readonly ammoBigIcon: HTMLDivElement;
  private readonly ammoName: HTMLSpanElement;
  private readonly ammoBadge: HTMLSpanElement;
  private readonly ammoCount: HTMLDivElement;
  private readonly ammoBar: HTMLDivElement;
  private readonly ammoSeq: HTMLDivElement;
  /** 弹药面板缓存键(仅数据变化时刷新 DOM,避免每帧重建弹药序列等 DOM 节点) */
  private lastAmmoKey = '';

  // 技能栏元素引用(3 格)
  private readonly skillCells: HTMLDivElement[] = [];
  private readonly skillValues: HTMLDivElement[] = [];
  private readonly skillBars: HTMLDivElement[] = [];

  // 目标进度
  private readonly killText: HTMLDivElement;
  private readonly killBarInner: HTMLDivElement;

  constructor(container: HTMLElement) {
    // 注入 SVG 图标定义 + CSS 样式(一次性)
    container.insertAdjacentHTML('beforeend', SVG_DEFS);
    const styleEl = document.createElement('style');
    styleEl.textContent = CSS;
    container.appendChild(styleEl);

    // —— 准星 ——
    this.crosshair = document.createElement('div');
    this.crosshair.innerHTML = crosshairSVG;
    Object.assign(this.crosshair.style, crosshairStyle);
    container.appendChild(this.crosshair);

    // —— 弹药面板(右下) ——
    this.ammoPanel = document.createElement('div');
    this.ammoPanel.className = 'tw-ammo-panel';
    this.ammoPanel.innerHTML = `
      <div class="tw-ammo-current">
        <div class="tw-ammo-bigicon" id="tw-ammo-icon"></div>
        <div>
          <div class="tw-ammo-namerow">
            <span class="tw-ammo-name" id="tw-ammo-name"></span>
            <span class="tw-ammo-badge" id="tw-ammo-badge" style="display:none"></span>
          </div>
          <div class="tw-ammo-count" id="tw-ammo-count"></div>
        </div>
      </div>
      <div class="tw-ammo-progress"><div class="tw-ammo-bar" id="tw-ammo-bar"></div></div>
      <div class="tw-ammo-seq" id="tw-ammo-seq"></div>`;
    container.appendChild(this.ammoPanel);
    this.ammoBigIcon = this.ammoPanel.querySelector('#tw-ammo-icon')!;
    this.ammoName = this.ammoPanel.querySelector('#tw-ammo-name')!;
    this.ammoBadge = this.ammoPanel.querySelector('#tw-ammo-badge')!;
    this.ammoCount = this.ammoPanel.querySelector('#tw-ammo-count')!;
    this.ammoBar = this.ammoPanel.querySelector('#tw-ammo-bar')!;
    this.ammoSeq = this.ammoPanel.querySelector('#tw-ammo-seq')!;

    // —— 技能栏(弹药面板上方) ——
    const skillBar = document.createElement('div');
    skillBar.className = 'tw-skill-bar';
    for (const m of SKILL_META) {
      const cell = document.createElement('div');
      cell.className = 'tw-skill-cell ready';
      cell.innerHTML = `
        <div class="tw-skill-top">
          <div class="tw-skill-icon"><svg width="20" height="20"><use href="#${m.icon}"/></svg></div>
          <span class="tw-skill-key">${m.key}</span>
        </div>
        <div class="tw-skill-center">
          <div class="tw-skill-value">就绪</div>
          <div class="tw-skill-label">${m.label}</div>
        </div>
        <div class="tw-skill-bar"><div class="tw-skill-bar-fill" style="width:100%"></div></div>`;
      skillBar.appendChild(cell);
      this.skillCells.push(cell);
      this.skillValues.push(cell.querySelector('.tw-skill-value')!);
      this.skillBars.push(cell.querySelector('.tw-skill-bar-fill')!);
    }
    container.appendChild(skillBar);

    // —— 目标进度(左上,保留原样) ——
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

  /** 更新准星到鼠标屏幕位置 */
  setCrosshair(clientX: number, clientY: number): void {
    if (!this.mounted) return;
    this.crosshair.style.transform = `translate(${clientX}px, ${clientY}px) translate(-50%, -50%)`;
  }

  /**
   * 每帧更新弹药面板 + 目标进度 + 技能栏。
   * ------------------------------------------------------------
   * @param ammo   弹药信息(main 从玩家 weapon 读取传入);缺省则隐藏弹药面板。
   * @param skills 技能栏数据(顺序 boost/armor/scout);缺省不更新技能栏。
   */
  update(
    _tank: IControllableTank,
    ammo?: {
      ap: number; he: number;
      maxAp: number; maxHe: number;
      selected: AmmoType;
      resupplying: boolean;
    },
    objective?: Objective,
    skills?: ReadonlyArray<{ id: SkillId; cdRatio: number; active: boolean }>,
  ): void {
    if (!this.mounted) return;

    // —— 弹药面板 ——
    if (ammo) {
      this.renderAmmoPanel(ammo);
    } else {
      this.ammoPanel.style.display = 'none';
    }

    // —— 目标进度(保留原逻辑) ——
    if (objective) {
      const ratio = objective.target > 0 ? objective.progress / objective.target : 0;
      if (objective.type === 'capture') {
        this.killText.textContent = `占领 ${Math.round(ratio * 100)}%`;
        this.killBarInner.style.background = '#4a8aff';
      } else {
        this.killText.textContent = `击毁 ${objective.progress}/${objective.target}`;
        this.killBarInner.style.background = '#ffcc33';
      }
      this.killBarInner.style.width = `${Math.min(100, ratio * 100)}%`;
    } else {
      this.killText.textContent = '';
      this.killBarInner.style.width = '0%';
    }

    // —— 技能栏 ——
    if (skills) {
      for (let i = 0; i < this.skillCells.length; i++) {
        const s = skills[i];
        if (!s) continue;
        this.renderSkillCell(i, s.cdRatio, s.active);
      }
    }
  }

  // ============================================================
  // 弹药面板渲染
  // ============================================================

  /** 按当前弹药数据渲染弹药面板(大图标+名称+数量+进度条+序列) */
  private renderAmmoPanel(ammo: {
    ap: number; he: number; maxAp: number; maxHe: number;
    selected: AmmoType; resupplying: boolean;
  }): void {
    // 缓存:仅数据变化时刷新 DOM(避免每帧重建弹药序列等 DOM 节点,60fps 下减少 GC)
    const key = `${ammo.selected}|${ammo.ap}|${ammo.he}|${ammo.maxAp}|${ammo.maxHe}|${ammo.resupplying}`;
    if (key === this.lastAmmoKey) return;
    this.lastAmmoKey = key;

    this.ammoPanel.style.display = '';
    const sel = ammo.selected;
    const meta = AMMO_META[sel];
    const cur = ammo[sel];
    const max = sel === 'ap' ? ammo.maxAp : ammo.maxHe;
    const ratio = max > 0 ? cur / max : 0;

    // 当前弹药大图标
    this.ammoBigIcon.innerHTML = `<svg width="36" height="36"><use href="#${meta.icon}"/></svg>`;
    this.ammoBigIcon.style.color = cur < 1 ? '#ff5252' : meta.color;

    // 名称 + 徽章
    this.ammoName.textContent = meta.name;
    if (meta.badge) {
      this.ammoBadge.style.display = '';
      this.ammoBadge.textContent = meta.badge;
    } else {
      this.ammoBadge.style.display = 'none';
    }

    // 数量(状态色:空仓红 / 低弹橙 / 装填绿 / 正常白)
    const cls = cur < 1 ? 'empty' : cur <= 3 ? 'low' : ammo.resupplying ? 'resupply' : '';
    this.ammoCount.className = 'tw-ammo-count ' + cls;
    this.ammoCount.innerHTML = `${Math.floor(cur)}<span class="max">/${max}</span>`;

    // 进度条
    this.ammoBar.style.width = (ratio * 100) + '%';
    this.ammoBar.style.background = cur < 1 ? '#ff5252' :
      cur <= 3 ? '#ffaa33' : ammo.resupplying ? '#7fff7f' : meta.color;

    // 装填状态:面板边框变绿
    this.ammoPanel.classList.toggle('resupply', ammo.resupplying);

    // 弹药序列指示器(可扩展:遍历 AMMO_ORDER 渲染小图标)
    this.renderAmmoSequence(ammo);
  }

  /** 渲染弹药序列(底部小图标排,当前选中金色高亮,耗尽红色) */
  private renderAmmoSequence(ammo: {
    ap: number; he: number; maxAp: number; maxHe: number; selected: AmmoType;
  }): void {
    this.ammoSeq.innerHTML = '';
    for (const type of AMMO_ORDER) {
      const meta = AMMO_META[type];
      const cur = ammo[type];
      const max = type === 'ap' ? ammo.maxAp : ammo.maxHe;
      const slot = document.createElement('div');
      slot.className = 'tw-ammo-slot';
      if (type === ammo.selected) slot.classList.add('current');
      if (cur < 1) slot.classList.add('empty');
      slot.innerHTML = `<svg width="18" height="18"><use href="#${meta.icon}"/></svg>`;
      slot.style.color = cur < 1 ? '#ff5252' : meta.color;
      slot.title = `${meta.name} ${Math.floor(cur)}/${max}`;
      this.ammoSeq.appendChild(slot);
    }
    // Tab 提示
    const hint = document.createElement('div');
    hint.className = 'tw-ammo-tabhint';
    hint.innerHTML = '<kbd>Tab</kbd> 切换';
    this.ammoSeq.appendChild(hint);
  }

  // ============================================================
  // 技能栏渲染
  // ============================================================

  /** 渲染单个技能格状态(可用=绿 / 激活=金光晕 / 冷却=半透灰+进度) */
  private renderSkillCell(idx: number, cdRatio: number, active: boolean): void {
    const cell = this.skillCells[idx];
    const valEl = this.skillValues[idx];
    const barEl = this.skillBars[idx];

    if (active) {
      // 激活中:金色边框+光晕(由 CSS .active 类驱动)
      cell.className = 'tw-skill-cell active';
      valEl.textContent = '生效中';
      barEl.style.width = '80%';
    } else if (cdRatio >= 1) {
      // 可用:绿色边框
      cell.className = 'tw-skill-cell ready';
      valEl.textContent = '就绪';
      barEl.style.width = '100%';
    } else {
      // 冷却中:半透灰+进度条+百分比
      cell.className = 'tw-skill-cell cooldown';
      const pct = Math.round(cdRatio * 100);
      valEl.textContent = `${pct}%`;
      barEl.style.width = `${pct}%`;
    }
  }
}
