/**
 * editor.ts — 坦克模型编辑器主入口(单一 TankModel 模式)
 * ============================================================
 * 数据流(改造后,与游戏共用同一套 TankModel 抽象):
 *   车型管理区选车 → 加载 TankModel(官方=convert,自定义=GET JSON) → buildCustom 预览
 *   部件操作(addPart/updatePart/...) → currentModel 变 → rebuild → 保存(PUT)
 *
 * 复用游戏的抽象(所见即所得):
 *   - TankVisualBuilder.buildCustom:与游戏共用的唯一几何构建源
 *   - TankModelSchema:数据契约;resolveTankModel:缺省兜底
 *   - convertXxxFromConfig:官方车型转 TankModel(只读展示 + 复制新建)
 *
 * 单一模式:无官方/自定义双轨,只有 TankModel 编辑(官方=只读+可另存,自定义=完整CRUD)。
 */
import { AmbientLight, AxesHelper, DirectionalLight, GridHelper, Material, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, Raycaster, Scene, Vector2, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TankVisualBuilder, type BuiltVisuals } from '../entities/TankVisualBuilder';
import { TANK_VARIANTS, TANK_VARIANT_LABELS, TankModelSchema, type TankModel, type TankVariant, type TankPart } from '../data/TankSchema';
import { convertT14FromConfig, convertTigerFromConfig, convertAbramsFromConfig } from '../data/convertLegacy';
import { resolveTankModel } from '../data/modelOps';
import { addPart, removePart, updatePart, movePart, duplicatePart } from './modelOps';
import { renderPartList } from './PartList';
import { renderPartPropPanel } from './PartPropPanel';
import { renderTankPropPanel } from './TankPropPanel';
import { Logger } from '../utils/Logger';

const log = Logger.create('editor');

