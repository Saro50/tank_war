import * as THREE from 'three';
import { CONFIG } from '../config';
import type { RenderScene } from '../core/RenderScene';
import type { TerrainSystem } from '../core/TerrainSystem';
import type { IControllableTank } from '../entities/IControllableTank';
import { Logger } from '../utils/Logger';

const log = Logger.create('FogOfWar');

// ============================================================
// 雾 shader
// ============================================================

/** 顶点:传世界 xz(雾 mesh 顶点经 rotateX 后 position.x/z 即世界 xz) */
const VERT = /* glsl */ `
  varying vec2 vWorldXZ;
  void main() {
    vWorldXZ = vec2(position.x, position.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

/**
 * 片元:按探索网格三态着色 + noise 雾状云团感。
 * ------------------------------------------------------------
 * 世界 xz → 网格 uv → 采样 uGridTex 得态(0/1/2):
 *   unknown(0)  → 浓雾 alpha≈0.9
 *   explored(1) → 半透灰 alpha≈0.5(记得地形)
 *   visible(2)  → 透明 alpha=0(露地面)
 * 叠加基于世界坐标的 noise,让雾有云团质感(不死板平涂)。
 */
const FRAG = /* glsl */ `
  precision mediump float;
  uniform sampler2D uGridTex;
  uniform vec3 uFogColor;
  uniform vec2 uMapOrigin;
  uniform vec2 uGridSize;
  uniform vec2 uPlayerXZ;      // 玩家世界 xz(视野边缘渐变用)
  uniform float uSightRadius;  // 视野半径(边缘渐变用)
  uniform float uTime;         // 时间(雾流动用)
  varying vec2 vWorldXZ;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    float a = hash(i), b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }

  void main() {
    vec2 uv = clamp((vWorldXZ - uMapOrigin) / uGridSize, 0.0, 1.0);
    float state = texture2D(uGridTex, uv).r * 255.0;
    // 雾流动:noise 加缓慢时间偏移(云团漂移感,不死板)
    float n = noise(vWorldXZ * 0.05 + vec2(uTime * 0.015, uTime * 0.01));
    // 到玩家距离 → 视野边缘柔化(0.65×半径内全清晰,外缘渐变出薄雾,消除格子硬切)
    float dist = length(vWorldXZ - uPlayerXZ);
    float edge = smoothstep(uSightRadius * 0.65, uSightRadius, dist);
    float alpha;
    if (state < 0.5) {
      alpha = 0.95 + n * 0.05;             // unknown 浓雾(几乎看不到地形)
    } else if (state < 1.5) {
      alpha = 0.58 + n * 0.14;             // explored 半透灰(记得地形轮廓)
    } else {
      alpha = edge * 0.55;                  // visible 露地面,视野边缘渐变薄雾
    }
    gl_FragColor = vec4(uFogColor, alpha);
  }
