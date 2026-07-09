import { CONFIG } from '../config';
import type { Posture } from '../ai/NpcController';
import { Logger } from '../utils/Logger';

const log = Logger.create('Overlay');

export type GameResult = 'won' | 'lost';

/** 失败原因(决定结算标题文案):玩家坦克被毁 / 敌方占领据点 */
export type LoseReason = 'destroyed' | 'capture';

/** 姿态横幅文案(normal 不提示,避免噪音) */
const POSTURE_BANNER: Record<Posture, string> = {
  aggro: '敌方转入攻势',
  defensive: '敌方收缩防御',
  normal: '',
};

/** 关卡卡片样式(注入一次:横向排列 + 选中高亮 + hover 反馈) */
const LEVEL_CARD_STYLE = `
.tw-level-row{display:flex;gap:12px;margin-bottom:14px}
.tw-level-card{flex:1;min-width:0;padding:12px 14px;border:2px solid rgba(255,255,255,0.12);border-radius:8px;cursor:pointer;background:rgba(30,34,42,0.5);transition:border-color .15s,background .15s;text-align:left}
.tw-level-card:hover{border-color:rgba(255,204,51,.5)}
.tw-level-selected{border-color:#ffcc33;background:rgba(74,85,53,.55)}
.tw-level-name{font-size:16px;font-weight:bold;color:#e6e6e6;margin-bottom:4px}
.tw-level-brief{font-size:12px;color:#9a9a9a}
`;

/**
 * 覆盖层 UI(关卡选择 / 结算面板 / 姿态横幅)
 * ============================================================
 * 模块化:三类面板各自独立 DOM + 显隐控制,互不干扰。
 *
 * 关卡选择:从 CONFIG.levels 数据驱动渲染卡片,玩家点选后高亮 + 玩法说明切换,
 *  点"开始作战"触发 onStart(levelId)。main 在回调里按 levelId 创建对应
 *  Objective(+ 占领军 CaptureZone)。新增关卡只需 config.levels 加一条,本类自动渲染。
 *
 * 结算面板:胜利/失败统一,失败原因区分(坦克被毁 / 据点失守),目标文案数据驱动。
 */
export class Overlay {
  private readonly menuEl: HTMLDivElement;
  private readonly resultEl: HTMLDivElement;
  private readonly resultTitle: HTMLDivElement;
  private readonly resultDetail: HTMLDivElement;
  private readonly bannerEl: HTMLDivElement;
  /** 加载面板(loading 状态显示) */
  private readonly loadingEl: HTMLDivElement;
  /** 加载进度条填充(宽度随百分比变化) */
  private readonly loadingBarFill: HTMLDivElement;
  /** 加载当前阶段文字 */
  private readonly loadingLabel: HTMLDivElement;
  /** 玩法说明元素(随关卡选择动态切换文案) */
  private readonly tipEl: HTMLDivElement;
  private lastPosture: Posture = 'normal';
  /** 当前选中的关卡 id(默认第一关;点卡片切换) */
  private selectedLevelId: string = CONFIG.levels[0]?.id ?? 'kill';
  /** 开始回调(点击开始作战时,传入选中的 levelId) */
  private readonly onStart: (levelId: string) => void;