// ============================================================
// 视口初始化(场景/相机/灯光/轨道控制)
// ============================================================
const viewport = document.getElementById('viewport')!;
const renderer = new WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(viewport.clientWidth, viewport.clientHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = 1;
renderer.setClearColor(0x0e1014);
viewport.prepend(renderer.domElement);

const scene = new Scene();
scene.add(new AmbientLight(0x404060, 0.6));
const dirLight = new DirectionalLight(0xffeedd, 1.8);
dirLight.position.set(15, 25, 10);
dirLight.castShadow = true;
scene.add(dirLight);
const fillLight = new DirectionalLight(0x8888ff, 0.4);
fillLight.position.set(-10, 5, -10);
scene.add(fillLight);

const grid = new GridHelper(20, 20, 0x333355, 0x222244);
grid.position.y = -0.8;
scene.add(grid);
scene.add(new AxesHelper(3));

const camera = new PerspectiveCamera(40, viewport.clientWidth / viewport.clientHeight, 0.1, 100);
camera.position.set(6, 5, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.update();

// ============================================================
// DOM 引用 + 状态
// ============================================================
const treeHeader = document.getElementById('tree-header')!;
const treeBody = document.getElementById('tree-body')!;
const propHeader = document.getElementById('prop-header')!;
const propBody = document.getElementById('prop-body')!;
const btnSave = document.getElementById('btn-export') as HTMLButtonElement;
const btnImport = document.getElementById('btn-import') as HTMLButtonElement;

type Mode = 'none' | 'official' | 'custom';
let mode: Mode = 'none';
let officialVariant: TankVariant | undefined;
let customId: string | undefined;
let currentModel: TankModel | undefined;
let selectedPartId: string | undefined;
let dirty = false;
let built: BuiltVisuals | undefined;
let rightTab: 'part' | 'tank' = 'part';
let wireframeMode = false;
let snapEnabled = false;
const SNAP_GRID = 0.05;
let pendingDeleteId: string | undefined; // 两步删除确认:第一次点标记,第二次点执行

interface CustomMeta { id: string; name: string; partsCount: number; mass: number; isStatic: boolean }
let customList: CustomMeta[] = [];

// ============================================================
// 车型管理区(左栏顶部)
// ============================================================
function renderTankManager(): void {
  treeHeader.innerHTML = '';
  treeHeader.style.cssText = 'flex-direction:column;align-items:stretch;gap:6px;padding:8px 10px;';

  // 标题 + 新建按钮
  const titleRow = document.createElement('div');
  titleRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;';
  const title = document.createElement('span');
  title.textContent = '📐 坦克模型';
  title.style.cssText = 'font-size:13px;font-weight:bold;color:#ffcc33;';
  const newBtn = document.createElement('button');
  newBtn.textContent = '＋ 新建';
  newBtn.style.cssText = 'background:#3a4a1a;color:#ffcc33;border:1px solid #5a6a2a;border-radius:3px;padding:2px 8px;cursor:pointer;font-family:monospace;font-size:11px;';
  newBtn.addEventListener('click', openNewModal);
  titleRow.appendChild(title);
  titleRow.appendChild(newBtn);
  treeHeader.appendChild(titleRow);

  // 官方车型组(只读)
  const officialTitle = document.createElement('div');
  officialTitle.textContent = '官方车型(只读)';
  officialTitle.style.cssText = 'font-size:10px;color:#666;margin-top:4px;';
  treeHeader.appendChild(officialTitle);
  for (const v of TANK_VARIANTS) {
    treeHeader.appendChild(mkTankItem(TANK_VARIANT_LABELS[v], '🔒', mode === 'official' && officialVariant === v, false, () => selectOfficial(v)));
  }

  // 自定义车型组
  const customTitle = document.createElement('div');
  customTitle.textContent = `我的车型(${customList.length})`;
  customTitle.style.cssText = 'font-size:10px;color:#666;margin-top:6px;';
  treeHeader.appendChild(customTitle);
  if (customList.length === 0) {
    const empty = document.createElement('div');
    empty.textContent = '点"新建"创建';
    empty.style.cssText = 'font-size:11px;color:#444;padding:2px 14px;';
    treeHeader.appendChild(empty);
  } else {
    for (const c of customList) {
      treeHeader.appendChild(mkTankItem(c.name, '🛠', mode === 'custom' && customId === c.id, true, () => selectCustom(c.id), c.id, () => void deleteCustom(c.id)));
    }
  }
}

/** 车型项(官方/自定义共用)。custom=true 时 hover 出删除按钮 */
function mkTankItem(name: string, icon: string, active: boolean, custom: boolean, onClick: () => void, id?: string, onDelete?: () => void): HTMLElement {
  const item = document.createElement('div');
  item.style.cssText = `display:flex;align-items:center;gap:6px;padding:4px 10px;cursor:pointer;font-size:12px;color:${active ? '#7fff7f' : '#ccc'};background:${active ? '#2a3a2a' : 'transparent'};border-radius:3px;margin:1px 4px;`;
  item.addEventListener('mouseenter', () => { if (!active) item.style.background = '#22242a'; });
  item.addEventListener('mouseleave', () => { if (!active) item.style.background = 'transparent'; });
  item.addEventListener('click', onClick);
  const ic = document.createElement('span');
  ic.textContent = icon;
  ic.style.width = '16px';
  item.appendChild(ic);
  const nm = document.createElement('span');
  nm.textContent = name;
  nm.style.flex = '1';
  nm.style.overflow = 'hidden';
  nm.style.textOverflow = 'ellipsis';
  nm.style.whiteSpace = 'nowrap';
  item.appendChild(nm);
  // 自定义项 hover 出删除
  if (custom) {
    const del = document.createElement('button');
    const isPending = pendingDeleteId === id;
    del.textContent = isPending ? '⚠确认?' : '✕';
    del.title = isPending ? '再点一次确认删除(3秒后自动取消)' : '删除';
    del.style.cssText = `background:${isPending ? '#5a2a2a' : '#3a1a1a'};color:#ff8888;border:1px solid ${isPending ? '#8a4a4a' : '#5a2a2a'};border-radius:2px;padding:0 4px;cursor:pointer;font-size:10px;${isPending ? 'display:block;' : 'display:none;'}`;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pendingDeleteId === id) {
        onDelete!(); // 第二次:执行删除(custom 时调用方必传)
      } else {
        pendingDeleteId = id; // 第一次:标记待删,3秒后自动取消
        renderTankManager();
        setTimeout(() => { if (pendingDeleteId === id) { pendingDeleteId = undefined; renderTankManager(); } }, 3000);
      }
    });
    item.appendChild(del);
    if (!isPending) {
      item.addEventListener('mouseenter', () => { del.style.display = 'block'; });
      item.addEventListener('mouseleave', () => { del.style.display = 'none'; });
    }
  }
  return item;
}

