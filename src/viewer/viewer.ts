/**
 * viewer.ts — 精细化坦克模型查看器(spike 验证工具)
 * ============================================================
 * 目的:加载外部 glTF/glb 坦克模型,验证"美术资产驱动"路线的可行性与收益。
 *
 * 核心验证维度:
 *  1. 视觉精细度(对比当前程序化坦克,眼见为实)
 *  2. PBR 贴图使用率(验证"精细化 = PBR 全套贴图"论点 —— 程序化模型基本只有 base color)
 *  3. 性能(三角面数 / WebGL 加载时间 / FPS,判断 Web 可用性)
 *  4. 拓扑(线框模式看布线是否规整,判断是否可游戏化)
 *
 * 设计:
 *  - 完全独立,不碰游戏代码(/src/main.ts)与编辑器代码
 *  - 拖拽加载(最灵活,任何模型拖进来即看)
 *  - 自动居中 + 缩放到统一尺寸(便于不同模型对比)
 *  - PBR 灯光 + 阴影地面(还原真实渲染条件)
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

// ============================================================
// DOM 元素引用(集中管理,避免散落)
// ============================================================
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[viewer] DOM #${id} not found`);
  return el as T;
};

const els = {
  app: $('app'),
  stats: {
    status: $('st-status'),
    file: $('st-file'),
    loadtime: $('st-loadtime'),
    tris: $('st-tris'),
    verts: $('st-verts'),
    meshes: $('st-meshes'),
    materials: $('st-materials'),
    textures: $('st-textures'),
    size: $('st-size'),
    fps: $('st-fps'),
  },
  pbr: {
    base: $('pbr-base'), basePct: $('pbr-base-pct'),
    normal: $('pbr-normal'), normalPct: $('pbr-normal-pct'),
    rough: $('pbr-rough'), roughPct: $('pbr-rough-pct'),
    metal: $('pbr-metal'), metalPct: $('pbr-metal-pct'),
    ao: $('pbr-ao'), aoPct: $('pbr-ao-pct'),
    emiss: $('pbr-emiss'), emissPct: $('pbr-emiss-pct'),
  },
  dropzone: $('dropzone'),
  loading: $('loading'),
  error: $('error'),
  errorMsg: $('error-msg'),
  controls: {
    open: $('btn-open'),
    wireframe: $('btn-wireframe'),
    grid: $('btn-grid'),
    reset: $('btn-reset'),
    rotate: $('btn-rotate'),
  },
  anim: {
    section: $('anim-section'),
    count: $('an-count'),
    bones: $('an-bones'),
    list: $('an-list'),
    play: $<HTMLButtonElement>('an-play'),
    speed: $<HTMLInputElement>('an-speed'),
    speedVal: $('an-speed-val'),
    progress: $('an-progress'),
    loopBtns: Array.from(document.querySelectorAll<HTMLButtonElement>('.anim-loop-btn')),
  },
  fileInput: $<HTMLInputElement>('file-input'),
};

const log = (...a: unknown[]): void => console.log('[viewer]', ...a);
log('init');

// ============================================================
// 场景搭建
// ============================================================
const container = els.app;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f14);
// 雾:让远处自然融入背景,聚焦模型
scene.fog = new THREE.Fog(0x0b0f14, 40, 120);

const camera = new THREE.PerspectiveCamera(
  45,
  window.innerWidth / window.innerHeight,
  0.1,
  500,
);
camera.position.set(8, 6, 12);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; // PBR 标准色调映射
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

// 灯光:半球光打底(天/地双色) + 方向光(太阳 + 阴影) + 环境光补暗部
const hemi = new THREE.HemisphereLight(0xb0c4de, 0x3a3a2a, 0.55);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xfff4e0, 2.2);
sun.position.set(12, 18, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 60;
sun.shadow.camera.left = -15;
sun.shadow.camera.right = 15;
sun.shadow.camera.top = 15;
sun.shadow.camera.bottom = -15;
sun.shadow.bias = -0.0005;
scene.add(sun);

const amb = new THREE.AmbientLight(0xffffff, 0.18);
scene.add(amb);

// 地面:网格 + 接收阴影。网格便于判断模型尺寸比例
const groundSize = 100;
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(groundSize, groundSize),
  new THREE.MeshStandardMaterial({
    color: 0x1a1d22,
    roughness: 0.95,
    metalness: 0,
  }),
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(groundSize, 100, 0x3a3c42, 0x22242a);
grid.position.y = 0.001; // 防 z-fighting
scene.add(grid);

// 轨道控制器:左键旋转 / 右键平移 / 滚轮缩放
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 2;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.495; // 不让相机穿到地面下
controls.target.set(0, 1.5, 0);

// ============================================================
// 加载器(GLTFLoader + DRACOLoader)
// ============================================================
// Draco:Sketchfab 部分模型会用 Draco 压缩。用本地 three 自带解码器,
// 通过 Vite 的 ?url 导入 wasm 资源(避免手拷到 public)。
// 失败兜底 CDN(离线时若本地路径解析失败)。
const dracoLoader = new DRACOLoader();
try {
  // Vite 支持 ?url 后缀拿到资源最终 URL(含 hash),wasm 文件正确打进 dist
  dracoLoader.setDecoderPath(new URL('three/examples/jsm/libs/draco/', import.meta.url).href);
} catch {
  log('draco local path unavailable, fallback to CDN');
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
}
// 优先用 wasm 解码器(快),JS 兜底(兼容老浏览器)
dracoLoader.setDecoderConfig({ type: 'wasm' });

const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

// ============================================================
// 状态
// ============================================================
let currentModel: THREE.Group | null = null;
let wireframe = false;
let autoRotate = false;

// ============================================================
// 骨骼动画状态
// ============================================================
// 模型含 animations + skins 时启用。AnimationMixer 驱动骨骼动画播放。
// 无动画的模型:mixer=null,所有 anim UI 隐藏,渲染循环跳过 mixer.update。
let mixer: THREE.AnimationMixer | null = null;
let clips: THREE.AnimationClip[] = [];
let currentAction: THREE.AnimationAction | null = null;
let loopMode: 'once' | 'repeat' | 'pingpong' = 'repeat';
let animSpeed = 1.0;

// ============================================================
// 加载入口
// ============================================================
async function loadFile(file: File): Promise<void> {
  const startTime = performance.now();
  els.loading.classList.add('show');
  hideError();
  els.stats.status.textContent = '加载中…';
  els.stats.file.textContent = file.name;
  log('load start', { name: file.name, size: `${(file.size / 1024).toFixed(1)}KB` });

  // 旧模型 + 旧动画清理(切换模型时释放 mixer,避免 Action 残留引用旧骨骼)
  if (mixer) {
    mixer.stopAllAction();
    mixer = null;
  }
  currentAction = null;
  clips = [];
  if (currentModel) {
    disposeModel(currentModel);
    scene.remove(currentModel);
    currentModel = null;
  }
  hideAnimPanel();

  try {
    // glTF 外部资源(.bin + 贴图)需用 URL 解析;glb 单文件直接 arrayBuffer
    const isGlb = file.name.toLowerCase().endsWith('.glb');
    const url = URL.createObjectURL(file);

    // 用 promise 包 GLTFLoader.load(回调式 → await 式)
    // 注意:保留完整 gltf 对象(scene + animations),骨骼动画在 animations 字段
    const gltf = await new Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }>((resolve, reject) => {
      gltfLoader.load(
        url,
        (g) => resolve(g),
        (xhr) => {
          if (xhr.total) {
            const pct = ((xhr.loaded / xhr.total) * 100).toFixed(0);
            els.loading.textContent = `⏳ 加载中… ${pct}%`;
          }
        },
        (err) => reject(err),
      );
    });

    URL.revokeObjectURL(url);
    currentModel = gltf.scene;

    const loadTime = performance.now() - startTime;
    els.loading.classList.remove('show');
    els.dropzone.classList.add('hidden');

    // 居中 + 归一化缩放:不同模型尺寸差异巨大(0.1m 到 100m),
    // 统一缩放到目标高度便于查看。零静默:无几何时明确报错。
    fitAndCenterModel(currentModel);
    scene.add(currentModel);

    // 开阴影 + 应用线框状态
    currentModel.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      applyWireframeToMesh(mesh, wireframe);
    });

    // 统计 + PBR 分析
    const stats = analyzeModel(currentModel);
    updateStatsUI(stats, file.name, loadTime);
    els.stats.status.textContent = isGlb ? '已加载 (glb)' : '已加载 (gltf)';
    els.stats.status.classList.add('good');

    // 骨骼动画:模型含 animations 时创建 mixer + 填充 UI;无则隐藏面板
    setupAnimation(gltf.animations, currentModel);

    // 相机适配
    fitCameraToModel(currentModel);

    log('load done', { loadTime: `${loadTime.toFixed(0)}ms`, tris: stats.tris, anims: gltf.animations.length });
  } catch (err) {
    els.loading.classList.remove('show');
    const msg = err instanceof Error ? err.message : String(err);
    showError(`模型解析失败: ${msg}\n\n常见原因:\n• gltf 外部资源(.bin/贴图)未一起加载 — 建议 glb 单文件\n• Draco 压缩模型解码器加载失败 — 检查网络\n• 文件损坏或格式不支持`);
    els.stats.status.textContent = '加载失败';
    els.stats.status.classList.add('bad');
    console.error('[viewer] load failed', err);
    els.dropzone.classList.remove('hidden');
  }
}

// ============================================================
// 模型处理
// ============================================================

/** 居中 + 缩放到目标高度(便于对比不同尺寸模型)。原地改 group 的 transform。 */
function fitAndCenterModel(model: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  // 异常防御:无尺寸(空模型)抛错,不静默
  if (size.y < 1e-6) throw new Error('模型包围盒为空,可能无有效几何');

  // 缩放到目标高度(3m,接近真实坦克可视高度),保持比例
  const targetHeight = 3;
  const scale = targetHeight / size.y;
  model.scale.setScalar(scale);

  // 重新算缩放后的包围盒,把模型底贴到地面(y=0)、中心移到原点
  const box2 = new THREE.Box3().setFromObject(model);
  const center2 = new THREE.Vector3();
  box2.getCenter(center2);
  model.position.x -= center2.x;
  model.position.z -= center2.z;
  model.position.y -= box2.min.y; // 底贴地
}

