import RAPIER from '@dimforge/rapier3d-compat';
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from './PhysicsWorld';
import type { RenderScene } from './RenderScene';
import { Logger } from '../utils/Logger';

const log = Logger.create('Terrain');

/** heightmap 加载结果(null=失败/缺失 → 兜底平面) */
export interface HeightmapData {
  /** 归一化灰度 0~1,长度 width×height */
  heights: Float32Array;
  width: number;
  height: number;
}

/**
 * 异步加载 heightmap PNG → 灰度数组。
 * ------------------------------------------------------------
 * 浏览器端用 Image + canvas getImageData 解析像素(灰度用亮度法)。
 * 失败(404/解码错)返回 null → TerrainSystem 兜底全 0 高度(平面),不阻塞游戏。
 */
export async function loadHeightmap(url: string): Promise<HeightmapData | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    // createImageBitmap 解码图片(避免 Image crossOrigin tainted 导致 getImageData 失败)
    const img = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context 不可用');
    ctx.drawImage(img, 0, 0);
    const data = ctx.getImageData(0, 0, img.width, img.height).data; // RGBA
    const heights = new Float32Array(img.width * img.height);
    for (let i = 0; i < heights.length; i++) {
      heights[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) / 255;
    }
    log.info('heightmap loaded', { w: img.width, h: img.height });
    return { heights, width: img.width, height: img.height };
  } catch (e) {
    log.warn('heightmap 加载失败,回退平面', { url, err: String(e) });
    return null;
  }
}

/**
 * 地形系统:heightmap 驱动视觉 mesh + 物理 heightfield + 高度查询。
 * ============================================================
 * 用途:
 *  - 视觉:PlaneGeometry 按 heightmap 抬升顶点 + 草地贴图(color+normal)
 *  - 物理:rapier HeightfieldCollider(坦克不穿模)
 *  - 查询:getHeight(x,z) 供放置物(树/建筑/坦克出生点)贴地
 *
 * heightmap 缺失时:heights 全 0 = 完全平面(等价当前 flat 地面),不阻塞。
 *
 * 坦克物理零改动:保持锁 pitch/roll。物理引擎让坦克 cuboid 自然落在 heightfield 上,
 *  Y 跟随地形升降,姿态水平(微起伏的视觉特征)。
 *
 * 三处坐标对齐(顶点/mesh 旋转后 z 方向 / rapier 列主序)可能需运行时微调,
 *  以"坦克不穿模 + 视觉高度对得上 + getHeight 准确"为准。
 */