// ============================================================
// 自定义列表加载
// ============================================================
async function fetchCustomList(): Promise<void> {
  try {
    const resp = await fetch('/api/custom-tanks');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    customList = data.tanks as CustomMeta[];
    renderTankManager();
  } catch (e) {
    log.error('fetch custom list failed', e);
    showStatus(`加载自定义列表失败:${String(e)}`, 'error');
  }
}

// ============================================================
// 新建模态(选起点 + 命名)
// ============================================================
function openNewModal(): void {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:100;';
  const modal = document.createElement('div');
  modal.style.cssText = 'background:#1a1c22;border:1px solid #3a3c42;border-radius:8px;padding:20px;width:360px;color:#e6e6e6;font-family:monospace;';
  modal.innerHTML = `<div style="font-size:14px;font-weight:bold;color:#ffcc33;margin-bottom:12px;">新建坦克</div>
    <div style="font-size:11px;color:#888;margin-bottom:6px;">选择起点:</div>`;

  const choose = (label: string, basedOn: TankVariant | 'blank', icon: string): void => {
    const card = document.createElement('div');
    card.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px;margin:4px 0;background:#22242a;border:1px solid #3a3c42;border-radius:4px;cursor:pointer;';
    card.innerHTML = `<span style="font-size:18px;">${icon}</span><span style="font-size:12px;">${label}</span>`;
    card.addEventListener('mouseenter', () => { card.style.background = '#2a3a2a'; });
    card.addEventListener('mouseleave', () => { card.style.background = '#22242a'; });
    card.addEventListener('click', () => promptName(basedOn));
    modal.appendChild(card);
  };
  choose('空白模板(5 默认部件)', 'blank', '⬜');
  for (const v of TANK_VARIANTS) {
    choose(`基于 ${TANK_VARIANT_LABELS[v]}`, v, '📋');
  }

  const close = document.createElement('button');
  close.textContent = '取消';
  close.style.cssText = 'margin-top:10px;width:100%;padding:6px;background:#2a2c32;color:#ccc;border:1px solid #3a3c42;border-radius:4px;cursor:pointer;';
  close.addEventListener('click', () => overlay.remove());
  modal.appendChild(close);

  overlay.appendChild(modal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);

  function promptName(basedOn: TankVariant | 'blank'): void {
    modal.innerHTML = `<div style="font-size:14px;font-weight:bold;color:#ffcc33;margin-bottom:12px;">命名坦克</div>
      <input id="new-name" type="text" placeholder="如:我的虎王" style="width:100%;background:#22242a;color:#e6e6e6;border:1px solid #3a3c42;border-radius:3px;padding:6px;font-family:monospace;font-size:12px;margin-bottom:10px;">`;
    const inp = modal.querySelector('#new-name') as HTMLInputElement;
    inp.focus();
    const confirm = document.createElement('button');
    confirm.textContent = '创建';
    confirm.style.cssText = 'width:100%;padding:6px;background:#2a3a2a;color:#7fff7f;border:1px solid #3a5a3a;border-radius:4px;cursor:pointer;';
    const submit = (): void => {
      const name = inp.value.trim();
      if (!name) { inp.style.borderColor = '#ff4444'; return; }
      overlay.remove();
      void createCustom(name, basedOn === 'blank' ? undefined : basedOn);
    };
    confirm.addEventListener('click', submit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    modal.appendChild(confirm);
  }
}

async function createCustom(name: string, basedOn: TankVariant | undefined): Promise<void> {
  try {
    const resp = await fetch('/api/custom-tanks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, basedOn }),
    });
    if (!resp.ok) throw new Error((await resp.json()).error ?? `HTTP ${resp.status}`);
    const { id } = await resp.json();
    log.info('created custom tank', { id, name, basedOn });
    await fetchCustomList();
    await selectCustom(id);
  } catch (e) {
    showStatus(`新建失败:${String(e)}`, 'error');
  }
}

