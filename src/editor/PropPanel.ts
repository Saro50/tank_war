/**
 * PropPanel — 右侧属性编辑面板
 * ------------------------------------------------------------
 * 递归生成表单控件。被约束的字段显示 🔗/🔓 状态图标:
 *  - 🔗 bound:被约束(默认跟随父),点击 → 解锁(🔒 固定当前位置,手动定位)
 *  - 🔒 locked:已解锁(手动定位,不跟随),点击 → 恢复约束
 *  - 无图标 free:自由字段(非约束 child)
 */
import { keyToLabel } from './ParamTree';

/** 约束状态 */
type ConstraintStatus = 'free' | 'bound' | 'locked';
/** 查询字段约束状态(UI 图标用) */
export type StatusOf = (path: string) => ConstraintStatus;
/** 切换字段锁定(UI 点击用) */
export type ToggleLock = (path: string) => void;

/** 滑块范围预设 */
const RANGE_HINTS: Record<string, [number, number, number]> = {
  bottomHalfX: [0.2, 2.0, 0.01], topHalfX: [0.2, 2.0, 0.01],
  bottomHalfZ: [0.5, 4.0, 0.01], topHalfZ: [0.5, 4.0, 0.01],
  halfX: [0.01, 0.6, 0.01], halfY: [0.01, 0.6, 0.01], halfZ: [0.1, 3.0, 0.01],
  frontHalfZ: [0.2, 1.5, 0.01], backHalfZ: [0.1, 1.0, 0.01],
  height: [0.01, 2.0, 0.01], length: [0.01, 4.0, 0.01], radius: [0.005, 0.5, 0.001],
  halfWidth: [0.02, 0.4, 0.01], halfDepth: [0.1, 1.0, 0.01], halfHeight: [0.1, 1.5, 0.01], halfThick: [0.005, 0.05, 0.001],
  offsetX: [0, 2.0, 0.01], offsetY: [-1.0, 2.0, 0.01], offsetZ: [-2.0, 2.0, 0.01], centerY: [-1.0, 2.0, 0.01],
  x: [-2.0, 2.0, 0.01], y: [-1.0, 2.0, 0.01], z: [-2.0, 2.0, 0.01],
  baseX: [0, 1.5, 0.01], baseY: [0, 1.5, 0.01], baseZ: [-2.0, 0, 0.01],
  count: [1, 12, 1], texRepeat: [1, 20, 1], rollScale: [0.1, 3.0, 0.1], zSpan: [0.2, 3.0, 0.01],
  barrelLen: [0.1, 1.0, 0.01], barrelRadius: [0.005, 0.05, 0.001], posRatio: [0, 1, 0.01], tilt: [0, 1.0, 0.01], wear: [0, 1, 0.01],
};

function isColorValue(key: string, value: unknown): boolean {
  if (/color/i.test(key)) return true;
  if (key === 'base' || key === 'blobDark' || key === 'blobMid') return true;
  if (typeof value === 'number' && value > 0x100000 && Number.isInteger(value)) return true;
  return false;
}
function isIntegerValue(key: string): boolean {
  return ['count', 'texRepeat'].includes(key);
}
function isBoolValue(key: string): boolean {
  return ['cross', 'zHalfStep', 'toothedSprocket'].includes(key);
}
function isSelectValue(key: string): boolean {
  return key === 'style';
}
const STYLE_OPTIONS = ['nato-blotch', 'stripe', 'splatter', 'two-tone', 'legacy'] as const;

/** 渲染上下文(避免参数透传爆炸:所有渲染函数共享) */
interface Ctx {
  getData: () => Record<string, unknown>;
  setData: (d: Record<string, unknown>) => void;
  onChange: (path: string[]) => void;
  statusOf?: StatusOf;
  toggleLock?: ToggleLock;
}

