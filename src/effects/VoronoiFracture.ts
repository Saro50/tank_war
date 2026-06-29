import { Vector3 } from 'three';
import { Logger } from '../utils/Logger';

const log = Logger.create('Voronoi');

/**
 * Voronoi 预切割
 * ============================================================
 * 把一个盒子切成 N 个凸碎片(Voronoi cell)。
 *
 * 算法：半空间求交法(无需维护多面体面结构，直接出顶点集)：
 *  - 每个 cell 的半空间集 = 盒子6面 ∪ 与其他种子的中垂面(取本侧)。
 *  - cell 顶点 = 所有"3平面交点"中满足全部半空间约束的点。
 *  - 顶点交凸包(Three ConvexGeometry / Rapier convexHull)即得碎片。
 *
 * 性能：结果按(尺寸,种子数)缓存，预计算一次，运行时破碎零计算。
 */

export interface FracturePiece {
  /** 顶点(已平移到以碎片质心为原点)，单位 m */
  vertices: Vector3[];
  /** 碎片质心(相对盒子中心)，破碎时用于定位世界位置 */
  center: Vector3;
}

interface Plane {
  nx: number;
  ny: number;
  nz: number;
  d: number; // 内侧满足 n·p + d <= 0
}
interface Pt {
  x: number;
  y: number;
  z: number;
}

const cache = new Map<string, FracturePiece[]>();

/**
 * 切割盒子
 * @param size 盒子全尺寸(m)
 * @param seedCount 种子数(≈碎片数)
 */