async function deleteCustom(id: string): Promise<void> {
  pendingDeleteId = undefined;
  try {
    const resp = await fetch(`/api/custom-tanks/${id}`, { method: 'DELETE' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    log.info('deleted custom tank', { id });
    if (customId === id) {
      customId = undefined;
      currentModel = undefined;
      mode = 'none';
      selectedPartId = undefined;
      if (built) { scene.remove(built.group); TankVisualBuilder.dispose(built.resources); built = undefined; }
    }
    await fetchCustomList();
    renderAll();
    showStatus('已删除', 'ok');
  } catch (e) {
    showStatus(`删除失败:${String(e)}`, 'error');
  }
}

// ============================================================
// 模式切换
// ============================================================
async function selectOfficial(v: TankVariant): Promise<void> {
  if (dirty && mode === 'custom') log.warn('切换车型丢弃未保存更改', { from: customId });
  mode = 'official';
  officialVariant = v;
  customId = undefined;
  selectedPartId = undefined;
  dirty = false;
  // 官方:convert 临时生成 TankModel(只读展示)
  currentModel = v === 't14' ? convertT14FromConfig() : v === 'tiger' ? convertTigerFromConfig() : convertAbramsFromConfig();
  renderTankManager();
  rebuild();
  renderAll();
  log.info('official selected', { variant: v });
}

async function selectCustom(id: string): Promise<void> {
  if (dirty && mode === 'custom' && customId !== id) log.warn('切换车型丢弃未保存更改', { from: customId });
  try {
    const resp = await fetch(`/api/custom-tanks/${id}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json();
    const parsed = TankModelSchema.safeParse(json);
    if (!parsed.success) throw new Error(`数据不合法:${parsed.error.issues.length} 处错误`);
    mode = 'custom';
    customId = id;
    officialVariant = undefined;
    currentModel = parsed.data as TankModel;
    selectedPartId = undefined;
    dirty = false;
    rightTab = 'tank';
    renderTankManager();
    rebuild();
    renderAll();
    log.info('custom selected', { id });
  } catch (e) {
    showStatus(`加载失败:${String(e)}`, 'error');
  }
}

// ============================================================
// rebuild(用 buildCustom,与游戏共用)
// ============================================================
function rebuild(): void {
  if (!currentModel) return;
  const resolved = resolveTankModel(currentModel);
  let next: BuiltVisuals;
  try {
    next = TankVisualBuilder.buildCustom(resolved, { camoSeed: 1 });
  } catch (e) {
    log.error('rebuild failed, kept old model', e);
    return;
  }
  if (built) {
    scene.remove(built.group);
    TankVisualBuilder.dispose(built.resources);
  }
  built = next;
  built.turret.userData.partName = 'turret';
  built.barrel.userData.partName = 'barrel';
  scene.add(built.group);
  applyWireframe(built.group, wireframeMode);
  resetMotion();
  applyHighlight(selectedPartId); // rebuild 后材质重建,重新高亮选中部件
}

// ============================================================
// 左右栏渲染
// ============================================================
function renderAll(): void {
  renderLeft();
  renderRight();
  updateDirtyUI();
}

function renderLeft(): void {
  treeBody.innerHTML = '';
  if (mode === 'custom' && currentModel) {
    // 自定义:PartList(可编辑)
    renderPartList(treeBody, currentModel, selectedPartId, {
      onSelect: onPartSelect,
      onAdd: onPartAdd,
      onRemove: onPartRemove,
      onMove: onPartMove,
      onDuplicate: onPartDuplicate,
    });
  } else if (mode === 'official' && currentModel) {
    // 官方:只读部件列表
    const hint = document.createElement('div');
    hint.style.cssText = 'padding:10px 14px;font-size:11px;color:#888;line-height:1.6;';
    hint.innerHTML = `🔒 <b>只读基准</b><br>部件数:${currentModel.parts.length}<br>质量:${currentModel.mass}kg<br><br>点"基于此新建"可复制修改。`;
    const btn = document.createElement('button');
    btn.textContent = '基于此新建';
    btn.style.cssText = 'display:block;width:calc(100% - 24px);margin:8px 12px;padding:6px;background:#3a4a1a;color:#ffcc33;border:1px solid #5a6a2a;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;';
    btn.addEventListener('click', () => { if (officialVariant) void createCustom(currentModel!.name + ' 副本', officialVariant); });
    treeBody.appendChild(hint);
    treeBody.appendChild(btn);
    // 只读部件列表
    for (const p of currentModel.parts) {
      const item = document.createElement('div');
      item.style.cssText = 'padding:4px 14px;font-size:11px;color:#777;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      item.textContent = `${p.name} [${p.partType}${p.role ? '/' + p.role : ''}]`;
      treeBody.appendChild(item);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = '从上方选择车型或新建';
    treeBody.appendChild(empty);
  }
}

function renderRight(): void {
  propBody.innerHTML = '';
  if (!currentModel) {
    propBody.innerHTML = '<div class="empty-state">未选择车型</div>';
    return;
  }
  if (mode === 'official') {
    // 官方:只读整车属性
    propHeader.textContent = `${currentModel.name}(只读)`;
    renderTankPropPanel(propBody, currentModel, () => { /* 只读,不响应 */ });
    return;
  }
  // 自定义:tab 切换(部件/整车)
  propHeader.textContent = currentModel.name + (dirty ? ' *' : '');
  const tabBar = document.createElement('div');
  tabBar.style.cssText = 'display:flex;gap:4px;margin-bottom:8px;border-bottom:1px solid #2a2c32;padding-bottom:4px;';
  const mkTab = (label: string, tab: 'part' | 'tank'): void => {
    const t = document.createElement('button');
    t.textContent = label;
    t.style.cssText = `flex:1;padding:4px;background:${rightTab === tab ? '#2a3a2a' : 'transparent'};color:${rightTab === tab ? '#7fff7f' : '#888'};border:1px solid ${rightTab === tab ? '#3a5a3a' : '#2a2c32'};border-radius:3px;cursor:pointer;font-family:monospace;font-size:11px;`;
    t.addEventListener('click', () => { rightTab = tab; renderRight(); });
    tabBar.appendChild(t);
  };
  mkTab('部件属性', 'part');
  mkTab('整车属性', 'tank');
  propBody.appendChild(tabBar);

  if (rightTab === 'part') {
    const part = selectedPartId ? currentModel.parts.find((p) => p.id === selectedPartId) : undefined;
    if (part) {
      renderPartPropPanel(propBody, part, (patch) => onPartChange(part.id, patch));
    } else {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = '从左侧选择部件,或切到"整车属性"';
      propBody.appendChild(empty);
    }
  } else {
    renderTankPropPanel(propBody, currentModel, (patch) => onTankChange(patch));
  }
}

// ============================================================
// 部件操作回调
// ============================================================
function onPartSelect(id: string): void {
  selectedPartId = id;
  rightTab = 'part';
  applyHighlight(id);
  renderLeft();
  renderRight();
}

function onPartAdd(): void {
  if (!currentModel) return;
  // 简单:弹形状选择(box/cylinder),默认 decorative
  const shape = prompt('形状(box/cylinder/wedge)', 'box') as TankPart['shape'];
  if (!shape) return;
  const partType = prompt('部位类型(hull/turret/barrel/track/wheel/decorative)', 'decorative') as TankPart['partType'];
  if (!partType) return;
  const id = `p${currentModel.parts.length + 1}-${Date.now().toString(36).slice(-3)}`;
  let partial: Omit<TankPart, 'id'>;
  if (shape === 'box') {
    partial = { name: '新部件', partType, shape: 'box', half: { x: 0.2, y: 0.2, z: 0.2 }, position: { x: 0, y: 0.5, z: 0 }, color: 0x555555 };
  } else if (shape === 'cylinder') {
    partial = { name: '新部件', partType, shape: 'cylinder', radius: 0.1, height: 0.3, position: { x: 0, y: 0.5, z: 0 }, color: 0x555555 };
  } else {
    partial = { name: '新部件', partType, shape: 'wedge', wedge: { mode: 'symmetric', bottomHalfX: 0.3, topHalfX: 0.25, bottomHalfZ: 0.4, topHalfZ: 0.3, height: 0.3, centerY: 0 }, position: { x: 0, y: 0.5, z: 0 }, color: 0x555555 };
  }
  const { model, id: newId } = addPart(currentModel, { ...partial, id });
  currentModel = model;
  selectedPartId = newId;
  markDirty();
  rebuild();
  renderLeft();
  renderRight();
}

function onPartRemove(id: string): void {
  if (!currentModel) return;
  currentModel = removePart(currentModel, id);
  if (selectedPartId === id) selectedPartId = undefined;
  markDirty();
  rebuild();
  renderLeft();
  renderRight();
}

function onPartMove(id: string, dir: -1 | 1): void {
  if (!currentModel) return;
  currentModel = movePart(currentModel, id, dir);
  markDirty();
  renderLeft();
}

function onPartDuplicate(id: string): void {
  if (!currentModel) return;
  const result = duplicatePart(currentModel, id);
  if (result) {
    currentModel = result.model;
    selectedPartId = result.newId;
    markDirty();
    rebuild();
    renderLeft();
    renderRight();
  }
}

function onPartChange(id: string, patch: Partial<TankPart>): void {
  if (!currentModel) return;
  // 网格吸附:position 改动时 snap(若启用),便于部件精确对齐
  if (snapEnabled && patch.position) {
    patch = { ...patch, position: snapVec3(patch.position) };
  }
  currentModel = updatePart(currentModel, id, patch);
  markDirty();
  rebuild();
  renderLeft();
  // shape/partType 是结构性变化(尺寸区/role 区整个换),需重渲染右栏显示新字段
  if (patch.shape || patch.partType) renderRight();
}

function onTankChange(patch: Partial<TankModel>): void {
  if (!currentModel) return;
  currentModel = { ...currentModel, ...patch };
  markDirty();
  rebuild();
  renderLeft();
}

function markDirty(): void {
  if (!dirty) { dirty = true; updateDirtyUI(); }
}

function updateDirtyUI(): void {
  btnSave.textContent = mode === 'custom' ? (dirty ? '💾 保存 *' : '💾 保存') : '💾 保存';
  btnSave.style.display = mode === 'custom' ? 'block' : 'none';
  btnImport.style.display = mode === 'custom' ? 'block' : 'none';
}

// ============================================================
// 保存/导入(自定义模式)
// ============================================================
async function saveCustom(): Promise<void> {
  if (mode !== 'custom' || !currentModel || !customId) return;
  // 前端先 schema 校验(后台也校验,双重保险)
  const parsed = TankModelSchema.safeParse(currentModel);
  if (!parsed.success) {
    showStatus(`保存失败:${parsed.error.issues.length} 处数据不合法`, 'error');
    return;
  }
  btnSave.disabled = true;
  btnSave.textContent = '保存中...';
  try {
    const resp = await fetch(`/api/custom-tanks/${customId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentModel),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error ?? `HTTP ${resp.status}`);
    }
    dirty = false;
    updateDirtyUI();
    renderRight();
    showStatus(`已保存(${customId})`, 'ok');
    log.info('saved', { id: customId });
  } catch (e) {
    showStatus(`保存失败:${String(e)}`, 'error');
    log.error('save failed', e);
  } finally {
    btnSave.disabled = false;
    updateDirtyUI();
  }
}

btnSave.addEventListener('click', () => void saveCustom());

btnImport.addEventListener('click', () => document.getElementById('file-input')?.click());
document.getElementById('file-input')?.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file || mode !== 'custom' || !currentModel) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string);
      const parsed = TankModelSchema.safeParse(data);
      if (!parsed.success) {
        showStatus(`导入文件不符合 schema:${parsed.error.issues.length} 处错误`, 'error');
        return;
      }
      // id 强制为当前 customId(防导入文件篡改 id);name/数据用导入文件
      currentModel = { ...(parsed.data as TankModel), id: customId! };
      rebuild();
      renderAll();
      markDirty();
      showStatus('已导入(需点保存)', 'ok');
    } catch {
      showStatus('JSON 解析失败', 'error');
    }
  };
  reader.readAsText(file);
});

