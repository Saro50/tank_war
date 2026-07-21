/**
 * GltfTankAsset.ts — 精细化 glb 坦克资产的加载与语义解析
 * ============================================================
 * 把外部美术资产(Blender 制作 → glb)接入现有坦克架构。
 * 与 TankVisualBuilder(程序化几何)平级,产出相同的 BuiltVisuals 结构,
 * 让 TankBase 不感知视觉来源差异(物理/动画/战斗系统全复用)。
 *
 * 命名约定(Blender 拆分时必须遵守,node 树层级):
 * ------------------------------------------------------------
 *   Hull (根,车体+履带等不旋转部分)
 *   ├── Turret (炮塔主体,绕 Y 轴旋转)
 *   │   └── Barrel (炮管,绕 X 轴俯仰)
 *   │       └── Muzzle (Empty 空对象,炮口点,标记开火位置)
 *   └── 其他装饰件(随 Hull 移动,不旋转)
 *
 * 命名大小写敏感(Turret ≠ turret)。缺失任一语义节点 → 抛错(永不静默),
 * 错误信息明确指出缺哪个命名,便于 Blender 端定位修复。
 *
 * 资源策略:
 *  - glb 启动时一次性加载缓存(多辆坦克共享一份 GPU 几何/纹理)
 *  - build() 时深拷贝场景图;geometry/texture 引用共享,material 独立 clone
 *    (material 独立 → 各实例可独立 scorch 焦黑/dispose,不互相污染)
 *  - 履带纹理:glb 是烘焙死的(不能滚动),给占位 CanvasTexture 兜底,
 *    GltfTank.updateTracks override 为空操作
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import type { BuiltVisuals, BuiltResources } from './TankVisualBuilder';
import { Logger } from '../utils/Logger';

const log = Logger.create('GltfTankAsset');

/** 语义节点命名约定(Blender 端必须匹配,大小写敏感) */
const NODE = {
  turret: 'Turret',
  barrel: 'Barrel',
  muzzle: 'Muzzle',
} as const;

// ============================================================
// 加载器(模块单例,全游戏共享一套 GLTFLoader + DRACODecoder)
// ============================================================
const gltfLoader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
try {
  // Vite ?url 拿到 wasm 资源最终路径(含 hash),正确打进 dist
  dracoLoader.setDecoderPath(new URL('three/examples/jsm/libs/draco/', import.meta.url).href);
} catch {
  log.warn('draco local path unavailable, fallback to CDN');
  dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
}
gltfLoader.setDRACOLoader(dracoLoader);

// ============================================================
// 资产缓存(启动 load 一次,build 多次 clone)
// ============================================================
let cachedScene: THREE.Group | null = null;
let cachedUrl = '';