  constructor(
    container: HTMLElement,
    onStart: (levelId: string) => void,
    onRestart: () => void,
  ) {
    this.onStart = onStart;
    // 横幅 + 关卡卡片样式(注入一次)
    const styleEl = document.createElement('style');
    styleEl.textContent =
      '@keyframes tw-banner{0%{opacity:0;transform:translate(-50%,-12px)}15%{opacity:1;transform:translate(-50%,0)}85%{opacity:1}100%{opacity:0;transform:translate(-50%,-12px)}}' +
      '.tw-banner-show{animation:tw-banner 2.2s ease forwards}' +
      LEVEL_CARD_STYLE;
    container.appendChild(styleEl);

    // —— 加载面板(初始即显示,资源就绪后 hideLoading 切到菜单) ——
    this.loadingEl = document.createElement('div');
    Object.assign(this.loadingEl.style, overlayBaseStyle);
    this.loadingEl.innerHTML = this.buildLoadingHtml();
    container.appendChild(this.loadingEl);
    this.loadingLabel = this.loadingEl.querySelector<HTMLDivElement>('#tw-loading-label')!;
    this.loadingBarFill = this.loadingEl.querySelector<HTMLDivElement>('#tw-loading-fill')!;

    // —— 开始界面(关卡选择) ——
    this.menuEl = document.createElement('div');
    Object.assign(this.menuEl.style, overlayBaseStyle);
    this.menuEl.innerHTML = this.buildMenuHtml();
    container.appendChild(this.menuEl);
    this.menuEl.style.display = 'none'; // 初始隐藏:加载完成 showMenu 时才显示
    // 玩法说明元素引用(选中关卡时动态更新文案)
    this.tipEl = this.menuEl.querySelector<HTMLDivElement>('#tw-tip')!;
    this.tipEl.textContent = this.currentLevelTip();
    // 绑定关卡卡片点击:切换选中 + 更新玩法说明
    for (const level of CONFIG.levels) {
      const card = this.menuEl.querySelector<HTMLDivElement>(`#tw-level-${level.id}`);
      card?.addEventListener('click', () => this.selectLevel(level.id));
    }
    // 绑定开始按钮:带选中关卡 id 触发 main 的选关启动
    this.menuEl.querySelector<HTMLButtonElement>('#tw-start')!.addEventListener('click', () => {
      this.onStart(this.selectedLevelId);
    });

    // —— 结算面板 ——
    this.resultEl = document.createElement('div');
    Object.assign(this.resultEl.style, overlayBaseStyle);
    this.resultEl.style.display = 'none';
    this.resultTitle = document.createElement('div');
    Object.assign(this.resultTitle.style, {
      fontSize: '44px',
      fontWeight: 'bold',
      letterSpacing: '4px',
      marginBottom: '18px',
    });
    this.resultDetail = document.createElement('div');
    Object.assign(this.resultDetail.style, {
      fontSize: '16px',
      color: '#cfcfcf',
      marginBottom: '24px',
      lineHeight: '1.9',
    });
    const restartBtn = document.createElement('button');
    Object.assign(restartBtn.style, btnStyle);
    restartBtn.style.fontSize = '18px';
    restartBtn.textContent = '再战一局';
    restartBtn.addEventListener('click', onRestart);
    this.resultEl.append(this.resultTitle, this.resultDetail, restartBtn);
    container.appendChild(this.resultEl);

    // —— 姿态横幅(顶部居中) ——
    this.bannerEl = document.createElement('div');
    Object.assign(this.bannerEl.style, bannerStyle);
    container.appendChild(this.bannerEl);

    log.info('overlay ready', { levels: CONFIG.levels.map((l) => l.id).join('/') });
  }

  /** 当前选中关卡的玩法说明 */
  private currentLevelTip(): string {
    return CONFIG.levels.find((l) => l.id === this.selectedLevelId)?.tip ?? '';
  }

  /** 选中某关:更新选中态高亮 + 切换玩法说明文案 */
  private selectLevel(id: string): void {
    this.selectedLevelId = id;
    for (const level of CONFIG.levels) {
      const card = this.menuEl.querySelector<HTMLDivElement>(`#tw-level-${level.id}`);
      if (card) card.classList.toggle('tw-level-selected', level.id === id);
    }
    this.tipEl.textContent = this.currentLevelTip();
  }