// ============================================================
// 状态栏
// ============================================================
function showStatus(msg: string, kind: 'ok' | 'error'): void {
  const bar = document.getElementById('status-bar') ?? createStatusBar();
  bar.textContent = msg;
  bar.style.color = kind === 'ok' ? '#7fff7f' : '#ff8888';
}
function createStatusBar(): HTMLElement {
  const bar = document.createElement('div');
  bar.id = 'status-bar';
  bar.style.cssText = 'padding:6px 14px;font-size:11px;border-top:1px solid #2a2c32;min-height:20px;';
  document.getElementById('prop-panel')!.insertBefore(bar, document.getElementById('export-bar'));
  return bar;
}

// ============================================================
// 视口控制按钮
// ============================================================
document.querySelectorAll('[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = (btn as HTMLElement).dataset.view;
    const dist = 12;
    switch (view) {
      case 'front': camera.position.set(0, 0, dist); break;
      case 'top': camera.position.set(0, dist, 0.01); break;
      case 'side': camera.position.set(dist, 1, 0); break;
      case 'reset': camera.position.set(6, 5, 10); break;
    }
    controls.target.set(0, 0, 0);
    controls.update();
  });
});

function applyWireframe(root: { traverse: (cb: (o: unknown) => void) => void }, on: boolean): void {
  root.traverse((child) => {
    if (child instanceof Mesh) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) if (m) m.wireframe = on;
    }
  });
}