/** 相机自适应:根据模型包围盒调整 OrbitControls target + 距离 */
function fitCameraToModel(model: THREE.Group): void {
  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  controls.target.copy(center);

  // 距离 = 模型最大边长 × 系数,保证完整入画
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 2.4;
  camera.position.set(dist * 0.7, center.y + dist * 0.4, dist);
  camera.updateProjectionMatrix();
  controls.update();
}

/** 递归释放模型资源(几何/材质/纹理)。防止反复加载导致 GPU 泄漏 */
function disposeModel(model: THREE.Group): void {
  const geos = new Set<THREE.BufferGeometry>();
  const mats = new Set<THREE.Material>();
  const texs = new Set<THREE.Texture>();
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.geometry) geos.add(mesh.geometry);
    const m = mesh.material;
    const collect = (mm: THREE.Material): void => {
      mats.add(mm);
      // 遍历材质所有 texture 属性
      for (const val of Object.values(mm as unknown as Record<string, unknown>)) {
        if (val instanceof THREE.Texture) texs.add(val);
      }
    };
    if (Array.isArray(m)) m.forEach(collect);
    else if (m) collect(m);
  });
  texs.forEach((t) => t.dispose());
  mats.forEach((m) => m.dispose());
  geos.forEach((g) => g.dispose());
  log('model disposed', { geo: geos.size, mat: mats.size, tex: texs.size });
}