export function fractureBox(
  size: { x: number; y: number; z: number },
  seedCount: number,
): FracturePiece[] {
  const key = `${size.x.toFixed(3)},${size.y.toFixed(3)},${size.z.toFixed(3)},${seedCount}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const seeds = generateSeeds(size, seedCount);
  const pieces: FracturePiece[] = [];

  for (let i = 0; i < seeds.length; i++) {
    const planes = buildPlanes(seeds, i, size);
    const verts = cellVertices(planes);
    if (verts.length < 4) continue; // 退化 cell 跳过
    const center = avg(verts);
    const rel = verts.map(
      (v) => new Vector3(v.x - center.x, v.y - center.y, v.z - center.z),
    );
    pieces.push({ vertices: rel, center: new Vector3(center.x, center.y, center.z) });
  }

  if (pieces.length === 0) {
    // 兜底：算法退化时整个盒子作为单碎片，保证不静默失败
    log.warn('fracture produced 0 pieces, fallback to whole', { size, seedCount });
    const hx = size.x / 2,
      hy = size.y / 2,
      hz = size.z / 2;
    pieces.push({
      vertices: [
        new Vector3(-hx, -hy, -hz), new Vector3(hx, -hy, -hz),
        new Vector3(hx, hy, -hz), new Vector3(-hx, hy, -hz),
        new Vector3(-hx, -hy, hz), new Vector3(hx, -hy, hz),
        new Vector3(hx, hy, hz), new Vector3(-hx, hy, hz),
      ],
      center: new Vector3(0, 0, 0),
    });
  }

  cache.set(key, pieces);
  log.info('fractured', { size, seedCount, pieces: pieces.length });
  return pieces;
}

/** 在盒子内撒种子(带边距，避免贴边导致退化 cell) */
function generateSeeds(size: { x: number; y: number; z: number }, n: number): Pt[] {
  const hx = size.x / 2,
    hy = size.y / 2,
    hz = size.z / 2;
  const margin = 0.12;
  const seeds: Pt[] = [];
  for (let i = 0; i < n; i++) {
    seeds.push({
      x: (Math.random() * 2 - 1) * hx * (1 - margin),
      y: (Math.random() * 2 - 1) * hy * (1 - margin),
      z: (Math.random() * 2 - 1) * hz * (1 - margin),
    });
  }
  return seeds;
}

/** 构建种子 i 的 cell 半空间集 */
function buildPlanes(
  seeds: Pt[],
  i: number,
  size: { x: number; y: number; z: number },
): Plane[] {
  const hx = size.x / 2,
    hy = size.y / 2,
    hz = size.z / 2;
  const planes: Plane[] = [
    { nx: -1, ny: 0, nz: 0, d: hx }, // x >= -hx
    { nx: 1, ny: 0, nz: 0, d: hx }, // x <=  hx
    { nx: 0, ny: -1, nz: 0, d: hy },
    { nx: 0, ny: 1, nz: 0, d: hy },
    { nx: 0, ny: 0, nz: -1, d: hz },
    { nx: 0, ny: 0, nz: 1, d: hz },
  ];
  const si = seeds[i];
  const si2 = si.x * si.x + si.y * si.y + si.z * si.z;
  for (let j = 0; j < seeds.length; j++) {
    if (j === i) continue;
    const sj = seeds[j];
    const sj2 = sj.x * sj.x + sj.y * sj.y + sj.z * sj.z;
    // |p-si|² <= |p-sj|²  →  (sj-si)·p <= (|sj|²-|si|²)/2
    // n=(sj-si), d=-(sj2-si2)/2, 内侧 n·p+d<=0
    planes.push({
      nx: sj.x - si.x,
      ny: sj.y - si.y,
      nz: sj.z - si.z,
      d: -(sj2 - si2) / 2,
    });
  }
  return planes;
}

/** 3 平面求交点(克莱姆法则)，平行/退化返回 null */
function intersect3(a: Plane, b: Plane, c: Plane): Pt | null {
  const det = det3(
    a.nx, a.ny, a.nz,
    b.nx, b.ny, b.nz,
    c.nx, c.ny, c.nz,
  );
  if (Math.abs(det) < 1e-9) return null;
  const x = det3(
    -a.d, a.ny, a.nz,
    -b.d, b.ny, b.nz,
    -c.d, c.ny, c.nz,
  ) / det;
  const y = det3(
    a.nx, -a.d, a.nz,
    b.nx, -b.d, b.nz,
    c.nx, -c.d, c.nz,
  ) / det;
  const z = det3(
    a.nx, a.ny, -a.d,
    b.nx, b.ny, -b.d,
    c.nx, c.ny, -c.d,
  ) / det;
  return { x, y, z };
}

/** 3x3 行列式 */
function det3(
  a11: number, a12: number, a13: number,
  a21: number, a22: number, a23: number,
  a31: number, a32: number, a33: number,
): number {
  return (
    a11 * (a22 * a33 - a23 * a32)
    - a12 * (a21 * a33 - a23 * a31)
    + a13 * (a21 * a32 - a22 * a31)
  );
}

/** 求 cell 顶点：所有 3 平面交点中满足全部半空间的，去重 */
function cellVertices(planes: Plane[]): Pt[] {
  const EPS = 1e-4;
  const raw: Pt[] = [];
  for (let i = 0; i < planes.length; i++) {
    for (let j = i + 1; j < planes.length; j++) {
      for (let k = j + 1; k < planes.length; k++) {
        const p = intersect3(planes[i], planes[j], planes[k]);
        if (!p) continue;
        let ok = true;
        for (const pl of planes) {
          if (pl.nx * p.x + pl.ny * p.y + pl.nz * p.z + pl.d > EPS) {
            ok = false;
            break;
          }
        }
        if (ok) raw.push(p);
      }
    }
  }
  return dedupe(raw, 1e-3);
}

/** 距离去重 */
function dedupe(pts: Pt[], eps: number): Pt[] {
  const out: Pt[] = [];
  const eps2 = eps * eps;
  for (const p of pts) {
    let dup = false;
    for (const q of out) {
      const dx = p.x - q.x,
        dy = p.y - q.y,
        dz = p.z - q.z;
      if (dx * dx + dy * dy + dz * dz < eps2) {
        dup = true;
        break;
      }
    }
    if (!dup) out.push(p);
  }
  return out;
}

function avg(pts: Pt[]): Pt {
  let x = 0,
    y = 0,
    z = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
    z += p.z;
  }
  return { x: x / pts.length, y: y / pts.length, z: z / pts.length };
}

/**
 * 网格切割(确定性，适合细长/规则结构如塔楼)
 * ------------------------------------------------------------
 * 沿三轴把盒子切成 nx×ny×nz 个小 cuboid，每块独立、可分离。
 * 比 Voronoi 可靠(Voronoi 对细长体易退化成 1-2 块)。
 * 塔楼用 2×6×2=24 块，倒塌时裂开明显。
 */
export interface GridPiece {
  /** 碎片质心(相对盒子中心) */
  center: Vector3;
  /** 碎片半尺寸 */
  half: { x: number; y: number; z: number };
}

export function gridFracture(
  size: { x: number; y: number; z: number },
  nx: number,
  ny: number,
  nz: number,
): GridPiece[] {
  const pieces: GridPiece[] = [];
  const sx = size.x / nx,
    sy = size.y / ny,
    sz = size.z / nz;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        pieces.push({
          center: new Vector3(
            -size.x / 2 + (i + 0.5) * sx,
            -size.y / 2 + (j + 0.5) * sy,
            -size.z / 2 + (k + 0.5) * sz,
          ),
          half: { x: sx / 2, y: sy / 2, z: sz / 2 },
        });
      }
    }
  }
  return pieces;
}