// —— 选中部件 3D 高亮 ——
// 选中 partId 的 mesh 克隆材质 + 提 emissive 发光;取消时还原原材质。
// 必须克隆:buildCustom 的材质按 materialKey 共享(多 part 复用),直接改 emissive 会污染所有同材质 mesh。
const highlightState = new Map<Mesh, Material>(); // mesh → 原 material(还原用)
function applyHighlight(partId: string | undefined): void {
  // 先还原所有高亮(防材质泄露)
  for (const [mesh, orig] of highlightState) mesh.material = orig;
  highlightState.clear();
  if (!partId || !built) return;
  built.group.traverse((obj) => {
    const mesh = obj as Mesh;
    if (!mesh.isMesh) return;
    let o: Object3D | null = mesh;
    while (o && !o.userData.partId) o = o.parent;
    if (o?.userData.partId === partId) {
      const orig = mesh.material as Material | Material[];
      const base = (Array.isArray(orig) ? orig[0] : orig) as MeshStandardMaterial;
      highlightState.set(mesh, base);
      const clone = base.clone();
      if (clone.emissive) clone.emissive.setHex(0x554411); // 暗金发光,辨识选中
      mesh.material = clone;
    }
  });
}
document.getElementById('btn-wireframe')?.addEventListener('click', () => {
  wireframeMode = !wireframeMode;
  if (built) applyWireframe(built.group, wireframeMode);
  (document.getElementById('btn-wireframe') as HTMLElement).style.borderColor = wireframeMode ? '#4a8aff' : '#3a3c42';
});