// ============================================================
// 模型分析(统计 + PBR 贴图使用率)
// ============================================================
interface ModelStats {
  tris: number;
  verts: number;
  meshes: number;
  materials: number;
  textures: number;
  size: { x: number; y: number; z: number };
  pbrUsage: {
    base: number;       // map (base color)
    normal: number;     // normalMap
    rough: number;      // roughnessMap
    metal: number;      // metalnessMap
    ao: number;         // aoMap
    emiss: number;      // emissiveMap
  };
  pbrTotal: number; // 参与统计的材质总数(分母)
}

/** 遍历模型,统计几何/材质/纹理 + PBR 贴图使用率 */
function analyzeModel(model: THREE.Group): ModelStats {
  let tris = 0;
  let verts = 0;
  let meshes = 0;
  const matSet = new Set<THREE.Material>();
  const texSet = new Set<THREE.Texture>();

  // PBR 计数器(只统计 MeshStandardMaterial / MeshPhysicalMaterial,
  // 其他如 MeshBasicMaterial 不走 PBR,不计入分母,避免污染指标)
  let pbrTotal = 0;
  const pbr = { base: 0, normal: 0, rough: 0, metal: 0, ao: 0, emiss: 0 };

  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    meshes++;

    const geo = mesh.geometry as THREE.BufferGeometry;
    if (geo) {
      // 三角面数 = 索引 / 3(有索引) 或 顶点 / 3(无索引)
      if (geo.index) tris += geo.index.count / 3;
      else tris += (geo.attributes.position?.count ?? 0) / 3;
      verts += geo.attributes.position?.count ?? 0;
    }

    const collectMat = (m: THREE.Material): void => {
      matSet.add(m);
      // PBR 材质才统计贴图使用率(精细化指标只对 PBR 有意义)
      if (m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshPhysicalMaterial) {
        pbrTotal++;
        if (m.map) { pbr.base++; texSet.add(m.map); }
        if (m.normalMap) { pbr.normal++; texSet.add(m.normalMap); }
        if (m.roughnessMap) { pbr.rough++; texSet.add(m.roughnessMap); }
        if (m.metalnessMap) { pbr.metal++; texSet.add(m.metalnessMap); }
        if (m.aoMap) { pbr.ao++; texSet.add(m.aoMap); }
        if (m.emissiveMap) { pbr.emiss++; texSet.add(m.emissiveMap); }
        // 兜底收集其他纹理(metalnessMap/roughnessMap 在 glTF 里常合并为 ORM 贴图)
      }
    };
    if (Array.isArray(mesh.material)) mesh.material.forEach(collectMat);
    else if (mesh.material) collectMat(mesh.material);
  });

  const box = new THREE.Box3().setFromObject(model);
  const size = new THREE.Vector3();
  box.getSize(size);

  return {
    tris: Math.round(tris),
    verts,
    meshes,
    materials: matSet.size,
    textures: texSet.size,
    size: { x: size.x, y: size.y, z: size.z },
    pbrUsage: pbr,
    pbrTotal,
  };
}

