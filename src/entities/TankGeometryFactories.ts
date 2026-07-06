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

/** 迷彩样式 */
export type CamoStyle = 'nato-blotch' | 'stripe' | 'splatter' | 'two-tone' | 'legacy';

/** 迷彩配色参数 */
export interface CamoParams {
  base: number;
  blobDark: number;
  blobMid: number;
  /** 迷彩样式；默认 'nato-blotch' */
  style?: CamoStyle;
  /** 磨损/褪色强度 0~1；默认 0.25 */
  wear?: number;
}

/** 迷彩生成选项 */
export interface CamoOptions {
  /** 随机种子；不同 seed 产生不同迷彩分布，同一 seed 可复现 */
  seed?: number;
  /** 纹理尺寸；默认 256 */
  resolution?: number;
  /** 覆盖 params 中的 style */
  style?: CamoStyle;
  /** 覆盖 params 中的 wear */
  wear?: number;
}

/**
 * 程序生成迷彩 canvas
 * ============================================================
 * 支持多种军事风格：
 *  - nato-blotch: 多层羽化不规则斑块（现代 NATO 三色迷彩）
 *  - stripe:      倾斜/纵向硬边条纹（二战德军/冬季风格）
 *  - splatter:    喷枪点状 + 飞溅拖尾（旧车/艺术化）
 *  - two-tone:    双色分界 + 羽化过渡（沙漠/海军陆战队风格）
 *  - legacy:      兼容旧版硬边块状 + 噪点
 *
 * 通用增强：
 *  - 边缘羽化（模拟喷涂过度）
 *  - 局部污渍层（低频泥渍 + 高频灰尘）
 *  - 磨损褪色（随机掉漆/泛白）
 *  - 可复现随机种子（同车型不同 ID 迷彩不同）
 *
 * 兼容旧签名：makeCamouflageCanvas(p, size)
 */
export function makeCamouflageCanvas(
  p: CamoParams,
  sizeOrOpts: number | CamoOptions = 256,
  maybeOpts?: CamoOptions,
): HTMLCanvasElement {
  const size = typeof sizeOrOpts === 'number' ? sizeOrOpts : (sizeOrOpts.resolution ?? 256);
  const opts = typeof sizeOrOpts === 'number' ? (maybeOpts ?? {}) : sizeOrOpts;
  const style = opts.style ?? p.style ?? 'nato-blotch';
  const wear = Math.max(0, Math.min(1, opts.wear ?? p.wear ?? 0.25));
  const seed = opts.seed ?? 0;
  const rng = createRng(seed);

  const cnv = document.createElement('canvas');
  cnv.width = size;
  cnv.height = size;
  const ctx = cnv.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');

  // 底色
  ctx.fillStyle = hex(p.base);
  ctx.fillRect(0, 0, size, size);

  switch (style) {
    case 'stripe':
      drawStripe(ctx, rng, p, size);
      break;
    case 'splatter':
      drawSplatter(ctx, rng, p, size);
      break;
    case 'two-tone':
      drawTwoTone(ctx, rng, p, size);
      break;
    case 'legacy':
      drawLegacyBlobs(ctx, rng, p, size);
      break;
    case 'nato-blotch':
    default:
      drawNatoBlotch(ctx, rng, p, size);
      break;
  }

  // 局部污渍（泥渍/油污）—— 所有样式共用，增强真实感
  addStains(ctx, rng, p, size, wear);

  // 做旧噪点（灰尘/细小掉漆）
  addNoise(ctx, rng, size, 22);

  // 磨损褪色（掉漆泛白/边缘磨损）
  if (wear > 0.05) addWear(ctx, rng, size, wear);

  return cnv;
}

// ============================================================
// 迷彩样式实现
// ============================================================