// 网格吸附开关(部件 position 对齐到 SNAP_GRID,便于精确摆放)
function snapVec3(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return {
    x: Math.round(v.x / SNAP_GRID) * SNAP_GRID,
    y: Math.round(v.y / SNAP_GRID) * SNAP_GRID,
    z: Math.round(v.z / SNAP_GRID) * SNAP_GRID,
  };
}
const btnSnap = document.createElement('button');
btnSnap.textContent = '吸附';
btnSnap.title = `网格吸附 ${SNAP_GRID}m(部件位置对齐)`;
btnSnap.style.cssText = 'background:rgba(30,34,42,0.8);color:#ccc;border:1px solid #3a3c42;border-radius:4px;padding:4px 8px;font-family:monospace;font-size:11px;cursor:pointer;';
btnSnap.addEventListener('click', () => {
  snapEnabled = !snapEnabled;
  btnSnap.style.borderColor = snapEnabled ? '#4a8aff' : '#3a3c42';
  btnSnap.style.color = snapEnabled ? '#8ab4ff' : '#ccc';
});
document.getElementById('viewport-controls')?.appendChild(btnSnap);

// ============================================================
// 运动测试面板(复用:验证 buildCustom 的 turret/barrel/履带/摇晃)
// ============================================================
const motion = { turretYaw: 0, barrelPitch: 0, trackRoll: false, hullSway: false };
let trackOffset = 0;
let swayTime = 0;

