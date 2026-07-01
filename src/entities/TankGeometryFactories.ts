import {
  BufferGeometry,
  CanvasTexture,
  Float32BufferAttribute,
  MeshStandardMaterial,
  RepeatWrapping,
} from 'three';

/**
 * 坦克几何/纹理工厂
 * ============================================================
 * 所有车型共享的程序几何体和 Canvas 纹理生成函数。
 * 从原 Tank.ts / StaticTank.ts 中剥离，避免车型类之间重复引用。
 */

/**
 * 程序生成履带链节纹理
 * 关键：链节块沿 canvas x(u=长度方向)分布，offset.x 才能让链节逐个滚过。
 */
export function makeTrackTexture(repeat: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  // 深底
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, 64, 32);
  // 链节凸块(沿 x 分布，每 16px 一组)
  for (let x = 0; x < 64; x += 16) {
    ctx.fillStyle = '#3a3d42';
    ctx.fillRect(x + 2, 3, 12, 26); // 凸块
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x + 2, 4, 12, 3); // 上沿高光
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, 0, 2, 32); // 凹槽分隔
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping; // 沿 u 重复
  tex.repeat.set(repeat, 1); // 长度方向重复 repeat 组链节
  tex.anisotropy = 4;
  return tex;
}

/**
 * 程序生成 NATO 风三色迷彩 canvas(硬边块状 + 做旧噪点)
 * ------------------------------------------------------------
 * 算法：底色 → 随机不规则多边形斑块(中绿先铺、深褐叠上破坏规整)
 *       → 全图像素级亮度噪点(模拟灰尘/磨损/掉漆)。
 * 返回 canvas，调用方包成 CanvasTexture 并按需设 repeat 控密度。
 */
export function makeCamouflageCanvas(
  p: { base: number; blobDark: number; blobMid: number },
  size = 256,
): HTMLCanvasElement {
  const cnv = document.createElement('canvas');
  cnv.width = size;
  cnv.height = size;
  const ctx = cnv.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');

  // 底色
  ctx.fillStyle = hex(p.base);
  ctx.fillRect(0, 0, size, size);

  // 不规则硬边斑块(6~9 顶点多边形，半径扰动 → 不规则块状)
  const drawBlob = (color: string, count: number, minR: number, maxR: number): void => {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const cx = Math.random() * size;
      const cy = Math.random() * size;
      const n = 6 + Math.floor(Math.random() * 4);
      const baseR = minR + Math.random() * (maxR - minR);
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const ang = (j / n) * Math.PI * 2;
        const r = baseR * (0.6 + Math.random() * 0.7);
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  };
  drawBlob(hex(p.blobMid), 7, 30, 56); // 中绿大斑块(先铺)
  drawBlob(hex(p.blobDark), 6, 18, 40); // 深黑褐斑块(叠上)

  // 做旧噪点(全图像素级亮度扰动 ±15)
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 30;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  return cnv;
}

/**
 * 战术编号贴花 canvas(深底圆 + 浅色编号文字，圆外透明)
 * 配合材质 alphaTest 抠掉圆外区域，贴炮塔侧面。
 */
export function makeNumberDecalCanvas(text: string, size = 128): HTMLCanvasElement {
  const cnv = document.createElement('canvas');
  cnv.width = size;
  cnv.height = size;
  const ctx = cnv.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.clearRect(0, 0, size, size); // 圆外透明
  ctx.fillStyle = '#1a1d12'; // 深底圆
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d8d2b8'; // 浅色编号
  ctx.font = 'bold 62px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 4);
  return cnv;
}

/**
 * 德军黑十字(Balkenkreuz)贴花画布。
 * 白边黑心十字，二战德军标志，贴炮塔两侧。
 */
export function makeCrossDecalCanvas(size = 128): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  const cx = size / 2;
  const armW = size * 0.16; // 臂宽
  const armL = size * 0.42; // 臂长
  // 白边(外十字)
  ctx.fillStyle = '#e8e4d8';
  ctx.fillRect(cx - armW - 4, cx - armL, (armW + 4) * 2, armL * 2);
  ctx.fillRect(cx - armL, cx - armW - 4, armL * 2, (armW + 4) * 2);
  // 黑心(内十字)
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(cx - armW, cx - armL + 4, armW * 2, armL * 2 - 8);
  ctx.fillRect(cx - armL + 4, cx - armW, armL * 2 - 8, armW * 2);
  return cv;
}

/**
 * 楔形炮塔几何(顶窄底宽 + 顶短底长，四面斜面 → 正面楔形轮廓)
 * ------------------------------------------------------------
 * 用于 T-14 无人炮塔：顶面整体收窄，正面/侧面均呈倾斜楔形装甲。
 * 非共享顶点 + 每面独立 UV(沿用 makeTrapezoidGeometry 方案)，
 * 法线 flat → 装甲棱角锐利；三角形绕向保证外法线。
 */