// ============================================================
// 对外 API
// ============================================================
export const GltfTankAsset = {
  /**
   * 启动时预加载 glb 到缓存。幂等(同 URL 重复调用直接 resolve)。
   * main.ts 启动序列里 await 此方法(类似 TankDataStore.load)。
   * 永不静默失败:加载错误抛出,由 main.catch 兜底。
   */
  async load(url: string): Promise<void> {
    if (cachedScene && cachedUrl === url) {
      log.warn('load called twice, ignored', { url });
      return;
    }
    // 切换 URL 时释放旧缓存资源(防泄漏:已有 GltfTank 实例 clone 自旧 scene,
    // 其共享 geometry/texture 引用变为孤儿——但实例自身 dispose 不释放共享资源,此处统一释放)
    if (cachedScene) {
      cachedScene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.geometry?.dispose();
        const m = mesh.material;
        if (Array.isArray(m)) m.forEach((mm) => {
          const tex = (mm as { map?: THREE.Texture }).map;
          tex?.dispose();
          mm.dispose();
        });
        else if (m) {
          const tex = (m as { map?: THREE.Texture }).map;
          tex?.dispose();
          m.dispose();
        }
      });
      log.info('old glb cache disposed', { url: cachedUrl });
    }
    log.info('loading glb asset', { url });
    const t0 = performance.now();
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      gltfLoader.load(url, resolve, undefined, reject);
    });
    cachedScene = gltf.scene;
    cachedUrl = url;

    // 预处理:开阴影 + 包围盒统计(便于日志诊断)
    let meshCount = 0;
    cachedScene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        meshCount++;
      }
    });
    const box = new THREE.Box3().setFromObject(cachedScene);
    const size = new THREE.Vector3();
    box.getSize(size);
    log.info('glb asset loaded', {
      url,
      meshes: meshCount,
      loadTime: `${(performance.now() - t0).toFixed(0)}ms`,
      size: `${size.x.toFixed(1)}×${size.y.toFixed(1)}×${size.z.toFixed(1)}`,
    });
  },

  /**
   * 从缓存 clone 一份视觉,按命名约定解析语义节点。
   * @param targetSizeZ 目标 Z 轴长度(米,对齐物理碰撞体长),glb 按比例缩放
   * @throws 缺失语义节点时抛错(明确指出缺哪个)
   */
  build(targetSizeZ: number): BuiltVisuals {
    if (!cachedScene) throw new Error('GltfTankAsset.load() 未完成,无法 build');

    // 深拷贝场景图(geometry/texture 共享引用,material 独立 clone)
    const group = cloneWithIndependentMaterials(cachedScene);

    // 归一化尺寸:按 Z 长轴缩放到 targetSizeZ,居中 + 底贴 y=0
    normalizeSize(group, targetSizeZ);

    // 按命名约定查找语义节点(层级严格:Turret 根下 → Barrel Turret 下 → Muzzle Barrel 下)
    const turret = findByName(group, NODE.turret);
    if (!turret) {
      throw new Error(
        `[GltfTankAsset] glb 缺少炮塔节点:必须有一个名为 "${NODE.turret}" 的对象(建议为 mesh,父级为根)。请在 Blender 拆分后将炮塔对象重命名为 "${NODE.turret}"。`,
      );
    }
    const barrel = findByName(turret, NODE.barrel);
    if (!barrel) {
      throw new Error(
        `[GltfTankAsset] glb 缺少炮管节点:炮塔 "${NODE.turret}" 下必须有一个名为 "${NODE.barrel}" 的子对象。请在 Blender 将炮管分离并设为炮塔的子级,重命名为 "${NODE.barrel}"。`,
      );
    }
    const muzzle = findByName(barrel, NODE.muzzle);
    if (!muzzle) {
      throw new Error(
        `[GltfTankAsset] glb 缺少炮口节点:炮管 "${NODE.barrel}" 下必须有一个名为 "${NODE.muzzle}" 的 Empty(空对象)。请在 Blender 炮口位置加 Empty,设为炮管子级,重命名为 "${NODE.muzzle}"。`,
      );
    }

    // 类型收窄:这三个必须是 Object3D(可能是 Mesh 或 Group/Empty,都行)
    const turretGroup = turret as THREE.Group;
    const barrelGroup = barrel as THREE.Group;

    // barrelBaseZ:炮管相对炮塔的局部 Z(后坐力动画定位用)
    // 取 barrel 当前 position.z(归一化前;后坐力在 GltfTank 里用 barrel.position.z 偏移)
    const barrelBaseZ = barrelGroup.position.z;

    // 资源跟踪:只收集 material(独立 clone 可释放);geometry/texture 共享不收(由 Asset 持有)
    const resources: BuiltResources = collectMaterials(group);

    // 履带占位纹理(glb 烘焙死,updateTracks 会空转,占位防止 TankBase 类型缺失)
    const placeholder = new THREE.CanvasTexture(document.createElement('canvas'));

    log.debug('glb tank built', { barrelBaseZ: barrelBaseZ.toFixed(2) });

    return {
      group,
      hullSway: undefined, // glb 无车身摇晃(程序化 T14 专属视觉特效)
      turret: turretGroup,
      barrel: barrelGroup,
      muzzle,
      leftTrackTex: placeholder,
      rightTrackTex: placeholder,
      barrelBaseZ,
      resources,
    };
  },
};

// ============================================================
// 辅助函数
// ============================================================

/** 深拷贝场景图,但每个 mesh 的 material 独立 clone(可独立 scorch/dispose) */
function cloneWithIndependentMaterials(src: THREE.Group): THREE.Group {
  const clone = src.clone(true); // Object3D.clone(true):深拷贝层级,geometry 引用共享
  clone.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((m) => m.clone());
    } else if (mesh.material) {
      mesh.material = mesh.material.clone();
    }
  });
  return clone;
}

/** 按 Z 长轴归一化缩放 + 居中 + 底贴 y=0。约定模型长轴=Z,宽=X,高=Y */
function normalizeSize(group: THREE.Group, targetZ: number): void {
  const box = new THREE.Box3().setFromObject(group);
  const size = new THREE.Vector3();
  box.getSize(size);
  if (size.z < 1e-6) throw new Error('glb 包围盒为空,可能无有效几何');

  const scale = targetZ / size.z;
  group.scale.setScalar(scale);

  // 缩放后重新算包围盒,居中(X/Z) + 底贴地(Y)
  const box2 = new THREE.Box3().setFromObject(group);
  const center = new THREE.Vector3();
  box2.getCenter(center);
  group.position.x -= center.x;
  group.position.z -= center.z;
  group.position.y -= box2.min.y;
}

/** 递归查找第一个 name 匹配的节点 */
function findByName(root: THREE.Object3D, name: string): THREE.Object3D | null {
  if (root.name === name) return root;
  for (const child of root.children) {
    const found = findByName(child, name);
    if (found) return found;
  }
  return null;
}

/** 收集所有 material(供 dispose;geometry/texture 共享,不收) */
function collectMaterials(root: THREE.Object3D): BuiltResources {
  const materials: THREE.Material[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (Array.isArray(mesh.material)) materials.push(...mesh.material);
    else if (mesh.material) materials.push(mesh.material);
  });
  return { geometries: [], materials, textures: [] };
}