  /** 开始界面 HTML(关卡卡片数据驱动渲染 + 操作 + 动态玩法说明) */
  private buildMenuHtml(): string {
    const cards = CONFIG.levels
      .map(
        (level) => `
      <div id="tw-level-${level.id}" class="tw-level-card ${level.id === this.selectedLevelId ? 'tw-level-selected' : ''}">
        <div class="tw-level-name">${level.name}</div>
        <div class="tw-level-brief">${level.brief}</div>
      </div>`,
      )
      .join('');
    return [
      `<div style="font-size:52px;font-weight:bold;letter-spacing:8px;color:#e6e6e6;margin-bottom:6px;text-shadow:0 2px 8px #000">坦克大战</div>`,
      `<div style="font-size:14px;color:#9a9a9a;margin-bottom:22px">3D 装甲对抗 · 单人关卡</div>`,
      `<div style="font-size:14px;color:#ffcc33;margin-bottom:8px">选择作战任务</div>`,
      `<div class="tw-level-row">${cards}</div>`,
      `<div style="${boxStyle}">`,
      `<div style="font-size:14px;color:#ffcc33;margin-bottom:8px">操作</div>`,
      `<div style="font-size:13px;color:#cfcfcf;line-height:1.9">`,
      `↑ ↓ ← → &nbsp;移动 &nbsp;&middot;&nbsp; Q W &nbsp;炮塔左右<br>`,
      `A S &nbsp;炮管俯仰 &nbsp;&middot;&nbsp; Space &nbsp;开火 &nbsp;&middot;&nbsp; 鼠标 &nbsp;准星`,
      `</div></div>`,
      `<div style="${boxStyle}">`,
      `<div style="font-size:14px;color:#7fff7f;margin-bottom:8px">玩法</div>`,
      // 玩法说明:随关卡选择动态切换(初始填当前关卡 tip,selectLevel 时更新)
      `<div id="tw-tip" style="font-size:13px;color:#cfcfcf;line-height:1.9">${this.currentLevelTip()}</div>`,
      `</div>`,
      `<div style="${boxStyle}">`,
      `<div style="font-size:14px;color:#ff5252;margin-bottom:10px">敌方难度识别(看配色辨威胁)</div>`,
      `<div style="font-size:13px;color:#cfcfcf;line-height:1.6;display:flex;gap:20px;flex-wrap:wrap;align-items:center">`,
      `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:18px;height:18px;background:#6b6a55;border-radius:3px;display:inline-block"></span>新兵 量产</span>`,
      `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:18px;height:18px;background:#4d4c3d;border-radius:3px;display:inline-block"></span>老兵 深色·双杠</span>`,
      `<span style="display:inline-flex;align-items:center;gap:6px"><span style="width:18px;height:18px;background:#2a2a2a;border:2px solid #c0392b;border-radius:3px;display:inline-block"></span><b style="color:#ff5252">精英</b> 黑色·骷髅·会技能</span>`,
      `</div></div>`,
      `<button id="tw-start" style="${btnStyleStr};font-size:18px;margin-top:6px">开始作战</button>`,
    ].join('');
  }

  // ============================================================
  // 加载面板(loading 状态)
  // ============================================================

  /** 加载面板 HTML:标题 + 进度条 + 当前阶段文字。
   *  风格沿用菜单暗色军事风,保持视觉一致。 */
  private buildLoadingHtml(): string {
    return [
      `<div style="font-size:52px;font-weight:bold;letter-spacing:8px;color:#e6e6e6;margin-bottom:6px;text-shadow:0 2px 8px #000">坦克大战</div>`,
      `<div style="font-size:14px;color:#9a9a9a;margin-bottom:34px">3D 装甲对抗 · 单人关卡</div>`,
      // 进度条外框(暗色凹槽)
      `<div style="width:360px;height:8px;background:rgba(255,255,255,0.08);border-radius:4px;overflow:hidden;margin-bottom:14px">`,
      // 进度条填充(军绿,宽度由 updateProgress 动态设)
      `<div id="tw-loading-fill" style="width:0%;height:100%;background:linear-gradient(90deg,#6a7545,#9aa860);border-radius:4px;transition:width .2s ease"></div>`,
      `</div>`,
      // 当前阶段文字 + 百分比
      `<div id="tw-loading-label" style="font-size:13px;color:#9a9a9a;min-height:18px">正在初始化…</div>`,
    ].join('');
  }

  /** 显示加载面板(构造时已显示,此方法供重试用) */
  showLoading(): void {
    this.loadingEl.style.display = 'flex';
  }

  /** 更新加载进度(done/total 算百分比,label 显示当前阶段) */
  updateProgress(p: { done: number; total: number; label: string }): void {
    const pct = p.total > 0 ? Math.min(100, Math.round((p.done / p.total) * 100)) : 0;
    this.loadingBarFill.style.width = `${pct}%`;
    this.loadingLabel.textContent = `${p.label} ${pct}%`;
  }

  /** 隐藏加载面板(资源就绪切到菜单时调用) */
  hideLoading(): void {
    this.loadingEl.style.display = 'none';
  }