export function makeWedgeGeometry(h: {
  bottomHalfX: number; topHalfX: number;
  bottomHalfZ: number; topHalfZ: number;
  height: number; centerY: number;
}): BufferGeometry {
  const { bottomHalfX: bx, topHalfX: tx, bottomHalfZ: bz, topHalfZ: tz, height, centerY: cy } = h;
  const yb = cy - height / 2;
  const yt = cy + height / 2;
  const P: number[][] = [
    [-bx, yb, -bz], [bx, yb, -bz], [bx, yb, bz], [-bx, yb, bz], // 0-3 底
    [-tx, yt, -tz], [tx, yt, -tz], [tx, yt, tz], [-tx, yt, tz], // 4-7 顶
  ];
  const faces: number[][] = [
    [0, 1, 2, 3], // 底 -y
    [4, 7, 6, 5], // 顶 +y
    [0, 4, 5, 1], // 前 -z
    [3, 2, 6, 7], // 后 +z
    [0, 3, 7, 4], // 左 -x
    [1, 5, 6, 2], // 右 +x
  ];
  const faceUV = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      const p = P[f[i]];
      positions.push(p[0], p[1], p[2]);
      uvs.push(faceUV[i][0], faceUV[i][1]);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 车首下斜板几何(lower glacis)。
 * ------------------------------------------------------------
 * 生成一个三角楔(三棱柱),作为车头向下倾斜的装甲板,严丝合缝接在车体前端:
 *   - 后竖直面贴车体前端面
 *   - 顶面水平,与车体顶面前缘齐平
 *   - 斜面从前顶缘连续下倾到前底缘(贴向地面)
 *   - 宽度 halfX 与车体同宽
 * 这样斜板与车体连成整体,无空隙,呈"梯形往下"的车头造型。
 */
export function makeGlacisGeometry(halfX: number, halfDepth: number, halfHeight: number): BufferGeometry {
  const x = halfX, d = halfDepth, hh = halfHeight;
  const P: number[][] = [
    [-x, -hh, -d], [x, -hh, -d], // 0,1 底后(贴车体底前端)
    [-x, hh, -d], [x, hh, -d], // 2,3 顶后(贴车体顶前端)
    [-x, -hh, d], [x, -hh, d], // 4,5 前缘(斜面收尖到此,接地面附近)
  ];
  const faces: number[][] = [
    [0, 1, 5, 4], // 底面 -y
    [2, 3, 1, 0], // 后竖直面 -z(贴车体前端面)
    [2, 0, 4], // 左侧 -x(三角形)
    [3, 5, 1], // 右侧 +x(三角形,绕向外)
    [3, 2, 4, 5], // 主斜面(顶后→前缘,下倾)
  ];
  const faceUV = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];
  const triUV = [
    [0, 0], [1, 0], [0, 1],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let fi = 0; fi < faces.length; fi++) {
    const f = faces[fi];
    const uvSet = f.length === 3 ? triUV : faceUV;
    const base = positions.length / 3;
    for (let i = 0; i < f.length; i++) {
      const p = P[f[i]];
      positions.push(p[0], p[1], p[2]);
      uvs.push(uvSet[i][0], uvSet[i][1]);
    }
    if (f.length === 3) {
      index.push(base, base + 1, base + 2);
    } else {
      index.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 楔形炮塔几何(前后非对称收窄,模拟现代/艺术化楔形炮塔)。
 * 与 makeWedgeGeometry(前后对称)的区别:顶面在 z 方向前后独立收窄 ——
 * frontHalfZ 大(正面厚、装甲近乎垂直)、backHalfZ 小(向后急剧收薄),
 * 形成"前厚后薄"的真楔形轮廓,而非四面对称的截头锥。
 *
 * 坐标约定(与 makeWedgeGeometry 一致):+z 为炮塔前方(炮管指向)。
 */
export function makeWedgeTurretGeometry(h: {
  bottomHalfX: number; topHalfX: number; // 底/顶 宽度半(左右对称)
  bottomHalfZ: number; // 底面长度半(前后对称)
  frontHalfZ: number; // 顶面前缘 z(+z 方向,正面厚度)
  backHalfZ: number; // 顶面后缘 z(-z 方向,后部收薄)
  height: number; centerY: number;
}): BufferGeometry {
  const {
    bottomHalfX: bx, topHalfX: tx,
    bottomHalfZ: bz, frontHalfZ: fz, backHalfZ: bkz,
    height, centerY: cy,
  } = h;
  const yb = cy - height / 2;
  const yt = cy + height / 2;
  // 底面:前后对称的完整矩形(z = ±bz)
  const P: number[][] = [
    [-bx, yb, -bz], [bx, yb, -bz], [bx, yb, bz], [-bx, yb, bz], // 0-3 底
    // 顶面:宽度收窄(tx),前后独立(fz≠bkz) → 非对称楔形
    [-tx, yt, -bkz], [tx, yt, -bkz], [tx, yt, fz], [-tx, yt, fz], // 4-7 顶
  ];
  const faces: number[][] = [
    [0, 1, 2, 3], // 底 -y
    [4, 7, 6, 5], // 顶 +y
    [0, 4, 5, 1], // 前 -z(后端面,较薄)
    [3, 2, 6, 7], // 后 +z(前端面,较厚 → 正面装甲)
    [0, 3, 7, 4], // 左 -x
    [1, 5, 6, 2], // 右 +x
  ];
  const faceUV = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      const p = P[f[i]];
      positions.push(p[0], p[1], p[2]);
      uvs.push(faceUV[i][0], faceUV[i][1]);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}

/**
 * 通用 PBR 材质创建 helper
 * 用于减少车型类中重复的材质初始化代码。
 */
export function makePbrMaterial(params: {
  color?: number;
  map?: CanvasTexture;
  roughness: number;
  metalness: number;
  transparent?: boolean;
  alphaTest?: number;
  depthWrite?: boolean;
}): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: params.color ?? 0xffffff,
    map: params.map ?? null,
    roughness: params.roughness,
    metalness: params.metalness,
    transparent: params.transparent ?? false,
    alphaTest: params.alphaTest ?? 0,
    depthWrite: params.depthWrite ?? true,
  });
}
