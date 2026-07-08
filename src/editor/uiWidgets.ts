/**
 * uiWidgets.ts — 共享表单控件(PartPropPanel/TankPropPanel 复用,DRY)
 * ============================================================
 * 从原 PropPanel 的 create*Row 提取,去 keyToLabel 映射(标签直接传)。
 * 复用 editor.html 的 .prop-row/.prop-label/.color-swatch 等 CSS。
 */
type Vec3 = { x: number; y: number; z: number };

/** 数值行:label + 滑块 + 数值框 */
export function numberRow(label: string, value: number, range: [number, number, number], isInt: boolean, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
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

/** 三轴数值行:label + X/Y/Z 三个数值框(紧凑,用于 position/offset/half 等) */
export function vec3Row(label: string, vec: Vec3, range: [number, number, number], onChange: (v: Vec3) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.style.alignSelf = 'flex-start';
  lab.style.marginTop = '2px';
  row.appendChild(lab);
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:4px;flex:1;';
  const axes: (keyof Vec3)[] = ['x', 'y', 'z'];
  const axisColor: Record<string, string> = { x: '#ff6b6b', y: '#6bff6b', z: '#6b9bff' };
  // 跟踪当前值:多轴顺序编辑时,避免闭包捕获初始 vec 导致后改的轴用旧值覆盖(跳变 bug)。
  // 不可变更新会使父组件的 part.position 换新对象,但本闭包的 vec 仍指旧对象 → 必须自管 current。
  const current: Vec3 = { ...vec };
  for (const ax of axes) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = String(range[2]);
    inp.value = String(current[ax]);
    inp.style.cssText = `width:60px;background:#22242a;color:${axisColor[ax]};border:1px solid #3a3c42;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;text-align:right;`;
    const axLabel = document.createElement('span');
    axLabel.textContent = ax.toUpperCase();
    axLabel.style.cssText = `color:${axisColor[ax]};font-size:10px;width:10px;text-align:center;`;
    const cell = document.createElement('div');
    cell.style.cssText = 'display:flex;align-items:center;gap:3px;';
    cell.appendChild(axLabel);
    cell.appendChild(inp);
    wrap.appendChild(cell);
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) {
        current[ax] = v;         // 先更新当前轴
        onChange({ ...current }); // 传完整最新值(其余轴保持已编辑的最新,不用旧 vec 覆盖)
      }
    });
  }
  row.appendChild(wrap);
  return row;
}

/** 颜色行:label + 色块 + hex + 隐藏 input[color] */
export function colorRow(label: string, value: number, onChange: (v: number) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
  const hex = '#' + value.toString(16).padStart(6, '0');
  const swatch = document.createElement('div');
  swatch.className = 'color-swatch';
  swatch.style.background = hex;
  row.appendChild(swatch);
  const hexLabel = document.createElement('span');
  hexLabel.className = 'hex-label';
  hexLabel.textContent = hex;
  row.appendChild(hexLabel);
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.style.display = 'none';
  colorInput.value = hex;
  row.appendChild(colorInput);
  swatch.addEventListener('click', () => colorInput.click());
  colorInput.addEventListener('input', () => {
    const num = parseInt(colorInput.value.replace('#', ''), 16);
    swatch.style.background = colorInput.value;
    hexLabel.textContent = colorInput.value;
    onChange(num);
  });
  return row;
}

/** 下拉行 */
export function selectRow(label: string, value: string, options: readonly string[], onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
  const sel = document.createElement('select');
  Object.assign(sel.style, { flex: '1', background: '#22242a', color: '#e6e6e6', border: '1px solid #3a3c42', borderRadius: '3px', padding: '3px 6px', fontFamily: 'monospace', fontSize: '12px', cursor: 'pointer' });
  for (const opt of options) {
    const o = document.createElement('option');
    o.value = opt; o.textContent = opt; o.selected = opt === value;
    sel.appendChild(o);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  row.appendChild(sel);
  return row;
}

/** 布尔行 */
export function boolRow(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = value;
  cb.style.accentColor = '#4a8aff';
  cb.addEventListener('change', () => onChange(cb.checked));
  row.appendChild(cb);
  return row;
}

/** 文本行 */
export function textRow(label: string, value: string, onChange: (v: string) => void): HTMLElement {
  const row = document.createElement('div');
  row.className = 'prop-row';
  const lab = document.createElement('label');
  lab.textContent = label;
  row.appendChild(lab);
  const inp = document.createElement('input');
  inp.type = 'text';
  inp.value = value;
  Object.assign(inp.style, { flex: '1', background: '#22242a', color: '#e6e6e6', border: '1px solid #3a3c42', borderRadius: '3px', padding: '3px 6px', fontFamily: 'monospace', fontSize: '12px' });
  inp.addEventListener('input', () => onChange(inp.value));
  row.appendChild(inp);
  return row;
}

/** 分组标题(分隔不同属性区) */
export function groupTitle(text: string): HTMLElement {
  const t = document.createElement('div');
  t.style.cssText = 'margin:10px 0 4px;color:#ffcc33;font-size:12px;border-bottom:1px solid #2a2c32;padding-bottom:2px;';
  t.textContent = text;
  return t;
}
