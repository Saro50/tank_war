import * as THREE from 'three';
import { Logger } from '../utils/Logger';

const log = Logger.create('RenderScene');

/**
 * 渲染场景封装
 * ------------------------------------------------------------
 * 职责：持有 Three.js 的 Scene / Camera / Renderer / 灯光，
 *       负责绘制与窗口自适应；不包含任何游戏逻辑与物理状态。
 *
 * 与其他层的关系：
 *   - 实体自行 add(mesh) 到 scene；
 *   - 位姿由 SyncBridge 每帧写入网格，渲染层不主动移动物体；
 *   - 相机控制（跟随/震动）后续由 CameraRig 接管，此处只做基础相机。
 */
export class RenderScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  /** 平行光(阴影源),dispose 时需释放 shadow map */
  private sun?: THREE.DirectionalLight;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x87a7b8); // 暂用纯天空色，后续 M4 换天空盒
    this.scene.fog = new THREE.Fog(0x87a7b8, 60, 220);

    this.camera = new THREE.PerspectiveCamera(
      60,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    // M1 临时视角：斜上方俯视，便于观察方块下落
    this.camera.position.set(14, 11, 18);
    this.camera.lookAt(0, 1, 0);

    this.setupLights();
    window.addEventListener('resize', this.onResize);

    log.info('render scene ready', {
      resolution: [window.innerWidth, window.innerHeight],
    });
  }

  /** 灯光：半球光打底 + 平行光投射阴影，室外战场质感 */
  private setupLights(): void {
    const hemi = new THREE.HemisphereLight(0xffffff, 0x444433, 0.7);
    this.scene.add(hemi);

    const sun = new THREE.DirectionalLight(0xffffff, 1.0);
    sun.position.set(30, 50, 20);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const d = 60;
    sun.shadow.camera.left = -d;
    sun.shadow.camera.right = d;
    sun.shadow.camera.top = d;
    sun.shadow.camera.bottom = -d;
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 200;
    this.scene.add(sun);
    this.sun = sun;
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  };

  /** 绘制一帧 */
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** 销毁渲染资源(场景重置/卸载用)：移除 resize 监听、释放场景对象并移除 canvas */
  dispose(): void {
    window.removeEventListener('resize', this.onResize);

    // 释放平行光 shadow map(2048×2048 深度贴图占显存)
    if (this.sun?.shadow.map) {
      this.sun.shadow.map.dispose();
    }

    // 释放场景图中所有 Mesh 的几何体、材质和纹理
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    const texs = new Set<THREE.Texture>();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) geos.add(mesh.geometry);
      const m = mesh.material;
      const collect = (mm: THREE.Material): void => {
        mats.add(mm);
        const map = (mm as { map?: THREE.Texture }).map;
        if (map) texs.add(map);
      };
      if (Array.isArray(m)) for (const mm of m) collect(mm);
      else if (m) collect(m);
    });
    for (const t of texs) t.dispose();
    for (const m of mats) m.dispose();
    for (const g of geos) g.dispose();

    // 移除 renderer 创建的 canvas
    const canvas = this.renderer.domElement;
    if (canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
    this.renderer.dispose();
  }
}
