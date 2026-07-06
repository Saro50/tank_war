/**
 * editor.ts — 坦克模型编辑器主入口
 * ============================================================
 * 数据驱动编辑器:调参 → schema 实时校验 → Builder 重建预览 → 保存到后台。
 *
 * 数据流(改造后,与游戏共用同一套抽象):
 *   fetch /api/tanks/:variant → schema 校验 → currentData
 *   选参数树 → renderPropPanel(改值)
 *   prop change → setNested → schema 校验 + rebuild(TankVisualBuilder)
 *   保存按钮 → PUT /api/tanks/:variant → editor-dist/tanks/*.json(开发者手动采纳到 public)
 *
 * 复用游戏的抽象(保证所见即所得):
 *   - TankVisualBuilder:与游戏 T14Tank/StaticTankBase 共用的唯一几何构建源
 *   - TankSchema:与游戏 TankDataStore 共用的数据契约
 *   不再自带任何几何构建/校验逻辑(原 TankPreview 已删除)
 */
import { AmbientLight, AxesHelper, DirectionalLight, GridHelper, Mesh, Object3D, PerspectiveCamera, Raycaster, Scene, Vector2, WebGLRenderer } from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TankVisualBuilder, type BuiltVisuals } from '../entities/TankVisualBuilder';
import { TANK_VARIANTS, TANK_VARIANT_LABELS, TankSchemaByVariant, type TankVariant, type TankData, type T14Data, type TigerData, type AbramsData } from '../data/TankSchema';
import { buildTree, renderTree } from './ParamTree';
import { renderPropPanel } from './PropPanel';
import { downloadJson } from './ExportImport';
import { AssemblyEngine } from './AssemblyEngine';
import { getAssemblyRules } from './assemblyRules';
import { getExtensionRules } from './extensionAxes';
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
renderer.shadowMap.type = 1; // PCFSoftShadowMap
renderer.setClearColor(0x0e1014);
viewport.prepend(renderer.domElement);

const scene = new Scene();
const ambient = new AmbientLight(0x404060, 0.6);
scene.add(ambient);
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
const axes = new AxesHelper(3);
scene.add(axes);

const camera = new PerspectiveCamera(40, viewport.clientWidth / viewport.clientHeight, 0.1, 100);
camera.position.set(6, 5, 10);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.update();
controls.enableDamping = true;
controls.dampingFactor = 0.12;

// ============================================================
// 数据状态
// ============================================================

const treeBody = document.getElementById('tree-body')!;
const propBody = document.getElementById('prop-body')!;
const propHeader = document.getElementById('prop-header')!;
const variantSelect = document.getElementById('variant-select') as HTMLSelectElement;
const btnSave = document.getElementById('btn-export') as HTMLButtonElement; // 复用导出按钮作"保存"
const btnImport = document.getElementById('btn-import') as HTMLButtonElement;

let currentVariant: TankVariant = 't14';
let currentData!: TankData; // init 后赋值
let engine!: AssemblyEngine; // 装配约束引擎(惰性维持部件邻接)
let activePath: string[] | undefined;
let built: BuiltVisuals | undefined;
let dirty = false;

// 填充车型下拉(variant select 的 option 由 schema 驱动,而非硬编码 HTML)
variantSelect.innerHTML = TANK_VARIANTS.map((v) => `<option value="${v}">${TANK_VARIANT_LABELS[v]}</option>`).join('');
btnSave.textContent = '💾 保存';

// ============================================================
// API:加载 / 保存
// ============================================================

/** 从后台加载某车型数据(后台 schema 校验过,这里二次校验防传输损坏) */
async function fetchVariant(v: TankVariant): Promise<TankData> {
  const resp = await fetch(`/api/tanks/${v}`);
  if (!resp.ok) throw new Error(`加载 ${v} 失败: HTTP ${resp.status}`);
  const json = await resp.json();
  const parsed = TankSchemaByVariant[v].safeParse(json);
  if (!parsed.success) {
    throw new Error(`${v} 数据不合法: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`);
  }
  return parsed.data as TankData;
}