export function renderPropPanel(
  container: HTMLElement,
  path: string[],
  getData: () => Record<string, unknown>,
  setData: (newData: Record<string, unknown>) => void,
  onChange: (path: string[]) => void,
  statusOf?: StatusOf,
  toggleLock?: ToggleLock,
): void {
  container.innerHTML = '';
  const ctx: Ctx = { getData, setData, onChange, statusOf, toggleLock };
  let obj: unknown = getData();
  for (const key of path) {
    if (obj && typeof obj === 'object') obj = (obj as Record<string, unknown>)[key];
    else { container.innerHTML = '<div class="empty-state">无法定位参数</div>'; return; }
  }
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    renderObjectFields(container, path, obj as Record<string, unknown>, ctx, 0);
  } else {
    renderLeafField(container, path, path[path.length - 1] ?? '', obj, ctx, 0);
  }
}

function renderObjectFields(container: HTMLElement, basePath: string[], obj: Record<string, unknown>, ctx: Ctx, depth: number): void {
  for (const [key, value] of Object.entries(obj)) {
    const fullPath = [...basePath, key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      renderSubGroup(container, key, fullPath, value as Record<string, unknown>, ctx, depth);
    } else {
      renderLeafField(container, fullPath, key, value, ctx, depth);
    }
  }
}

function renderSubGroup(container: HTMLElement, label: string, fullPath: string[], obj: Record<string, unknown>, ctx: Ctx, depth: number): void {
  if (depth > 0) {
    const title = document.createElement('div');
    title.className = 'prop-label';
    title.style.cssText = `margin-left:${depth * 12}px;margin-top:10px;color:#ffcc33;font-size:12px;text-transform:none;`;
    title.textContent = keyToLabel(label);
    container.appendChild(title);
  }
  renderObjectFields(container, fullPath, obj, ctx, depth + 1);
}

function renderLeafField(container: HTMLElement, fullPath: string[], key: string, value: unknown, ctx: Ctx, depth: number): void {
  const groupDiv = document.createElement('div');
  groupDiv.className = 'prop-group';
  groupDiv.style.marginLeft = `${depth * 12}px`;

  const labelDiv = document.createElement('div');
  labelDiv.className = 'prop-label';
  labelDiv.textContent = keyToLabel(key);
  // 约束状态图标(🔗/🔒)
  appendConstraintIcon(labelDiv, fullPath.join('.'), ctx);
  groupDiv.appendChild(labelDiv);

  const update = (v: unknown): void => {
    setNested(ctx.getData(), fullPath, v);
    ctx.setData({ ...ctx.getData() });
    ctx.onChange(fullPath);
  };

  let row: HTMLElement;
  if (typeof value === 'boolean' || isBoolValue(key)) {
    row = createBoolRow(key, value as boolean, update as (v: boolean) => void);
  } else if (typeof value === 'string') {
    row = isSelectValue(key)
      ? createSelectRow(key, value, STYLE_OPTIONS, update as (v: string) => void)
      : createTextRow(key, value, update as (v: string) => void);
  } else if (typeof value === 'number') {
    row = isColorValue(key, value)
      ? createColorRow(key, value, update as (v: number) => void)
      : createNumberRow(key, value, RANGE_HINTS[key] ?? [0, 5, 0.01], isIntegerValue(key), update as (v: number) => void);
  } else {
    row = document.createElement('div');
    row.style.cssText = 'font-size:11px;color:#555;padding:4px 0;';
    row.textContent = value === null || value === undefined ? '未设置' : String(value);
  }
  groupDiv.appendChild(row);
  container.appendChild(groupDiv);
}

/** 在 label 后追加约束状态图标(bound=🔗 可解锁 / locked=🔒 可恢复) */
function appendConstraintIcon(labelDiv: HTMLElement, pathStr: string, ctx: Ctx): void {
  if (!ctx.statusOf) return;
  const status = ctx.statusOf(pathStr);
  if (status === 'free') return;
  const icon = document.createElement('span');
  icon.textContent = status === 'locked' ? '🔒' : '🔗';
  icon.style.cssText = 'margin-left:6px;cursor:pointer;font-size:13px;';
  icon.title = status === 'bound'
    ? '已约束(跟随父部件)。点击解锁 → 固定当前位置手动定位'
    : '已锁定(手动定位,不跟随)。点击恢复约束跟随';
  if (ctx.toggleLock) {
    icon.addEventListener('click', () => ctx.toggleLock!(pathStr));
  }
  labelDiv.appendChild(icon);
}