// ============================================================
// UI 更新
// ============================================================
function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function updateStatsUI(s: ModelStats, filename: string, loadTime: number): void {
  els.stats.file.textContent = filename;
  els.stats.loadtime.textContent = `${loadTime.toFixed(0)}ms`;
  els.stats.tris.textContent = fmt(s.tris);
  els.stats.verts.textContent = fmt(s.verts);
  els.stats.meshes.textContent = s.meshes.toString();
  els.stats.materials.textContent = s.materials.toString();
  els.stats.textures.textContent = s.textures.toString();
  els.stats.size.textContent = `${s.size.x.toFixed(1)} × ${s.size.y.toFixed(1)} × ${s.size.z.toFixed(1)}`;

  // 面数评估(Web 实用性)
  const trisEl = els.stats.tris;
  trisEl.classList.remove('good', 'warn', 'bad');
  if (s.tris < 30000) trisEl.classList.add('good');        // <3万:Web 流畅
  else if (s.tris < 150000) trisEl.classList.add('warn');   // 3-15万:勉强
  else trisEl.classList.add('bad');                         // >15万:Web 吃力

  // PBR 贴图使用率(精细化核心指标)
  // 分母 pbrTotal = PBR 材质数;某贴图使用率 = 用了该贴图的材质数 / pbrTotal
  updatePbrBar(els.pbr.base, els.pbr.basePct, s.pbrUsage.base, s.pbrTotal);
  updatePbrBar(els.pbr.normal, els.pbr.normalPct, s.pbrUsage.normal, s.pbrTotal);
  updatePbrBar(els.pbr.rough, els.pbr.roughPct, s.pbrUsage.rough, s.pbrTotal);
  updatePbrBar(els.pbr.metal, els.pbr.metalPct, s.pbrUsage.metal, s.pbrTotal);
  updatePbrBar(els.pbr.ao, els.pbr.aoPct, s.pbrUsage.ao, s.pbrTotal);
  updatePbrBar(els.pbr.emiss, els.pbr.emissPct, s.pbrUsage.emiss, s.pbrTotal);
}