export class TerrainSystem {
  /** 采样到 segments 分辨率的归一化高度(0~1),行主序 heights[row*ncols+col] */
  private readonly heights: Float32Array;
  private readonly nrows: number;
  private readonly ncols: number;
  private readonly sizeX: number;
  private readonly sizeZ: number;
  private readonly amplitude: number;

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly render: RenderScene,
    /** 原始 heightmap(null=无,用平面) */
    hm: HeightmapData | null,
  ) {
    const gh = CONFIG.ground.halfSize;
    this.sizeX = gh.x * 2;
    this.sizeZ = gh.z * 2;
    this.amplitude = CONFIG.ground.terrain.amplitude;
    this.nrows = CONFIG.ground.terrain.segments;
    this.ncols = CONFIG.ground.terrain.segments;
    this.heights = this.sampleToSegments(hm);
  }

  /** 把任意分辨率 heightmap 采样到 segments×segments(最近邻;heightmap 应已平滑) */
  private sampleToSegments(hm: HeightmapData | null): Float32Array {
    const out = new Float32Array(this.nrows * this.ncols);
    if (!hm) return out; // 无 heightmap → 全 0 = 平面
    for (let r = 0; r < this.nrows; r++) {
      for (let c = 0; c < this.ncols; c++) {
        const px = Math.round((c / (this.ncols - 1)) * (hm.width - 1));
        const py = Math.round((r / (this.nrows - 1)) * (hm.height - 1));
        out[r * this.ncols + c] = hm.heights[py * hm.width + px];
      }
    }
    log.info('terrain heightmap sampled', { src: `${hm.width}×${hm.height}`, dst: `${this.nrows}×${this.ncols}` });
    return out;
  }

  /** 构建:视觉 mesh(贴图) + 物理 heightfield collider */
  build(): void {
    const mesh = this.buildMesh();
    this.buildCollider(mesh);
  }

  /** 视觉 mesh:PlaneGeometry 抬升顶点 + 草地 color/normal 贴图(异步加载,失败兜底纯色) */
  private buildMesh(): THREE.Mesh {
    const geo = new THREE.PlaneGeometry(this.sizeX, this.sizeZ, this.ncols - 1, this.nrows - 1);
    geo.rotateX(-Math.PI / 2); // XY 平面 → XZ 平面(Y 向上)
    // 按 heights 抬升顶点 Y。
    // PlaneGeometry 顶点顺序:行(原 y 方向)从 +y 到 -y,旋转后对应 +z 到 -z。
    // 与 heights 行号对齐(row 0 = +z 端),实施时若高度方向反了,翻转 row 映射即可。
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const segs = this.ncols - 1;
    for (let i = 0; i < pos.count; i++) {
      const col = i % (segs + 1);
      const row = Math.floor(i / (segs + 1));
      pos.setY(i, this.heights[row * this.ncols + col] * this.amplitude);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals(); // 重算法线(顶点抬升后)

    // 贴图(草地 color + normal,异步加载,失败保持纯色兜底)
    const gtex = CONFIG.ground.texture;
    const loader = new THREE.TextureLoader();
    const mat = new THREE.MeshStandardMaterial({ color: 0x4a5d3a });
    const base = import.meta.env.BASE_URL;
    loader.load(
      base + gtex.color,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(gtex.repeat, gtex.repeat);
        tex.anisotropy = 8;
        mat.map = tex;
        mat.color.setHex(0xffffff); // 有 map 时 color 设白(否则 tint 染色)
        mat.needsUpdate = true;
      },
      undefined,
      (e) => log.warn('地面颜色贴图加载失败,保持纯色', { err: String(e) }),
    );
    loader.load(
      base + gtex.normal,
      (tex) => {
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(gtex.repeat, gtex.repeat);
        tex.anisotropy = 8;
        mat.normalMap = tex;
        mat.normalScale.set(gtex.normalScale, gtex.normalScale);
        mat.needsUpdate = true;
      },
      undefined,
      (e) => log.warn('地面法线贴图加载失败,无凹凸', { err: String(e) }),
    );

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.render.scene.add(mesh);
    return mesh;
  }

  /**
   * 物理 heightfield collider:heights 转列主序(rapier 要求)+ scale。
   * ------------------------------------------------------------
   * heightfield 创建失败(rapier wasm trap "unreachable")时降级 cuboid 平面,
   * 保证坦克不穿地 + 游戏可运行(视觉 mesh 仍起伏,仅物理碰撞退化为平面)。
   * 创建前 log heights 摘要(排查 trap 原因用:NaN/极值/规模)。
   */
  private buildCollider(mesh: THREE.Mesh): void {
    // 用 trimesh 替代 heightfield:rapier 0.14 的 heightfield 对本数据规模 wasm trap(unreachable),
    // trimesh 从视觉 mesh 几何直接生成 → 物理表面 = 视觉表面(100% 一致,坦克不穿模/不陷地)。
    const geo = mesh.geometry as THREE.BufferGeometry;
    const positions = geo.attributes.position.array as Float32Array;
    if (!geo.index) {
      log.warn('地形 mesh 无 index,降级 cuboid');
      this.fallbackCuboid();
      return;
    }
    // rapier trimesh 要 Uint32Array indices(three index 可能 Uint16/Uint32,统一转 Uint32)
    const rawIdx = geo.index.array;
    const indices = rawIdx instanceof Uint32Array ? rawIdx : new Uint32Array(rawIdx);
    const body = this.physics.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0, 0));
    try {
      const colDesc = RAPIER.ColliderDesc.trimesh(positions, indices);
      colDesc.setFriction(0.8);
      colDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      this.physics.world.createCollider(colDesc, body);
      log.info('trimesh collider created', { vertices: positions.length / 3, triangles: indices.length / 3 });
    } catch (e) {
      log.warn('trimesh 创建失败,降级 cuboid', { err: String(e) });
      this.fallbackCuboid();
    }
  }

  /** 降级:平面 cuboid(顶部贴 y=0,与原 flat ground 一致,玩家 spawn y=0 正常站立) */
  private fallbackCuboid(): void {
    const half = CONFIG.ground.halfSize;
    const body = this.physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(0, -half.y, 0),
    );
    const colDesc = RAPIER.ColliderDesc.cuboid(half.x, half.y, half.z);
    colDesc.setFriction(0.8);
    colDesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    this.physics.world.createCollider(colDesc, body);
  }

  /**
   * 查询世界坐标 (x, z) 处的地形高度(米,相对 y=0)。双线性插值(平滑)。
   * ------------------------------------------------------------
   * 供放置物(树/建筑/补给点/坦克出生点)贴地用。地图范围外返回 0。
   * 注:z 方向与 heightmap 行号的对齐可能需运行时校验(与 mesh 顶点一致)。
   */
  getHeight(x: number, z: number): number {
    const halfX = this.sizeX / 2;
    const halfZ = this.sizeZ / 2;
    if (x < -halfX || x > halfX || z < -halfZ || z > halfZ) return 0;
    const fx = ((x + halfX) / this.sizeX) * (this.ncols - 1);
    const fz = ((z + halfZ) / this.sizeZ) * (this.nrows - 1);
    const ix = Math.floor(fx);
    const iz = Math.floor(fz);
    const tx = fx - ix;
    const tz = fz - iz;
    const clampCol = (v: number): number => Math.min(v, this.ncols - 1);
    const clampRow = (v: number): number => Math.min(v, this.nrows - 1);
    const h00 = this.heights[clampRow(iz) * this.ncols + clampCol(ix)];
    const h10 = this.heights[clampRow(iz) * this.ncols + clampCol(ix + 1)];
    const h01 = this.heights[clampRow(iz + 1) * this.ncols + clampCol(ix)];
    const h11 = this.heights[clampRow(iz + 1) * this.ncols + clampCol(ix + 1)];
    const h0 = h00 * (1 - tx) + h10 * tx;
    const h1 = h01 * (1 - tx) + h11 * tx;
    return (h0 * (1 - tz) + h1 * tz) * this.amplitude;
  }
}
