import { CONFIG } from '../config';
import { Logger } from '../utils/Logger';

const log = Logger.create('Tuning');

/** localStorage 键(缓存调过的参数) */
const STORAGE_KEY = 'tankwar.tuning';

/** 可调参数定义(路径相对 CONFIG.tank) */
interface Tunable {
  path: string; // 如 'sway.pitchScale'
  label: string;
  min: number;
  max: number;
  step: number;
  digits: number; // 显示小数位
}

/**
 * 可调参数清单(聚焦手感)
 * ------------------------------------------------------------
 * 这些参数都在主循环里每帧被读取，改值立即生效，无需重启。
 */
const TUNABLES: Tunable[] = [
  { path: 'sway.pitchScale', label: '俯仰幅度', min: 0, max: 0.03, step: 0.001, digits: 3 },
  { path: 'sway.rollScale', label: '侧倾幅度', min: 0, max: 0.05, step: 0.001, digits: 3 },
  { path: 'sway.lerp', label: '摇晃平滑', min: 0.02, max: 0.3, step: 0.01, digits: 2 },
  { path: 'turret.omegaLerp', label: '炮塔惯性', min: 0.03, max: 0.5, step: 0.01, digits: 2 },
  { path: 'moveSpeed', label: '移动速度', min: 2, max: 20, step: 0.5, digits: 1 },
  { path: 'turnSpeed', label: '转向速度', min: 0.5, max: 4, step: 0.1, digits: 1 },
  { path: 'accelLerp', label: '加速平滑', min: 0.02, max: 0.4, step: 0.01, digits: 2 },
];

/**
 * 调参面板
 * ------------------------------------------------------------
 * - 右上浮层 slider，改值实时写 CONFIG → 立即生效(主循环每帧读取)
 * - 调过的值缓存 localStorage，下次启动自动恢复；不调则用 config.ts 默认
 * - 必须最早在 main 创建：restore 先覆盖 CONFIG，之后所有模块读到调参后的值
 *
 * CONFIG 是 `as const`(类型层 readonly)，但运行时是普通对象可写；
 * 用 any cast 写入绕过类型层，各模块读 CONFIG.xxx 即得新值。
 */
/** 调试用回调(由 main 注入:模拟对玩家/静态坦克的一次受击,验证损坏链) */
export interface TuningDebugHooks {
  /** 模拟对玩家坦克的一次满伤受击 */
  simulatePlayerHit?: () => void;
  /** 模拟对最近静态坦克的一次满伤受击 */
  simulateStaticHit?: () => void;
  /** 切换当前附身坦克 */
  switchTank?: () => void;
}

export class TuningPanel {
  private tankNameLabel?: HTMLDivElement;

  constructor(hooks?: TuningDebugHooks) {
    this.restore();
    this.buildUI(hooks);
    log.info('tuning panel ready', { count: TUNABLES.length });
  }

  /** 更新面板中显示的当前附身坦克名称 */
  setTankName(name: string): void {
    if (this.tankNameLabel) this.tankNameLabel.textContent = `当前: ${name}`;
  }