function updatePbrBar(fill: HTMLElement, pctEl: HTMLElement, used: number, total: number): void {
  const ratio = total > 0 ? (used / total) * 100 : 0;
  fill.style.width = `${ratio}%`;
  pctEl.textContent = total > 0 ? `${ratio.toFixed(0)}% (${used}/${total})` : '—';
}

function showError(msg: string): void {
  els.errorMsg.textContent = msg;
  els.error.classList.add('show');
  // 8 秒后自动消失
  setTimeout(() => els.error.classList.remove('show'), 8000);
}
function hideError(): void {
  els.error.classList.remove('show');
}

// ============================================================
// 线框切换
// ============================================================
function applyWireframeToMesh(mesh: THREE.Mesh, on: boolean): void {
  const set = (m: THREE.Material): void => {
    // 多材质都切;非线框支持的材质(如 PointMaterial)跳过
    if ('wireframe' in m) (m as THREE.Material & { wireframe: boolean }).wireframe = on;
  };
  if (Array.isArray(mesh.material)) mesh.material.forEach(set);
  else if (mesh.material) set(mesh.material);
}

// ============================================================
// 骨骼动画
// ============================================================
// Three.js 动画系统:AnimationMixer 管理一个根对象的所有动画;
// 每个 AnimationClip → AnimationAction(可播放/暂停/调速/设循环)。
// SkinnedMesh 的骨骼变换由 mixer 每帧推进。
// 无动画模型 setupAnimation 直接隐藏面板,mixer 保持 null,渲染循环跳过。

const LOOP_MAP: Record<'once' | 'repeat' | 'pingpong', THREE.AnimationActionLoopStyles> = {
  once: THREE.LoopOnce,
  repeat: THREE.LoopRepeat,
  pingpong: THREE.LoopPingPong,
};

/** 加载后:检测动画,创建 mixer,填充 UI。无动画 → 隐藏面板 */
function setupAnimation(animations: THREE.AnimationClip[], model: THREE.Object3D): void {
  clips = animations;
  if (animations.length === 0) {
    hideAnimPanel();
    return;
  }

  // 统计骨骼数(遍历 SkinnedMesh 取 skeleton.bones)
  let boneCount = 0;
  model.traverse((o) => {
    const skinned = o as THREE.SkinnedMesh;
    if (skinned.isSkinnedMesh && skinned.skeleton) {
      boneCount = Math.max(boneCount, skinned.skeleton.bones.length);
    }
  });

  // 创建 mixer(每模型一个;切换模型时在 loadFile 里清理)
  mixer = new THREE.AnimationMixer(model);
  els.anim.count.textContent = String(animations.length);
  els.anim.bones.textContent = boneCount > 0 ? String(boneCount) : '无';

  // 填充动画列表按钮
  els.anim.list.innerHTML = '';
  animations.forEach((clip, i) => {
    const btn = document.createElement('button');
    btn.className = 'anim-item';
    btn.textContent = clip.name || `动画 ${i}`;
    btn.addEventListener('click', () => playAnimation(i));
    els.anim.list.appendChild(btn);
  });

  els.anim.section.classList.remove('hidden');
  // 默认播第一个动画
  playAnimation(0);
  log('animations ready', { count: animations.length, bones: boneCount });
}