  /**
   * 加载失败面板:显示错误信息 + 重试按钮。
   * ------------------------------------------------------------
   * 硬依赖(物理/数据)加载失败时,隐藏进度条显示错误,提供重试(刷新页面)。
   */
  showLoadError(message: string, onRetry: () => void): void {
    // 隐藏进度相关,改为错误提示
    const bar = this.loadingEl.querySelector<HTMLDivElement>('#tw-loading-fill')?.parentElement;
    if (bar) bar.style.display = 'none';
    this.loadingLabel.style.color = '#ff5252';
    this.loadingLabel.textContent = message;
    // 重试按钮(只加一次)
    if (!this.loadingEl.querySelector('#tw-retry')) {
      const btn = document.createElement('button');
      btn.id = 'tw-retry';
      Object.assign(btn.style, btnStyle);
      btn.style.fontSize = '16px';
      btn.style.marginTop = '20px';
      btn.textContent = '重试';
      btn.addEventListener('click', onRetry);
      this.loadingEl.appendChild(btn);
    }
  }

  showMenu(): void {
    this.menuEl.style.display = 'flex';
  }
  hideMenu(): void {
    this.menuEl.style.display = 'none';
  }

  /**
   * 显示结算面板。
   * @param objectiveDesc 目标文案(数据驱动,取自选中关卡的 brief)
   * @param reason        失败原因(仅 lost 用):区分"坦克被毁"/"据点失守"标题
   */
  showResult(
    result: GameResult,
    stats: { kills: number; timeText: string; objectiveDesc: string; reason?: LoseReason },
  ): void {
    if (result === 'won') {
      this.resultTitle.textContent = '作战胜利';
      this.resultTitle.style.color = '#ffcc33';
    } else {
      // 失败原因区分:据点失守(敌方占领)/ 坦克被毁
      this.resultTitle.textContent = stats.reason === 'capture' ? '据点失守' : '坦克被击毁';
      this.resultTitle.style.color = '#ff5252';
    }
    this.resultDetail.innerHTML =
      `目标:${stats.objectiveDesc}<br>` +
      `击毁 <b style="color:#ffcc33">${stats.kills}</b> 辆 &nbsp;&middot;&nbsp; 用时 <b style="color:#e6e6e6">${stats.timeText}</b>`;
    this.resultEl.style.display = 'flex';
  }
  hideResult(): void {
    this.resultEl.style.display = 'none';
  }

  /** 姿态变化时显示横幅(main 每帧 feed;normal 不提示) */
  updatePosture(posture: Posture): void {
    if (posture === this.lastPosture) return;
    this.lastPosture = posture;
    const text = POSTURE_BANNER[posture];
    if (!text) return;
    this.bannerEl.textContent = text;
    // 强制重启动画(移除→强制重排→加回),使连续切换都能播放
    this.bannerEl.classList.remove('tw-banner-show');
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('tw-banner-show');
  }
}

// —— 样式常量 ——
const overlayBaseStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  top: '0',
  left: '0',
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: '30',
  background: 'rgba(10,12,16,0.78)',
  fontFamily: 'monospace',
  textAlign: 'center',
  color: '#e6e6e6',
};

const boxStyle =
  'background:rgba(30,34,42,0.6);border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:12px 18px;margin-bottom:14px;min-width:340px;text-align:left';

const btnStyle: Partial<CSSStyleDeclaration> = {
  padding: '10px 28px',
  background: '#4a5535',
  color: '#fff',
  border: '1px solid #6a7545',
  borderRadius: '6px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontWeight: 'bold',
};
const btnStyleStr =
  'padding:10px 28px;background:#4a5535;color:#fff;border:1px solid #6a7545;border-radius:6px;cursor:pointer;font-family:monospace;font-weight:bold';

const bannerStyle: Partial<CSSStyleDeclaration> = {
  position: 'absolute',
  top: '60px',
  left: '50%',
  zIndex: '25',
  padding: '8px 24px',
  background: 'rgba(20,22,28,0.85)',
  border: '1px solid rgba(255,204,51,0.4)',
  borderRadius: '6px',
  fontFamily: 'monospace',
  fontSize: '15px',
  fontWeight: 'bold',
  color: '#ffcc33',
  opacity: '0',
  pointerEvents: 'none',
  whiteSpace: 'nowrap',
};