`;

// ============================================================
// 战争迷雾系统
// ============================================================

/**
 * 战争迷雾系统
 * ============================================================
 * 三部分:
 *  1. 探索网格(200×200 Uint8Array):每格 unknown(0)/explored(1)/visible(2)。
 *     visible=玩家视野圆内(实时);explored=曾可见(记忆,不回 unknown);unknown=未探索。
 *  2. 雾遮罩 mesh(贴合 heightfield):PlaneGeometry 顶点按 TerrainSystem.getHeight
 *     抬升,贴地形起伏。ShaderMaterial 三态着色 + noise 雾状。透明叠在地面上方,
 *     不破坏地面材质/阴影(depthWrite=false)。每帧 grid 变后刷新 DataTexture。
 *  3. 敌方坦克显隐:格子 visible + LOS(复用 perception.hasLineOfSight)→ 显示;
 *     destroyed 残骸始终可见(战果)。
 *
 * 视野遮挡首期用纯圆形(地面雾不体现建筑阴影);NPC 显隐才精确判 LOS。
 *
 * 范围(首期):仅玩家受限(team==='player' 提供视野);NPC 不受迷雾(单向)。
 *             地物(建筑/树)显隐下一步接入。山/补给点/占领点始终可见。
 */
/** 迷雾地物(DestructionSystem.getFogObstacles 返回项;结构类型,FogOfWarSystem 接收) */
interface FogObstacle {
  setVisibility(v: boolean): void;
  x: number;
  z: number;
  intact: boolean;
}

export class FogOfWarSystem {
  private readonly grid: Uint8Array<ArrayBuffer>;
  private readonly gridCols: number;
  private readonly gridRows: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly cellSize: number;
  /** 上一帧 visible 的格子索引(本帧先降 explored,再重新标 visible) */
  private prevVisible: number[] = [];
  private scanAcc = 0;
  /** 地物列表缓存(与 updateGrid 同步刷新,避免每帧分配新数组) */
  private cachedObstacles: FogObstacle[] = [];

  private readonly fogMesh: THREE.Mesh;
  /** grid 纹理(与 this.grid 共享数组引用 → grid 变即 data 变,只需 needsUpdate) */
  private readonly gridTex: THREE.DataTexture;

  constructor(
    private readonly render: RenderScene,
    terrain: TerrainSystem,
    private readonly getPlayer: () => IControllableTank,
    private readonly allTanks: IControllableTank[],
    /** 地物列表 getter(地物显隐用;DestructionSystem.getFogObstacles) */
    private readonly getObstacles: () => FogObstacle[],
  ) {
    const cfg = CONFIG.fog;
    this.cellSize = cfg.cellSize;
    const half = CONFIG.ground.halfSize;
    this.gridCols = Math.round((half.x * 2) / cfg.cellSize);
    this.gridRows = Math.round((half.z * 2) / cfg.cellSize);
    this.grid = new Uint8Array(this.gridCols * this.gridRows); // 全 0 = unknown
    this.originX = -half.x;
    this.originZ = -half.z;

    // 雾 mesh:PlaneGeometry 分段 = (cols-1)×(rows-1),顶点数 = cols×rows(与网格分辨率一致)
    const sizeX = this.gridCols * this.cellSize;
    const sizeZ = this.gridRows * this.cellSize;
    const geo = new THREE.PlaneGeometry(sizeX, sizeZ, this.gridCols - 1, this.gridRows - 1);
    geo.rotateX(-Math.PI / 2); // XY → XZ(Y 向上)
    // 顶点 Y 用 getHeight 采样贴地形起伏, +15cm 防与地形 mesh 闪烁
    const pos = geo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      pos.setY(i, terrain.getHeight(pos.getX(i), pos.getZ(i)) + 0.15);
    }
    pos.needsUpdate = true;

    // grid 纹理(RedFormat 单通道,与 this.grid 同一引用)
    this.gridTex = new THREE.DataTexture(
      this.grid,
      this.gridCols,
      this.gridRows,
      THREE.RedFormat,
      THREE.UnsignedByteType,
    );
    this.gridTex.needsUpdate = true;

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      uniforms: {
        uGridTex: { value: this.gridTex },
        uFogColor: { value: new THREE.Color(cfg.fogColor) },
        uMapOrigin: { value: new THREE.Vector2(this.originX, this.originZ) },
        uGridSize: { value: new THREE.Vector2(sizeX, sizeZ) },
        uPlayerXZ: { value: new THREE.Vector2(0, 0) },
        uSightRadius: { value: cfg.sightRadius },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
    });
    this.fogMesh = new THREE.Mesh(geo, mat);
    this.fogMesh.renderOrder = 2; // 不透明(地面/地物/坦克)之后渲染(透明层)
    render.scene.add(this.fogMesh);

    log.info('fog ready', { grid: `${this.gridCols}×${this.gridRows}`, cells: this.grid.length, sight: cfg.sightRadius });
  }

  /**
   * 每帧更新:grid 推进降频(省算)+ 敌方显隐每帧(防闪烁)。
   * ------------------------------------------------------------
   * 显隐必须每帧:NPC 的渲染同步(SyncBridge/director)每帧会重置 group.visible=true,
   * 若 fog 显隐也降频,降频 return 的那 ~11 帧 visible 被别处 reset 回 true,
   * 而 fog 执行帧设 false → NPC 每 0.2s 闪一次(大部分帧显示,1 帧隐)。
   * 显隐每帧即可覆盖,fog 始终拥有 visible 控制权。grid(视野圆)仍降频(格子变化慢)。
   */
  update(dt: number): void {
    // shader uniform 每帧更新:雾流动(uTime)+ 视野中心跟随玩家(uPlayerXZ,边缘渐变用)
    const u = (this.fogMesh.material as THREE.ShaderMaterial).uniforms;
    const player = this.getPlayer();
    const pp = player.body.translation();
    (u.uPlayerXZ.value as THREE.Vector2).set(pp.x, pp.z);
    u.uTime.value = performance.now() / 1000;
    // 视野半径随 scout 技能动态变化(读取 status.sightScale,1.5=视野扩50%)
    u.uSightRadius.value = CONFIG.fog.sightRadius * player.status.sightScale;

    this.scanAcc += dt;
    if (this.scanAcc >= CONFIG.fog.scanInterval) {
      this.scanAcc = 0;
      this.updateGrid();
      this.gridTex.needsUpdate = true;
    }
    this.updateVisibility();
  }

  /** 降频更新:玩家视野圆格子标 visible,离开的降 explored(记忆地形) */
  private updateGrid(): void {
    const player = this.getPlayer();
    const pp = player.body.translation();
    // 视野半径随 scout 技能动态扩大(status.sightScale,默认1.0;scout 激活=1.5)
    const sightR = CONFIG.fog.sightRadius * player.status.sightScale;
    const sightR2 = sightR * sightR;

    // 上一帧 visible 本帧先降 explored(下面重新进圆的会再变 2,保留 visible)
    for (const idx of this.prevVisible) {
      if (this.grid[idx] === 2) this.grid[idx] = 1;
    }
    this.prevVisible = [];

    // 玩家 intact → 视野圆覆盖格子标 visible(被毁则不标,全雾只留 explored 记忆)
    if (player.state === 'intact') {
      const minCol = Math.max(0, Math.floor((pp.x - sightR - this.originX) / this.cellSize));
      const maxCol = Math.min(this.gridCols - 1, Math.floor((pp.x + sightR - this.originX) / this.cellSize));
      const minRow = Math.max(0, Math.floor((pp.z - sightR - this.originZ) / this.cellSize));
      const maxRow = Math.min(this.gridRows - 1, Math.floor((pp.z + sightR - this.originZ) / this.cellSize));
      for (let r = minRow; r <= maxRow; r++) {
        for (let c = minCol; c <= maxCol; c++) {
          const cx = this.originX + (c + 0.5) * this.cellSize;
          const cz = this.originZ + (r + 0.5) * this.cellSize;
          const dx = cx - pp.x;
          const dz = cz - pp.z;
          if (dx * dx + dz * dz > sightR2) continue;
          const idx = r * this.gridCols + c;
          this.grid[idx] = 2;
          this.prevVisible.push(idx);
        }
      }
    }
  }

  /**
   * 每帧:敌方显隐 —— 仅按视野圆判定(格子 visible),不判 LOS 遮挡。
   * ------------------------------------------------------------
   * 用户期望"只有迷雾外的坦克才看不到",即视野圆内就应可见,不需要建筑遮挡判定。
   * 且 LOS(perception.hasLineOfSight)的射线会命中坦克部位 sensor collider(炮塔/履带,
   * 随炮塔旋转动态移动),handle ≠ 主 collider → 误判遮挡,导致视野内坦克闪烁/消失。
   * 去掉 LOS 后:迷雾内(格子 visible)稳定可见,迷雾外稳定隐藏,无闪烁。
   * 残骸始终可见(战果)。
   */
  private updateVisibility(): void {
    for (const t of this.allTanks) {
      if (t.team !== 'enemy') continue; // 只管敌方(玩家/中立始终可见)
      if (t.state === 'destroyed') {
        t.group.visible = true; // 残骸始终可见(战果)
        continue;
      }
      const tp = t.body.translation();
      t.group.visible = this.cellStateAt(tp.x, tp.z) === 2;
    }
    // 地物(建筑/塔/树/栅栏)显隐:视野圆内显示,否则隐藏。
    // 被破坏的(intact=false)交给破坏逻辑(碎片等),迷雾不碰,避免冲突。
    // 地物列表与 updateGrid 同步刷新(scanInterval 间隔),避免每帧分配数组(GC 压力)
    if (this.cachedObstacles.length === 0 || this.scanAcc === 0) {
      this.cachedObstacles = this.getObstacles();
    }
    for (const o of this.cachedObstacles) {
      if (!o.intact) continue;
      o.setVisibility(this.cellStateAt(o.x, o.z) === 2);
    }
  }

  /** 查世界坐标 (x,z) 所在格子态。0=unknown/1=explored/2=visible;地图外 0 */
  private cellStateAt(x: number, z: number): 0 | 1 | 2 {
    const c = Math.floor((x - this.originX) / this.cellSize);
    const r = Math.floor((z - this.originZ) / this.cellSize);
    if (c < 0 || c >= this.gridCols || r < 0 || r >= this.gridRows) return 0;
    return this.grid[r * this.gridCols + c] as 0 | 1 | 2;
  }

  /** 场景重置/卸载:移除雾 mesh + 释放几何/材质/纹理 */
  dispose(): void {
    this.render.scene.remove(this.fogMesh);
    this.fogMesh.geometry.dispose();
    (this.fogMesh.material as THREE.Material).dispose();
    this.gridTex.dispose();
  }
}