function applyMotion(): void {
  if (!built) return;
  if (built.turret) built.turret.rotation.y = motion.turretYaw;
  if (built.barrel) built.barrel.rotation.x = motion.barrelPitch;
  if (built.hullSway) {
    built.hullSway.rotation.x = motion.hullSway ? Math.sin(swayTime * 1.5) * 0.05 : 0;
    built.hullSway.rotation.z = motion.hullSway ? Math.sin(swayTime * 1.2) * 0.03 : 0;
  }
}
function resetMotion(): void {
  motion.turretYaw = 0;
  motion.barrelPitch = 0;
  applyMotion();
}
function createMotionPanel(): void {
  const panel = document.createElement('div');
  panel.style.cssText = 'position:absolute;bottom:12px;left:12px;background:rgba(20,22,28,0.92);padding:10px 14px;border:1px solid #3a3c42;border-radius:6px;color:#c8ccd4;font-size:12px;z-index:10;min-width:230px;user-select:none;';
  panel.innerHTML = `
    <div style="font-weight:600;margin-bottom:8px;color:#e8eaed;">运动测试</div>
    <div style="margin:5px 0;">炮塔旋转 <span id="m-yaw-v" style="color:#8ab4ff;">0°</span><br><input id="m-yaw" type="range" min="-180" max="180" value="0" step="1" style="width:210px;"></div>
    <div style="margin:5px 0;">炮管俯仰 <span id="m-pitch-v" style="color:#8ab4ff;">0°</span><br><input id="m-pitch" type="range" min="-18" max="11" value="0" step="1" style="width:210px;"></div>
    <label style="display:block;margin:5px 0;cursor:pointer;"><input id="m-track" type="checkbox"> 履带滚动</label>
    <label style="display:block;margin:5px 0;cursor:pointer;"><input id="m-sway" type="checkbox"> 车身摇晃</label>
    <button id="m-reset" style="margin-top:6px;padding:3px 12px;background:#3a3c42;color:#e8eaed;border:1px solid #5a5c62;border-radius:3px;cursor:pointer;">重置</button>`;
  document.body.appendChild(panel);
  const yaw = document.getElementById('m-yaw') as HTMLInputElement;
  const yawV = document.getElementById('m-yaw-v')!;
  yaw.addEventListener('input', () => { motion.turretYaw = (parseFloat(yaw.value) * Math.PI) / 180; yawV.textContent = yaw.value + '°'; applyMotion(); });
  const pitch = document.getElementById('m-pitch') as HTMLInputElement;
  const pitchV = document.getElementById('m-pitch-v')!;
  pitch.addEventListener('input', () => { motion.barrelPitch = (parseFloat(pitch.value) * Math.PI) / 180; pitchV.textContent = pitch.value + '°'; applyMotion(); });
  const track = document.getElementById('m-track') as HTMLInputElement;
  track.addEventListener('change', () => { motion.trackRoll = track.checked; });
  const sway = document.getElementById('m-sway') as HTMLInputElement;
  sway.addEventListener('change', () => { motion.hullSway = sway.checked; if (!sway.checked) applyMotion(); });
  document.getElementById('m-reset')!.addEventListener('click', () => {
    yaw.value = '0'; pitch.value = '0'; yawV.textContent = '0°'; pitchV.textContent = '0°';
    track.checked = false; sway.checked = false;
    motion.turretYaw = 0; motion.barrelPitch = 0; motion.trackRoll = false; motion.hullSway = false;
    trackOffset = 0;
    if (built) { built.leftTrackTex.offset.x = 0; built.rightTrackTex.offset.x = 0; }
    applyMotion();
  });
}
createMotionPanel();

// ============================================================
// 渲染循环 + 自适应
// ============================================================
function animate(): void {
  requestAnimationFrame(animate);
  const dt = 1 / 60;
  if (built) {
    if (motion.trackRoll) {
      trackOffset += dt * 2;
      built.leftTrackTex.offset.x = trackOffset;
      built.rightTrackTex.offset.x = trackOffset;
    }
    if (motion.hullSway) { swayTime += dt; applyMotion(); }
  }
  controls.update();
  renderer.render(scene, camera);
}
animate();

function onResize(): void {
  camera.aspect = viewport.clientWidth / viewport.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
}
window.addEventListener('resize', onResize);

// ============================================================
// 3D 点选拾取(点击 mesh → userData.partId → 选中 part)
// ============================================================
const raycaster = new Raycaster();
const pickMouse = new Vector2();
let downX = 0, downY = 0;
renderer.domElement.addEventListener('pointerdown', (e) => { downX = e.clientX; downY = e.clientY; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return;
  if (!built || mode !== 'custom') return;
  const rect = renderer.domElement.getBoundingClientRect();
  pickMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pickMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pickMouse, camera);
  const hits = raycaster.intersectObject(built.group, true);
  for (const hit of hits) {
    let obj: Object3D | null = hit.object;
    while (obj && !obj.userData.partId) obj = obj.parent;
    const partId = obj?.userData.partId;
    if (typeof partId === 'string') {
      onPartSelect(partId);
      log.info('picked part', { partId });
      return;
    }
  }
});

document.getElementById('viewport-info')!.textContent = '拖拽旋转 · 滚轮缩放 · 左键选部件';

// ============================================================
// 初始化
// ============================================================
async function init(): Promise<void> {
  await fetchCustomList();
  renderTankManager();
  // 默认选 T14 官方展示
  await selectOfficial('t14');
  log.info('editor ready');
}
init().catch((e) => {
  log.error('init failed', e);
  showStatus(`初始化失败:${String(e)}`, 'error');
});

// 调试入口
(window as unknown as { twEditor?: unknown }).twEditor = {
  save: () => void saveCustom(),
  getModel: () => currentModel,
  reloadList: () => void fetchCustomList(),
};