/** NATO 斑点：多层羽化不规则斑块 + 黑色点缀 + 沙色高光 */
function drawNatoBlotch(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  p: CamoParams,
  size: number,
): void {
  // 中色大斑块（先铺，决定整体布局）
  drawFeatheredBlob(ctx, rng, size, hex(p.blobMid), 8, size * 0.12, size * 0.26, 0.28, 5);
  // 深色小斑块（叠上，破坏规整）
  drawFeatheredBlob(ctx, rng, size, hex(p.blobDark), 10, size * 0.06, size * 0.16, 0.32, 6);
  // 黑色 tiny 点缀（增加细碎层次）
  const dark2 = darken(p.blobDark, 0.8);
  drawFeatheredBlob(ctx, rng, size, hex(dark2), 14, size * 0.025, size * 0.06, 0.35, 5);
  // 沙色高光小斑块（模拟掉漆/浅色灰尘，让表面不沉闷）
  // 对浅色沙漠底色减弱提亮幅度，避免接近纯白显得塑料
  const highlightFactor = isLightBase(p.base) ? 1.12 : 1.35;
  const highlight = lighten(p.base, highlightFactor);
  drawFeatheredBlob(ctx, rng, size, hex(highlight), 10, size * 0.02, size * 0.05, 0.4, 5);
}

/** 条纹：断裂不规则带状（德军/冬季风格） */
function drawStripe(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  p: CamoParams,
  size: number,
): void {
  const bands = 3 + Math.floor(rng() * 3); // 3~5 条宽条纹
  const angle = (rng() - 0.5) * 0.6;
  const stripeW = size / (bands * 0.8);
  const colors = [hex(p.blobMid), hex(p.blobDark), hex(darken(p.blobDark, 0.75))];

  ctx.save();
  ctx.translate(size / 2, size / 2);
  ctx.rotate(angle);
  ctx.translate(-size / 2, -size / 2);

  for (let i = -1; i < bands + 1; i++) {
    const baseX = i * stripeW + (rng() - 0.5) * stripeW * 0.3;
    const w = stripeW * (0.6 + rng() * 0.5);
    const color = colors[i % colors.length];

    // 主条纹：用羽化矩形 + 随机分段断裂
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = size * 0.02;
    ctx.fillStyle = color;
    ctx.fillRect(baseX, -size, w, size * 3);
    ctx.restore();

    // 切出随机矩形“缺口”，模拟断裂/不规则边缘
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    const gaps = 2 + Math.floor(rng() * 3);
    for (let g = 0; g < gaps; g++) {
      const gx = baseX + rng() * w;
      const gy = -size + rng() * size * 3;
      const gw = w * (0.2 + rng() * 0.5);
      const gh = size * (0.08 + rng() * 0.12);
      ctx.fillRect(gx, gy, gw, gh);
    }
    ctx.restore();
  }
  ctx.restore();
}

/** 喷溅：喷枪点状 + 飞溅拖尾 */
function drawSplatter(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  p: CamoParams,
  size: number,
): void {
  const colors = [hex(p.blobMid), hex(p.blobDark)];
  for (let c = 0; c < colors.length; c++) {
    const color = colors[c];
    const count = c === 0 ? 35 : 45;
    for (let i = 0; i < count; i++) {
      const cx = rng() * size;
      const cy = rng() * size;
      const r = (size * 0.015) + rng() * (size * 0.05);
      const angle = rng() * Math.PI * 2;
      const tailLen = r * (2 + rng() * 3);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);
      ctx.shadowColor = color;
      ctx.shadowBlur = r * 0.4;
      ctx.fillStyle = color;
      // 圆点主体
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      // 拖尾
      ctx.beginPath();
      ctx.ellipse(tailLen * 0.6, 0, tailLen * 0.6, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  // 密集小点覆盖层
  drawFeatheredBlob(ctx, rng, size, hex(darken(p.blobDark, 0.7)), 30, size * 0.01, size * 0.025, 0.3, 4);
}

/** 双色分层：不规则波浪分界（沙漠/海军陆战队风格） */
function drawTwoTone(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  p: CamoParams,
  size: number,
): void {
  const splitY = size * (0.45 + rng() * 0.15);
  const segments = 14;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= segments; i++) {
    const x = (i / segments) * size;
    const noise = Math.sin(i * 0.8 + rng() * 3) * size * 0.04 + (rng() - 0.5) * size * 0.06;
    points.push({ x, y: splitY + noise });
  }

  // 下半区域：深色渐变
  ctx.save();
  ctx.shadowColor = hex(p.blobMid);
  ctx.shadowBlur = size * 0.04;
  ctx.beginPath();
  ctx.moveTo(0, size);
  for (const pt of points) ctx.lineTo(pt.x, pt.y);
  ctx.lineTo(size, size);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, splitY, 0, size);
  grad.addColorStop(0, hex(p.blobMid));
  grad.addColorStop(1, hex(p.blobDark));
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();

  // 上半区域：叠几条不規則深色波浪带，打破单调
  ctx.save();
  ctx.globalAlpha = 0.45;
  for (let i = 0; i < 4; i++) {
    const y = splitY - size * (0.08 + rng() * 0.18);
    const h = size * (0.03 + rng() * 0.04);
    const grad2 = ctx.createLinearGradient(0, y - h, 0, y + h);
    grad2.addColorStop(0, hex(p.base));
    grad2.addColorStop(0.5, hex(p.blobDark));
    grad2.addColorStop(1, hex(p.base));
    ctx.fillStyle = grad2;
    ctx.fillRect(0, y - h, size, h * 2);
  }
  ctx.restore();
}