/** 保存当前数据到后台(PUT /api/tanks/:variant → editor-dist) */
async function saveVariant(): Promise<void> {
  // 前端先校验(后台也会校验,双重保险)
  const errors = validate();
  if (errors.length > 0) {
    showStatus(`保存失败:${errors.length} 处数据不合法,请先修正(见上方红字)`, 'error');
    return;
  }
  btnSave.disabled = true;
  btnSave.textContent = '保存中...';
  try {
    const resp = await fetch(`/api/tanks/${currentVariant}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentData),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      throw new Error(err.error ?? `HTTP ${resp.status}`);
    }
    dirty = false;
    updateDirtyUI();
    showStatus(`已保存到 editor-dist/tanks/${currentVariant}.json(需手动拷到 public/tanks/ 才生效到游戏)`, 'ok');
    log.info('saved', { variant: currentVariant });
  } catch (e) {
    showStatus(`保存失败:${String(e)}`, 'error');
    log.error('save failed', e);
  } finally {
    btnSave.disabled = false;
    btnSave.textContent = dirty ? '💾 保存 *' : '💾 保存';
  }
}

// ============================================================
// schema 实时校验
// ============================================================

/** 校验 currentData,返回错误信息数组(空=合法) */
function validate(): string[] {
  const parsed = TankSchemaByVariant[currentVariant].safeParse(currentData);
  if (parsed.success) return [];
  return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

/** 在属性面板顶部显示 schema 错误(实时反馈,不阻断编辑) */
function refreshSchemaStatus(): void {
  const errors = validate();
  const existing = propBody.querySelector('#schema-errors');
  if (errors.length === 0) {
    if (existing) existing.remove();
    return;
  }
  let el = existing as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = 'schema-errors';
    el.style.cssText = 'background:#3a1a1a;border:1px solid #6a2a2a;color:#ff8888;padding:8px 10px;margin-bottom:10px;font-size:11px;border-radius:4px;';
    propBody.prepend(el);
  }
  el.innerHTML = `<div style="font-weight:bold;margin-bottom:4px;">⚠ ${errors.length} 处数据不合法:</div>${errors.map((e) => `<div>· ${e}</div>`).join('')}`;
}

// ============================================================
// 预览(用 TankVisualBuilder,与游戏共用)
// ============================================================

/** 用 currentData 重建预览模型。try/catch 兜底:数据非法时不崩(保留旧模型) */
function rebuild(): void {
  const ctx = { camoSeed: 1 };
  let next: BuiltVisuals;
  try {
    if (currentVariant === 't14') next = TankVisualBuilder.buildT14(currentData as T14Data, ctx);
    else if (currentVariant === 'tiger') next = TankVisualBuilder.buildTiger(currentData as TigerData, ctx);
    else next = TankVisualBuilder.buildAbrams(currentData as AbramsData, ctx);
  } catch (e) {
    // 数据非法导致构建崩:不替换旧模型,仅报错(用户在 schema 错误里能看到原因)
    log.error('rebuild failed, kept old model', e);
    return;
  }
  if (built) {
    scene.remove(built.group);
    TankVisualBuilder.dispose(built.resources);
  }
  built = next;
  // 标记主要部件(供点选 Raycaster 反查:命中 mesh → 向上找 userData.partName)
  built.turret.userData.partName = 'turret';
  built.barrel.userData.partName = 'barrel';
  scene.add(built.group);
  // 同步线框状态到新模型
  applyWireframe(built.group, wireframeMode);
}

// ============================================================
// UI 接线
// ============================================================

let treeNodes: ReturnType<typeof buildTree> = []; // init 后由 rebuildTree 填充(currentData 异步加载,模块级不可访问)

function rebuildTree(): void {
  treeNodes = buildTree(currentData as Record<string, unknown>);
  renderTree(treeBody, treeNodes, onTreeSelect, activePath);
}

function onTreeSelect(path: string[]): void {
  activePath = path;
  renderTree(treeBody, treeNodes, onTreeSelect, activePath);
  renderPropPanel(propBody, path, () => currentData as Record<string, unknown>, setData, onPropChange, statusOf, toggleLock);
  refreshSchemaStatus();
}

function setData(newData: Record<string, unknown>): void {
  currentData = newData as TankData;
  treeNodes = buildTree(currentData as Record<string, unknown>);
}

/** 查询字段约束状态(供 PropPanel 显示 🔗/🔒 图标) */
function statusOf(path: string): 'free' | 'bound' | 'locked' {
  if (!engine.hasConstraint(path)) return 'free';
  return engine.isLocked(path) ? 'locked' : 'bound';
}

/** 切换字段锁定:bound→锁定(固定当前位置)/ locked→解锁(恢复约束跟随) */
function toggleLock(path: string): void {
  if (engine.isLocked(path)) {
    engine.unlock(path);
  } else {
    engine.lockOnUserEdit(path);
  }
  currentData = engine.resolve(currentData);
  rebuild();
  rebuildTree();
  renderPropPanel(propBody, activePath!, () => currentData as Record<string, unknown>, setData, onPropChange, statusOf, toggleLock);
}

/** 参数变化 → 标记 dirty + 重建预览 + schema 校验 */
function onPropChange(changedPath: string[]): void {
  const pathStr = changedPath.join('.');
  // 用户改了某字段 → 若它是约束的 child,锁定(尊重手动定位,引擎不再自动调它)
  engine.lockOnUserEdit(pathStr);
  // 延展字段:clamp 到 minLength(防穿透/视觉异常)
  engine.clampExtension(currentData as Record<string, unknown>, pathStr);
  // 惰性求解:检查所有约束,调整脱离的子字段(连带联动)
  currentData = engine.resolve(currentData);
  rebuild();
  rebuildTree();
  renderPropPanel(propBody, activePath!, () => currentData as Record<string, unknown>, setData, onPropChange, statusOf, toggleLock);
  refreshSchemaStatus();
  if (!dirty) {
    dirty = true;
    updateDirtyUI();
  }
}

function updateDirtyUI(): void {
  btnSave.textContent = dirty ? '💾 保存 *' : '💾 保存';
  propHeader.textContent = dirty ? `${TANK_VARIANT_LABELS[currentVariant]} *(未保存)` : TANK_VARIANT_LABELS[currentVariant];
}

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
// 车型切换 / 保存 / 导入
// ============================================================

variantSelect.addEventListener('change', async () => {
  if (dirty) log.warn('切换车型时丢弃了未保存的更改', { from: currentVariant });
  const v = variantSelect.value as TankVariant;
  currentVariant = v;
  try {
    currentData = await fetchVariant(v);
    engine = new AssemblyEngine(getAssemblyRules(v), currentData as Record<string, unknown>, getExtensionRules(v));
    dirty = false;
    activePath = undefined;
    rebuild();
    rebuildTree();
    updateDirtyUI();
    if (treeNodes.length > 0) onTreeSelect(treeNodes[0].path);
  } catch (e) {
    showStatus(`加载失败:${String(e)}`, 'error');
  }
});

btnSave.addEventListener('click', () => void saveVariant());

btnImport.addEventListener('click', () => {
  document.getElementById('file-input')?.click();
});

document.getElementById('file-input')?.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result as string);
      const parsed = TankSchemaByVariant[currentVariant].safeParse(data);
      if (!parsed.success) {
        showStatus(`导入文件不符合 ${currentVariant} schema:${parsed.error.issues.length} 处错误`, 'error');
        return;
      }
      Object.assign(currentData as Record<string, unknown>, parsed.data as Record<string, unknown>);
      rebuild();
      rebuildTree();
      if (activePath) renderPropPanel(propBody, activePath, () => currentData as Record<string, unknown>, setData, onPropChange, statusOf, toggleLock);
      refreshSchemaStatus();
      if (!dirty) { dirty = true; updateDirtyUI(); }
      showStatus(`已导入(未保存,需点保存写入后台)`, 'ok');
    } catch {
      showStatus('JSON 解析失败,请检查文件格式', 'error');
    }
  };
  reader.readAsText(file);
});

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

// 线框切换(修复原 window.THREE 死代码:three 的 Mesh 有 isMesh 属性,直接判断)
let wireframeMode = false;
function applyWireframe(root: { traverse: (cb: (o: unknown) => void) => void }, on: boolean): void {
  root.traverse((child) => {
    if (child instanceof Mesh) {
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      for (const m of mats) if (m) m.wireframe = on;
    }
  });
}
document.getElementById('btn-wireframe')?.addEventListener('click', () => {
  wireframeMode = !wireframeMode;
  if (built) applyWireframe(built.group, wireframeMode);
  (document.getElementById('btn-wireframe') as HTMLElement).style.borderColor = wireframeMode ? '#4a8aff' : '#3a3c42';
});

// ============================================================
// 渲染循环 + 自适应
// ============================================================

function animate(): void {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}
animate();

function onResize(): void {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
}
window.addEventListener('resize', onResize);

// ============================================================
// 3D 点选拾取(Phase 4-3)
// 点击坦克部件 → Raycaster 命中 → 反查 userData.partName → 参数树定位
// ============================================================

const raycaster = new Raycaster();
const pickMouse = new Vector2();
let downX = 0;
let downY = 0;

// 区分点击 vs 拖拽(OrbitControls 拖拽旋转):位移 < 5px 视为点击
renderer.domElement.addEventListener('pointerdown', (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (Math.hypot(e.clientX - downX, e.clientY - downY) > 5) return; // 拖拽,忽略
  if (!built) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pickMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
  pickMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pickMouse, camera);
  const hits = raycaster.intersectObject(built.group, true);
  // 命中后向上找 userData.partName(标记在部件 group:turret/barrel)
  for (const hit of hits) {
    let obj: Object3D | null = hit.object;
    while (obj && !obj.userData.partName) obj = obj.parent;
    const part = obj?.userData.partName;
    if (typeof part === 'string') {
      selectPartByClick(part);
      return;
    }
  }
});

/** 点击部件 → 参数树定位到该部件分组(顶层 path[0] = 部件名) */
function selectPartByClick(partName: string): void {
  const node = treeNodes.find((n) => n.path[0] === partName);
  if (node) {
    onTreeSelect(node.path);
    log.info('picked part', { partName });
  } else {
    log.warn('picked part not in tree', { partName });
  }
}

document.getElementById('viewport-info')!.textContent = '拖拽旋转 · 滚轮缩放';

// ============================================================
// 初始化:加载初始车型数据 → 渲染
// ============================================================

async function init(): Promise<void> {
  currentData = await fetchVariant(currentVariant);
  engine = new AssemblyEngine(getAssemblyRules(currentVariant), currentData as Record<string, unknown>, getExtensionRules(currentVariant));
  rebuild();
  rebuildTree();
  updateDirtyUI();
  if (treeNodes.length > 0) onTreeSelect(treeNodes[0].path);
  log.info('editor ready', { variant: currentVariant });
}

init().catch((e) => {
  log.error('init failed', e);
  showStatus(`初始化失败:${String(e)}`, 'error');
});

// 暴露调试入口(浏览器控制台可手动触发保存/导出)
(window as unknown as { twEditor?: unknown }).twEditor = {
  save: () => void saveVariant(),
  exportJson: () => downloadJson(JSON.stringify(currentData, null, 2), `tank_${currentVariant}_visual.json`),
  getData: () => currentData,
};