/** 播放指定索引的动画。切换时淡入淡出过渡(0.3s),避免硬切跳变 */
function playAnimation(index: number): void {
  if (!mixer || index < 0 || index >= clips.length) return;
  const clip = clips[index];
  const action = mixer.clipAction(clip);

  // 停旧动作(淡出)+ 播新动作(淡入)
  if (currentAction && currentAction !== action) {
    currentAction.fadeOut(0.3);
  }
  action.reset().setLoop(LOOP_MAP[loopMode], Infinity).setEffectiveTimeScale(animSpeed).fadeIn(0.3).play();
  // LoopOnce 需要clampRespectP防:播完停住(不归零姿势),否则会跳回 bind pose
  action.clampWhenFinished = loopMode === 'once';
  currentAction = action;

  // 更新列表高亮
  Array.from(els.anim.list.children).forEach((el, i) => {
    el.classList.toggle('active', i === index);
  });
  // 复位播放按钮状态(切换动画默认播放)
  els.anim.play.classList.remove('paused');
  els.anim.play.textContent = '⏸ 暂停';
}

/** 切换循环模式并应用到当前 action */
function setLoopMode(mode: typeof loopMode): void {
  loopMode = mode;
  els.anim.loopBtns.forEach((b) => b.classList.toggle('active', b.dataset.loop === mode));
  if (currentAction) {
    currentAction.setLoop(LOOP_MAP[mode], Infinity);
    currentAction.clampWhenFinished = mode === 'once';
    // LoopOnce 下若已播完,reset 重播
    if (mode === 'once' && !currentAction.isRunning()) {
      currentAction.reset().play();
    }
  }
}

/** 播放/暂停切换 */
function togglePlay(): void {
  if (!currentAction) return;
  // AnimationAction 有 paused 属性 + isRunning();无 isPaused()。
  // paused=true 但 isRunning()=true(运行中但暂停);播完 isRunning()=false。
  if (currentAction.paused && currentAction.isRunning()) {
    // 暂停态 → 恢复
    currentAction.paused = false;
    els.anim.play.classList.remove('paused');
    els.anim.play.textContent = '⏸ 暂停';
  } else if (currentAction.isRunning()) {
    // 运行中 → 暂停
    currentAction.paused = true;
    els.anim.play.classList.add('paused');
    els.anim.play.textContent = '▶ 播放';
  } else {
    // 停止态(播完)→ 重新播
    currentAction.reset().play();
    els.anim.play.classList.remove('paused');
    els.anim.play.textContent = '⏸ 暂停';
  }
}

/** 调速(0.1~2x),应用到当前 action 的 timeScale */
function setSpeed(s: number): void {
  animSpeed = s;
  els.anim.speedVal.textContent = `${s.toFixed(1)}x`;
  if (currentAction) currentAction.setEffectiveTimeScale(s);
}

/** 每帧推进 mixer + 更新进度条(由渲染循环调用) */
function updateAnimation(dt: number): void {
  if (!mixer) return;
  mixer.update(dt);
  // 进度条:当前 action 的 time 归一化到 clip.duration
  if (currentAction) {
    const dur = currentAction.getClip().duration;
    const t = currentAction.time;
    const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
    els.anim.progress.style.width = `${pct}%`;
  }
}

function hideAnimPanel(): void {
  els.anim.section.classList.add('hidden');
}