function setNested(obj: Record<string, unknown>, path: string[], value: unknown): void {
  let current = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const next = current[path[i]];
    if (next && typeof next === 'object') {
      current = next as Record<string, unknown>;
    } else {
      const newObj: Record<string, unknown> = {};
      current[path[i]] = newObj;
      current = newObj;
    }
  }
  current[path[path.length - 1]] = value;
}

function createNumberRow(key: string, value: number, range: [number, number, number], isInt: boolean, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const label = document.createElement('label');
  label.textContent = keyToLabel(key);
  row.appendChild(label);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(range[0]); slider.max = String(range[1]); slider.step = String(range[2]);
  slider.value = String(value);
  const numInput = document.createElement('input');
  numInput.type = 'number';
  numInput.step = String(isInt ? 1 : range[2]);
  numInput.min = String(range[0]); numInput.max = String(range[1]);
  numInput.value = isInt ? String(Math.round(value)) : String(value);
  const update = (v: number): void => {
    const clamped = Math.max(range[0], Math.min(range[1], v));
    const final = isInt ? Math.round(clamped) : clamped;
    slider.value = String(final);
    numInput.value = isInt ? String(Math.round(final)) : String(final);
    onChange(final);
  };
  slider.addEventListener('input', () => update(parseFloat(slider.value)));
  numInput.addEventListener('input', () => { const v = parseFloat(numInput.value); if (!isNaN(v)) update(v); });
  row.appendChild(slider);
  row.appendChild(numInput);
  return row;
}

function createColorRow(key: string, value: number, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const label = document.createElement('label');
  label.textContent = keyToLabel(key);
  row.appendChild(label);
  const swatch = document.createElement('div');
  swatch.className = 'color-swatch';
  swatch.style.background = numberToHex(value);
  row.appendChild(swatch);
  const hexLabel = document.createElement('span');
  hexLabel.className = 'hex-label';
  hexLabel.textContent = numberToHex(value);
  row.appendChild(hexLabel);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.style.display = 'none';
  colorInput.value = numberToHex(value);
  row.appendChild(colorInput);
  swatch.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', () => {
    const hex = colorInput.value;
    const num = parseInt(hex.replace('#', ''), 16);
    swatch.style.background = hex;
    hexLabel.textContent = hex;
    onChange(num);
  });
  return row;
}

function createTextRow(key: string, value: string, onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const label = document.createElement('label');
  label.textContent = keyToLabel(key);
  row.appendChild(label);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  Object.assign(input.style, { flex: '1', background: '#22242a', color: '#e6e6e6', border: '1px solid #3a3c42', borderRadius: '3px', padding: '3px 6px', fontFamily: 'monospace', fontSize: '12px' });
  input.addEventListener('input', () => onChange(input.value));
  row.appendChild(input);
  return row;
}

function createBoolRow(key: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const label = document.createElement('label');
  label.textContent = keyToLabel(key);
  row.appendChild(label);
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = value;
  toggle.style.accentColor = '#4a8aff';
  toggle.addEventListener('change', () => onChange(toggle.checked));
  row.appendChild(toggle);
  return row;
}

function createSelectRow(key: string, value: string, options: readonly string[], onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const label = document.createElement('label');
  label.textContent = keyToLabel(key);
  row.appendChild(label);
  const select = document.createElement('select');
  Object.assign(select.style, { flex: '1', background: '#22242a', color: '#e6e6e6', border: '1px solid #3a3c42', borderRadius: '3px', padding: '3px 6px', fontFamily: 'monospace', fontSize: '12px', cursor: 'pointer' });
  for (const opt of options) {
    const option = document.createElement('option');
    option.value = opt;
    option.textContent = opt;
    option.selected = opt === value;
    select.appendChild(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  row.appendChild(select);
  return row;
}

function numberToHex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}