  /** 从 localStorage 恢复调参 → 覆盖 CONFIG 默认值 */
  private restore(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      // 隐私模式等场景 localStorage 不可用，静默降级用默认值
      log.warn('localStorage unavailable, use defaults', e);
      return;
    }
    if (!raw) return;
    try {
      const saved = JSON.parse(raw) as Record<string, number>;
      for (const t of TUNABLES) {
        if (t.path in saved) this.setConfig(t.path, saved[t.path]);
      }
      log.info('tuning restored', saved);
    } catch (e) {
      log.warn('tuning restore failed, use defaults', e);
    }
  }

  /** 写 CONFIG(运行时覆盖 as const 只约束类型，运行时可写) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setConfig(path: string, val: number): void {
    const parts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = CONFIG.tank;
    for (let i = 0; i < parts.length - 1; i++) cur = cur[parts[i]];
    cur[parts[parts.length - 1]] = val;
  }

  /** 读 CONFIG 当前值 */
  private getConfig(path: string): number {
    const parts = path.split('.');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let cur: any = CONFIG.tank;
    for (const p of parts) cur = cur[p];
    return cur as number;
  }

  /** 单个调参持久化 */
  private persist(path: string, val: number): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const saved = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      saved[path] = val;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch (e) {
      log.warn('tuning persist failed', e);
    }
  }

  private buildUI(hooks?: TuningDebugHooks): void {
    const panel = document.createElement('div');
    Object.assign(panel.style, panelStyle);

    const header = document.createElement('div');
    Object.assign(header.style, headerStyle);
    header.textContent = '🎛 坦克调参';
    const body = document.createElement('div');
    body.style.display = 'none'; // 默认收起，点击标题展开
    header.onclick = (): void => {
      body.style.display = body.style.display === 'none' ? 'block' : 'none';
    };
    panel.appendChild(header);
    panel.appendChild(body);

    for (const t of TUNABLES) {
      const row = document.createElement('div');
      Object.assign(row.style, rowStyle);

      const lab = document.createElement('div');
      Object.assign(lab.style, labelStyle);
      const name = document.createElement('span');
      name.textContent = t.label;
      const val = document.createElement('span');
      Object.assign(val.style, valStyle);
      val.textContent = this.getConfig(t.path).toFixed(t.digits);
      lab.appendChild(name);
      lab.appendChild(val);

      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = String(t.min);
      slider.max = String(t.max);
      slider.step = String(t.step);
      slider.value = String(this.getConfig(t.path));
      Object.assign(slider.style, sliderStyle);
      slider.oninput = (): void => {
        const n = parseFloat(slider.value);
        this.setConfig(t.path, n);
        val.textContent = n.toFixed(t.digits);
        this.persist(t.path, n);
        log.info('tuning changed', { path: t.path, val: n });
      };

      row.appendChild(lab);
      row.appendChild(slider);
      body.appendChild(row);
    }

    // —— 调试:坦克切换 + 模拟受击(验证损坏链,无需 AI 攻击者) ——
    if (hooks && (hooks.simulatePlayerHit || hooks.simulateStaticHit || hooks.switchTank)) {
      const dbgTitle = document.createElement('div');
      Object.assign(dbgTitle.style, dbgTitleStyle);
      dbgTitle.textContent = '🧪 调试工具';
      body.appendChild(dbgTitle);

      if (hooks.switchTank) {
        this.tankNameLabel = document.createElement('div');
        Object.assign(this.tankNameLabel.style, dbgLabelStyle);
        this.tankNameLabel.textContent = '当前: —';
        body.appendChild(this.tankNameLabel);

        const btn = document.createElement('button');
        btn.textContent = '切换坦克 (Tab)';
        Object.assign(btn.style, dbgBtnStyle);
        btn.onclick = (): void => hooks.switchTank!();
        body.appendChild(btn);
      }

      if (hooks.simulatePlayerHit) {
        const btn = document.createElement('button');
        btn.textContent = '模拟受击(玩家)';
        Object.assign(btn.style, dbgBtnStyle);
        btn.onclick = (): void => hooks.simulatePlayerHit!();
        body.appendChild(btn);
      }
      if (hooks.simulateStaticHit) {
        const btn = document.createElement('button');
        btn.textContent = '模拟受击(静态)';
        Object.assign(btn.style, dbgBtnStyle);
        btn.onclick = (): void => hooks.simulateStaticHit!();
        body.appendChild(btn);
      }
    }

    const reset = document.createElement('button');
    reset.textContent = '恢复默认';
    Object.assign(reset.style, resetBtnStyle);
    reset.onclick = (): void => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (e) {
        /* ignore */
      }
      location.reload();
    };
    body.appendChild(reset);

    document.body.appendChild(panel);
  }
}

// ---- 样式(沿用 HUD 的 Partial<CSSStyleDeclaration> 风格) ----
const panelStyle: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  top: '12px',
  right: '12px',
  zIndex: '100',
  background: 'rgba(20,22,28,0.88)',
  color: '#e6e6e6',
  padding: '10px 12px',
  borderRadius: '8px',
  fontFamily: 'monospace',
  fontSize: '12px',
  minWidth: '230px',
  boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
  backdropFilter: 'blur(4px)',
  userSelect: 'none',
};
const headerStyle: Partial<CSSStyleDeclaration> = {
  fontWeight: 'bold',
  marginBottom: '8px',
  cursor: 'pointer',
};
const rowStyle: Partial<CSSStyleDeclaration> = {
  marginBottom: '8px',
};
const labelStyle: Partial<CSSStyleDeclaration> = {
  display: 'flex',
  justifyContent: 'space-between',
  marginBottom: '2px',
};
const valStyle: Partial<CSSStyleDeclaration> = {
  color: '#8fd3a8',
  minWidth: '48px',
  textAlign: 'right',
};
const sliderStyle: Partial<CSSStyleDeclaration> = {
  width: '100%',
  margin: '0',
};
const resetBtnStyle: Partial<CSSStyleDeclaration> = {
  marginTop: '4px',
  width: '100%',
  padding: '5px',
  background: '#3a4048',
  color: '#e6e6e6',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: '12px',
};
const dbgTitleStyle: Partial<CSSStyleDeclaration> = {
  marginTop: '6px',
  marginBottom: '4px',
  fontWeight: 'bold',
  color: '#ffb86b',
};
const dbgLabelStyle: Partial<CSSStyleDeclaration> = {
  marginBottom: '4px',
  color: '#e6e6e6',
  fontSize: '12px',
};
const dbgBtnStyle: Partial<CSSStyleDeclaration> = {
  width: '100%',
  padding: '5px',
  marginBottom: '4px',
  background: '#5a3a2a',
  color: '#ffe6cc',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  fontFamily: 'monospace',
  fontSize: '12px',
};