/** 旧版硬边块状（兼容 legacy） */
function drawLegacyBlobs(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  p: CamoParams,
  size: number,
): void {
  drawHardBlob(ctx, rng, size, hex(p.blobMid), 7, size * 0.12, size * 0.22, 6);
  drawHardBlob(ctx, rng, size, hex(p.blobDark), 6, size * 0.07, size * 0.16, 6);
}

// ============================================================
// 通用绘制辅助
// ============================================================

/** 绘制一个羽化边缘的不规则多边形斑块 */
function drawFeatheredBlob(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  size: number,
  color: string,
  count: number,
  minR: number,
  maxR: number,
  feather: number,
  minVertices = 5,
): void {
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = (minR + maxR) * 0.5 * feather;
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const n = minVertices + Math.floor(rng() * 4);
    const baseR = minR + rng() * (maxR - minR);
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const ang = (j / n) * Math.PI * 2;
      const r = baseR * (0.65 + rng() * 0.7);
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** 绘制硬边不规则多边形斑块 */
function drawHardBlob(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  size: number,
  color: string,
  count: number,
  minR: number,
  maxR: number,
  minVertices = 5,
): void {
  ctx.fillStyle = color;
  for (let i = 0; i < count; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const n = minVertices + Math.floor(rng() * 4);
    const baseR = minR + rng() * (maxR - minR);
    ctx.beginPath();
    for (let j = 0; j < n; j++) {
      const ang = (j / n) * Math.PI * 2;
      const r = baseR * (0.6 + rng() * 0.7);
      const x = cx + Math.cos(ang) * r;
      const y = cy + Math.sin(ang) * r;
      if (j === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/** 局部污渍层：低频大污渍 + 高频小斑点 */
function addStains(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  p: CamoParams,
  size: number,
  wear: number,
): void {
  // 低频大污渍（泥/油污），颜色更深，偏 canvas 下半部
  const stainCount = 3 + Math.floor(rng() * 3);
  for (let i = 0; i < stainCount; i++) {
    const cx = rng() * size;
    const cy = size * (0.55 + rng() * 0.45); // 偏下
    const rx = size * (0.12 + rng() * 0.12);
    const ry = size * (0.04 + rng() * 0.06);
    const stainColor = hex(darken(p.blobDark, 0.65));
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
    grad.addColorStop(0, stainColor);
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.globalAlpha = 0.35 + wear * 0.25;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, (rng() - 0.5) * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // 高频小灰尘/油污点
  ctx.save();
  ctx.globalAlpha = 0.25 + wear * 0.2;
  for (let i = 0; i < size * 0.6; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 0.5 + rng() * 1.5;
    ctx.fillStyle = rng() > 0.5 ? '#1a1a1a' : '#5a5a5a';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** 全图噪点 */
function addNoise(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  size: number,
  amount: number,
): void {
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * amount;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);
}

/** 磨损褪色：随机小区域变亮（掉漆露底漆/日晒泛白） */
function addWear(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  size: number,
  wear: number,
): void {
  const count = Math.floor((0.08 + wear * 0.18) * size);
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  for (let i = 0; i < count; i++) {
    const cx = rng() * size;
    const cy = rng() * size;
    const r = size * (0.01 + rng() * 0.03);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// ============================================================
// 颜色/随机工具
// ============================================================

function hex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

/** 颜色变暗(NPC 难度配色派生用,故 export) */
export function darken(c: number, factor: number): number {
  const r = Math.max(0, Math.min(255, ((c >> 16) & 0xff) * factor));
  const g = Math.max(0, Math.min(255, ((c >> 8) & 0xff) * factor));
  const b = Math.max(0, Math.min(255, (c & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

/** 颜色变亮 */
function lighten(c: number, factor: number): number {
  const r = Math.max(0, Math.min(255, ((c >> 16) & 0xff) * factor));
  const g = Math.max(0, Math.min(255, ((c >> 8) & 0xff) * factor));
  const b = Math.max(0, Math.min(255, (c & 0xff) * factor));
  return (r << 16) | (g << 8) | b;
}

/** 判断底色是否偏亮（沙漠黄等），用于动态调整高光强度 */
function isLightBase(c: number): boolean {
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  return (r + g + b) / 3 > 140;
}

/** 可复现伪随机生成器（基于 xorshift / mulberry32 混合） */
function createRng(seed = 0): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 123456789;
  return () => {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
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
 * 军衔标识贴花(M3+ NPC 难度区分)。
 * ------------------------------------------------------------
 *  - chevron: 双道 V 形杠(士官军衔),regular 用
 *  - skull:   简化骷髅(圆头颅+双眼洞+鼻孔+牙齿),veteran 用
 * 圆形深底 + 彩色图案,贴炮塔后部两侧。alphaTest 抠圆外。
 * 配色远距离主区分(黑/暗),标识近战辅助确认。
 */
export function makeRankDecalCanvas(
  rank: 'chevron' | 'skull',
  color: number,
  size = 128,
): HTMLCanvasElement {
  const cnv = document.createElement('canvas');
  cnv.width = size;
  cnv.height = size;
  const ctx = cnv.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.clearRect(0, 0, size, size);
  // 圆形深底(与战术编号贴花一致,视觉风格统一)
  ctx.fillStyle = '#1a1d12';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fill();
  if (rank === 'chevron') {
    drawChevron(ctx, size, color);
  } else {
    drawSkull(ctx, size, color);
  }
  return cnv;
}

/** 双道 V 杠(开口向上,士官臂章常见样式) */
function drawChevron(ctx: CanvasRenderingContext2D, size: number, color: number): void {
  ctx.strokeStyle = hex(color);
  ctx.lineWidth = size * 0.075;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cx = size / 2;
  for (let i = 0; i < 2; i++) {
    const yOff = size * (0.36 + i * 0.2);
    const span = size * 0.22;
    ctx.beginPath();
    ctx.moveTo(cx - span, yOff);
    ctx.lineTo(cx, yOff + size * 0.13);
    ctx.lineTo(cx + span, yOff);
    ctx.stroke();
  }
}

/** 简化骷髅(圆头颅 + 双眼洞 + 鼻孔 + 牙齿线) */
function drawSkull(ctx: CanvasRenderingContext2D, size: number, color: number): void {
  const cx = size / 2;
  const cy = size * 0.47;
  const r = size * 0.24;
  // 头颅 + 下颌(主体, color 填充)
  ctx.fillStyle = hex(color);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillRect(cx - r * 0.72, cy + r * 0.2, r * 1.44, r * 0.45);
  // 眼洞(深色镂空)
  ctx.fillStyle = '#1a1d12';
  ctx.beginPath();
  ctx.ellipse(cx - r * 0.4, cy - r * 0.1, r * 0.22, r * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx + r * 0.4, cy - r * 0.1, r * 0.22, r * 0.28, 0, 0, Math.PI * 2);
  ctx.fill();
  // 鼻孔(倒三角)
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.02);
  ctx.lineTo(cx - r * 0.1, cy + r * 0.22);
  ctx.lineTo(cx + r * 0.1, cy + r * 0.22);
  ctx.closePath();
  ctx.fill();
  // 牙齿(竖线分隔)
  ctx.strokeStyle = '#1a1d12';
  ctx.lineWidth = size * 0.018;
  for (let i = -2; i <= 2; i++) {
    const x = cx + i * r * 0.2;
    ctx.beginPath();
    ctx.moveTo(x, cy + r * 0.28);
    ctx.lineTo(x, cy + r * 0.6);
    ctx.stroke();
  }
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