// ============================================================
// 拖拽 + 文件选择 + 按钮
// ============================================================
function setupInteractions(): void {
  // 拖拽:dragover 高亮 + drop 加载
  ['dragenter', 'dragover'].forEach((ev) =>
    container.addEventListener(ev, (e) => {
      e.preventDefault();
      els.app.classList.add('dragover');
    }),
  );
  ['dragleave', 'drop'].forEach((ev) =>
    container.addEventListener(ev, (e) => {
      e.preventDefault();
      els.app.classList.remove('dragover');
    }),
  );
  container.addEventListener('drop', (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    if (!/\.(glb|gltf)$/i.test(file.name)) {
      showError('只支持 .glb 或 .gltf 文件');
      return;
    }
    void loadFile(file);
  });

  // 打开文件按钮
  els.controls.open.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const file = els.fileInput.files?.[0];
    if (file) void loadFile(file);
    els.fileInput.value = ''; // 允许重复选同一文件
  });

  // 线框
  els.controls.wireframe.addEventListener('click', () => {
    wireframe = !wireframe;
    els.controls.wireframe.classList.toggle('active', wireframe);
    if (currentModel) {
      currentModel.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) applyWireframeToMesh(mesh, wireframe);
      });
    }
  });

  // 网格地面显隐
  els.controls.grid.addEventListener('click', () => {
    const visible = !grid.visible;
    grid.visible = visible;
    ground.visible = visible;
    els.controls.grid.classList.toggle('active', visible);
  });

  // 复位视角
  els.controls.reset.addEventListener('click', () => {
    if (currentModel) fitCameraToModel(currentModel);
    else {
      camera.position.set(8, 6, 12);
      controls.target.set(0, 1.5, 0);
      controls.update();
    }
  });

  // 自动旋转
  els.controls.rotate.addEventListener('click', () => {
    autoRotate = !autoRotate;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = 1.5;
    els.controls.rotate.classList.toggle('active', autoRotate);
  });

  // 动画播放/暂停
  els.anim.play.addEventListener('click', togglePlay);
  // 动画速度滑块
  els.anim.speed.addEventListener('input', () => {
    setSpeed(parseFloat(els.anim.speed.value));
  });
  // 循环模式切换
  els.anim.loopBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.loop as typeof loopMode;
      if (mode) setLoopMode(mode);
    });
  });
}
setupInteractions();

// ============================================================
// URL 参数支持:?m=path/to/model.glb 自动加载(便于测试本地文件)
// ============================================================
const urlModel = new URLSearchParams(location.search).get('m');
if (urlModel) {
  // 异步加载,不阻塞主循环
  (async (): Promise<void> => {
    try {
      const resp = await fetch(urlModel);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      const name = urlModel.split('/').pop() ?? 'model.glb';
      const file = new File([blob], name);
      await loadFile(file);
    } catch (err) {
      showError(`URL 加载失败: ${String(err)}`);
    }
  })();
}

// ============================================================
// 渲染循环 + FPS
// ============================================================
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

let fpsLast = performance.now();
let fpsFrames = 0;
let fpsAccum = 0;

function loop(): void {
  requestAnimationFrame(loop);
  controls.update();

  // FPS 计数(每 0.5s 更新一次 UI,避免抖动)
  const now = performance.now();
  const dt = now - fpsLast;
  fpsLast = now;
  fpsFrames++;
  fpsAccum += dt;

  // 骨骼动画推进(mixer 内部按秒计时,需转 dt 为秒)
  if (mixer) updateAnimation(dt / 1000);

  if (fpsAccum >= 500) {
    const fps = Math.round((fpsFrames * 1000) / fpsAccum);
    els.stats.fps.textContent = fps.toString();
    els.stats.fps.classList.remove('good', 'warn', 'bad');
    if (fps >= 50) els.stats.fps.classList.add('good');
    else if (fps >= 30) els.stats.fps.classList.add('warn');
    else els.stats.fps.classList.add('bad');
    fpsFrames = 0;
    fpsAccum = 0;
  }

  renderer.render(scene, camera);
}
loop();

log('ready — 拖入 glb/gltf 文件即可查看');
