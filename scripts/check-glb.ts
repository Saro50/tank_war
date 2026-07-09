/**
 * check-glb.ts — glb 坦克资产套用前自检
 * ============================================================
 * 运行: npx tsx scripts/check-glb.ts [glb文件...] (默认扫 public/assets/*.glb)
 *
 * 目的:检测 glb 能否【直接套用】到 GltfTankAsset,并保证游戏内所有动作
 *      (炮塔旋转/炮管俯仰/开炮/移动/爆炸/焦黑等)正常运作。不修改任何游戏代码。
 *
 * 检测依据 = GltfTankAsset(GltfTankAsset.ts)的实际要求 + 各动作对模型的依赖:
 *  [A 直接套用门槛] 严格英文命名 Turret/Barrel/Muzzle(GltfTankAsset.findByName 大小写敏感)
 *  [B 动画驱动]     无 skin/骨骼(rotation 才有效) + pivot 在座圈/铰链(旋转不画弧)
 *  [C 单位尺寸]     米制(归一化会缩放,但量级要对)
 *  [D 材质]         PBR/MeshStandardMaterial(scorch 焦黑才能生效)
 *  [E 降级项]       履带独立UV(滚动)/Hull节点(车身摇晃) —— 不致命但丢效果
 *
 * 命名不符时,额外用中文节点(炮塔/炮管组)做"改名后可行性预判",
 * 让用户知道:改名 + 修 pivot 后能否套用。
 */
import fs from 'node:fs';
import path from 'node:path';

// ============================================================
// 检测基准(来自 src/entities/GltfTankAsset.ts 与 src/config.ts)
// ============================================================

/** GltfTankAsset.build() 实际查找的节点名(大小写敏感,见 GltfTankAsset.NODE) */
const STRICT = { turret: 'Turret', barrel: 'Barrel', muzzle: 'Muzzle' } as const;

/** 各语义节点的别名(中英文),用于检测到近似命名时给改名提示。
 *  顺序即匹配优先级:精确中文优先,再英文变体。findSemanticApprox 按此查找。 */
const SEMANTIC_ALIASES: Record<'Turret' | 'Barrel' | 'Muzzle', string[]> = {
  Turret: ['炮塔', 'turret', 'tower', '炮塔组'],
  Barrel: ['炮管组', '炮管', '炮身', 'barrel', 'cannon', 'gun'],
  Muzzle: ['炮口', 'muzzle', '枪口'],
};

/** Blender 操作提示(给美术的速查;在脚本里就近输出,省去翻文档) */
const TIP = {
  /** 改名提示:Outliner 双击改名 */
  rename: (from: string, to: string): string => `Outliner 双击 '${from}' → 改名为 '${to}'`,
  /** 新增 Muzzle Empty 的完整步骤 */
  addMuzzle: `炮口加 Empty: Add → Empty → Plain Axes,放炮口正中(略出炮口),命名 'Muzzle',Outliner 拖到 Barrel 下`,
  /** Barrel pivot 优化(消除俯仰小弧,可选) */
  barrelPivot: `可选(消除俯仰小弧): 选 Barrel → Shift+右键 放 3D Cursor 到炮管根部 → Object → Transform → Set Origin → Origin to 3D Cursor`,
  /** 建立父子关系 */
  reparent: (child: string, parent: string): string => `Outliner 把 '${child}' 拖到 '${parent}' 下(或选中 ${child} → Shift 选中 ${parent} → Ctrl+P)`,
};

/** 玩家 T14 物理碰撞体尺寸(来自 config.ts bodyHalf×2,GltfTankAsset 按此归一化) */
const REF_SIZE = { x: 2.6, y: 1.56, z: 4.3 };

/** pivot 判定阈值(米) */
const PIVOT_OK = 0.2; // origin 距包围盒 < 此值 = 在几何上
const PIVOT_FAIL = 0.3; // > 此值 = 在几何外(画弧)

// ============================================================
// glb 解析
// ============================================================

interface Gltf {
  nodes?: Array<{
    name?: string;
    mesh?: number;
    skin?: number;
    translation?: number[];
    rotation?: number[];
    scale?: number[];
    children?: number[];
  }>;
  meshes?: Array<{ primitives: Array<{ attributes: { POSITION: number } }> }>;
  accessors?: Array<{ min?: number[]; max?: number[]; type?: string }>;
  materials?: Array<{ name?: string; pbrMetallicRoughness?: unknown }>;
  skins?: unknown[];
  animations?: unknown[];
  extensionsUsed?: string[];
}

/** 解析 glb 二进制,提取 JSON chunk(glb=12字节header + chunk(JSON) + chunk(BIN)) */
function parseGlb(file: string): Gltf {
  const buf = fs.readFileSync(file);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'glTF') throw new Error(`${file} 不是合法 glb(magic=${magic})`);
  const jsonLen = buf.readUInt32LE(12);
  return JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
}

// ============================================================
// 场景图几何分析(世界坐标累积,假设 Group 无 rot/scale —— 当前 glb 确实如此)
// ============================================================

interface Vec3 {
  x: number;
  y: number;
  z: number;
}
interface BBox {
  min: Vec3;
  max: Vec3;
}

/** 递归算每个节点的世界 translation(累加父级)。遇到非单位 rotation/scale 标记(影响精度) */
function worldTranslations(gltf: Gltf): { wt: Vec3[]; hasComplex: boolean } {
  const nodes = gltf.nodes || [];
  const wt: Vec3[] = nodes.map(() => ({ x: 0, y: 0, z: 0 }));
  let hasComplex = false;
  const roots = nodes
    .map((_, i) => i)
    .filter((i) => !nodes.some((o) => (o.children || []).includes(i)));
  const visit = (idx: number, parent: Vec3): void => {
    const n = nodes[idx];
    const t = n.translation || [0, 0, 0];
    const w = { x: parent.x + t[0], y: parent.y + t[1], z: parent.z + t[2] };
    wt[idx] = w;
    // 检测非单位旋转/缩放(会让"纯translation累加"近似失效)
    if (n.rotation && !isIdentityQuat(n.rotation)) hasComplex = true;
    if (n.scale && !isUnitScale(n.scale)) hasComplex = true;
    for (const c of n.children || []) visit(c, w);
  };
  roots.forEach((r) => visit(r, { x: 0, y: 0, z: 0 }));
  return { wt, hasComplex };
}

function isIdentityQuat(q: number[]): boolean {
  return Math.abs(q[0]) < 1e-6 && Math.abs(q[1]) < 1e-6 && Math.abs(q[2]) < 1e-6 && Math.abs(q[3] - 1) < 1e-6;
}
function isUnitScale(s: number[]): boolean {
  return Math.abs(s[0] - 1) < 1e-6 && Math.abs(s[1] - 1) < 1e-6 && Math.abs(s[2] - 1) < 1e-6;
}

/** 节点的子树包围盒(合并所有 mesh 的 POSITION accessor min/max + 世界 translation) */
function subtreeBBox(gltf: Gltf, rootIdx: number, wt: Vec3[]): BBox | null {
  const nodes = gltf.nodes || [];
  const min: Vec3 = { x: Infinity, y: Infinity, z: Infinity };
  const max: Vec3 = { x: -Infinity, y: -Infinity, z: -Infinity };
  let has = false;
  const stack = [rootIdx];
  while (stack.length) {
    const i = stack.pop()!;
    const n = nodes[i];
    if (n.mesh !== undefined && gltf.meshes && gltf.accessors) {
      const prim = gltf.meshes[n.mesh]?.primitives[0];
      const acc = prim && gltf.accessors[prim.attributes.POSITION];
      if (acc && acc.min && acc.max) {
        const w = wt[i];
        min.x = Math.min(min.x, acc.min[0] + w.x);
        min.y = Math.min(min.y, acc.min[1] + w.y);
        min.z = Math.min(min.z, acc.min[2] + w.z);
        max.x = Math.max(max.x, acc.max[0] + w.x);
        max.y = Math.max(max.y, acc.max[1] + w.y);
        max.z = Math.max(max.z, acc.max[2] + w.z);
        has = true;
      }
    }
    for (const c of n.children || []) stack.push(c);
  }
  return has ? { min, max } : null;
}

/** 点到包围盒最近点距离(0=在盒内) */
function distPointBBox(p: Vec3, b: BBox): number {
  const cx = Math.max(b.min.x, Math.min(p.x, b.max.x));
  const cy = Math.max(b.min.y, Math.min(p.y, b.max.y));
  const cz = Math.max(b.min.z, Math.min(p.z, b.max.z));
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}

const bboxSize = (b: BBox): Vec3 => ({ x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z });
const bboxCenter = (b: BBox): Vec3 => ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 });

// ============================================================
// 报告输出
// ============================================================

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
const PASS = c.green('✓');
const FAIL = c.red('✗');
const WARN = c.yellow('⚠');

interface CheckResult {
  pass: boolean;
  fatal: string[]; // 致命问题(直接套用失败的原因)
  degraded: string[]; // 降级(能跑但丢效果)
  fixes: string[]; // 给美术的具体修改建议(Blender 操作)
}

/** 检测单个 glb */
function check(file: string, gltf: Gltf): CheckResult {
  const result: CheckResult = { pass: true, fatal: [], degraded: [], fixes: [] };
  const nodes = gltf.nodes || [];
  const stat = fs.statSync(file);
  console.log(c.bold(`\n══════════ ${path.basename(file)} ══════════`));
  console.log(c.dim(`体积 ${(stat.size / 1024).toFixed(0)}KB | meshes ${gltf.meshes?.length ?? 0} | materials ${gltf.materials?.length ?? 0}`));

  // —— [A] 直接套用门槛:严格英文命名 + 层级 + Muzzle Empty ——
  console.log(c.bold(`\n[A] 直接套用门槛(${c.dim('GltfTankAsset 严格英文命名,大小写敏感')})`));
  const findStrict = (name: string): number => nodes.findIndex((n) => n.name === name);
  const tIdx = findStrict(STRICT.turret);
  const bIdx = findStrict(STRICT.barrel);
  const mIdx = findStrict(STRICT.muzzle);

  // 提示输出辅助:在检测结果下方紧跟一行 Blender 操作建议(青色 💡)
  const tip = (s: string): void => console.log(`              ${c.cyan('💡 ' + s)}`);
  let strictOk = true;
  // Turret
  if (tIdx < 0) {
    strictOk = false;
    result.fatal.push('缺 Turret 节点 → 炮塔旋转/开炮方向/炮口焰/击毁炸炮塔 全部失效');
    console.log(`    Turret : ${FAIL} 未找到${c.dim('  → 炮塔旋转/开炮方向/炮口焰/炸炮塔')}`);
    const approx = findSemanticApprox(nodes, 'Turret');
    if (approx) {
      const t = TIP.rename(approx.name, 'Turret');
      tip(t);
      result.fixes.push(t);
    } else {
      tip("需有名为 'Turret' 的对象(炮塔主体,绕 Y 旋转)");
    }
  } else {
    console.log(`    Turret : ${PASS} 找到 #${tIdx}`);
  }
  // Barrel(须在 Turret 子树)
  if (bIdx < 0) {
    strictOk = false;
    result.fatal.push('缺 Barrel 节点 → 炮管俯仰/后坐力/抛物线瞄准 失效');
    console.log(`    Barrel : ${FAIL} 未找到${c.dim('  → 炮管俯仰/后坐力/瞄准')}`);
    const approx = findSemanticApprox(nodes, 'Barrel');
    if (approx) {
      const t = TIP.rename(approx.name, 'Barrel');
      tip(t);
      result.fixes.push(t);
    } else {
      tip("需有名为 'Barrel' 的对象(炮管组,绕 X 俯仰)");
    }
  } else if (tIdx >= 0 && !isDescendant(nodes, bIdx, tIdx)) {
    strictOk = false;
    result.fatal.push('Barrel 不在 Turret 子树 → 层级不符');
    console.log(`    Barrel : ${WARN} 找到但不在 Turret 子树(层级不符)`);
    const t = TIP.reparent('Barrel', 'Turret');
    tip(t);
    result.fixes.push(t);
  } else {
    console.log(`    Barrel : ${PASS} 找到 #${bIdx}`);
  }
  // Muzzle(须在 Barrel 子树 + 是 Empty)
  if (mIdx < 0) {
    strictOk = false;
    result.fatal.push('缺 Muzzle 节点 → 开炮位置/炮弹方向/炮口焰 错位');
    console.log(`    Muzzle : ${FAIL} 未找到${c.dim('  → 开炮位置/炮弹方向/炮口焰')}`);
    const approx = findSemanticApprox(nodes, 'Muzzle');
    // 统一建议【新增 Empty】,不推荐改现有 mesh 名(会破坏炮口装置等视觉部件)。
    // 检测到炮口附近 mesh 时,提示参考其位置放 Empty。
    const hint = approx
      ? `参考 '${approx.name}' 的位置,${TIP.addMuzzle}`
      : TIP.addMuzzle;
    tip(hint);
    result.fixes.push(hint);
  } else {
    const mn = nodes[mIdx];
    const isEmpty = mn.mesh === undefined;
    if (!isEmpty) {
      result.degraded.push('Muzzle 是 mesh(建议改 Empty,不影响位置取值)');
      console.log(`    Muzzle : ${WARN} 找到但是 mesh(建议改 Empty)`);
    } else if (bIdx >= 0 && !isDescendant(nodes, mIdx, bIdx)) {
      strictOk = false;
      result.fatal.push('Muzzle 不在 Barrel 子树 → 层级不符');
      console.log(`    Muzzle : ${WARN} 找到但不在 Barrel 子树(层级不符)`);
      const t = TIP.reparent('Muzzle', 'Barrel');
      tip(t);
      result.fixes.push(t);
    } else {
      console.log(`    Muzzle : ${PASS} Empty #${mIdx}`);
    }
  }
  console.log(`    ${c.bold('直接套用结论')}: ${strictOk ? PASS + ' 命名/层级通过' : FAIL + ' 失败(命名或层级不符)'}`);

  // —— [B] 动画驱动有效性(改名后预判:用中文节点或已找到的英文节点) ——
  console.log(c.bold(`\n[B] 动画驱动有效性${c.dim('(改名后预判:用中文/已找到的炮塔节点')})`));
  // 骨骼
  const skins = gltf.skins?.length ?? 0;
  const skinnedNodes = nodes.filter((n) => n.skin !== undefined).length;
  if (skins > 0 || skinnedNodes > 0) {
    result.fatal.push(`含骨骼(skins:${skins}, skin节点:${skinnedNodes}) → rotation 无法驱动网格`);
    console.log(`    骨骼   : ${FAIL} 有 skins:${skins} skinNodes:${skinnedNodes} ${c.dim('→ rotation 无效,炮塔转不动')}`);
  } else {
    console.log(`    骨骼   : ${PASS} 无 ${c.dim('→ rotation 驱动有效')}`);
  }
  // 动画
  const anims = gltf.animations?.length ?? 0;
  if (anims > 0) {
    result.degraded.push(`含 ${anims} 个动画(GltfTankAsset 不播放,静态)`);
    console.log(`    动画   : ${WARN} 有 ${anims} 个(GltfTankAsset 不播放)`);
  } else {
    console.log(`    动画   : ${PASS} 无`);
  }

  // pivot 检测:优先用严格英文,否则用别名近似节点(中文等)
  const { wt, hasComplex } = worldTranslations(gltf);
  const turretNodeIdx = tIdx >= 0 ? tIdx : findSemanticApprox(nodes, 'Turret')?.idx ?? -1;
  const barrelNodeIdx = bIdx >= 0 ? bIdx : findSemanticApprox(nodes, 'Barrel')?.idx ?? -1;

  // Turret pivot
  if (turretNodeIdx >= 0) {
    const o = wt[turretNodeIdx];
    const bb = subtreeBBox(gltf, turretNodeIdx, wt);
    const nodeName = nodes[turretNodeIdx].name;
    if (bb) {
      const d = distPointBBox(o, bb);
      const size = bboxSize(bb);
      const detail = `${c.dim('origin=')}[${o.x.toFixed(2)},${o.y.toFixed(2)},${o.z.toFixed(2)}] ${c.dim('距包围盒')}${d.toFixed(2)}m`;
      if (d > PIVOT_FAIL) {
        result.fatal.push(`Turret(${nodeName}) pivot 错位:origin 距几何 ${d.toFixed(2)}m(在几何外) → 旋转画弧甩飞`);
        console.log(`    Turret pivot : ${FAIL} ${detail}\n${' '.repeat(22)}${c.dim('几何 Y[' + bb.min.y.toFixed(2) + '~' + bb.max.y.toFixed(2) + '] → 旋转中心应在此范围(座圈)')}`);
      } else if (o.y > bb.min.y + size.y * 0.5) {
        result.degraded.push('Turret pivot 偏上(建议设在座圈=几何底部)');
        console.log(`    Turret pivot : ${WARN} ${detail} ${c.dim('(origin 偏上,建议下移到座圈)')}`);
      } else {
        console.log(`    Turret pivot : ${PASS} ${detail} ${c.dim('(在座圈附近)')}`);
      }
    }
  } else {
    console.log(`    Turret pivot : ${c.dim('— 无炮塔节点可预判')}`);
  }
  // Barrel pivot
  if (barrelNodeIdx >= 0) {
    const o = wt[barrelNodeIdx];
    const bb = subtreeBBox(gltf, barrelNodeIdx, wt);
    const nodeName = nodes[barrelNodeIdx].name;
    if (bb) {
      const d = distPointBBox(o, bb);
      const size = bboxSize(bb);
      const detail = `${c.dim('origin=')}[${o.x.toFixed(2)},${o.y.toFixed(2)},${o.z.toFixed(2)}] ${c.dim('距包围盒')}${d.toFixed(2)}m`;
      if (d > PIVOT_FAIL) {
        result.fatal.push(`Barrel(${nodeName}) pivot 错位:origin 距几何 ${d.toFixed(2)}m → 俯仰窜动`);
        console.log(`    Barrel pivot : ${FAIL} ${detail}\n${' '.repeat(22)}${c.dim('→ 俯仰会大幅窜动,应在炮管根部铰链')}`);
      } else {
        // 检查是否在长轴端点(根部)
        const longAxis = size.x >= size.y && size.x >= size.z ? 'x' : size.z >= size.y ? 'z' : 'y';
        const atEnd = Math.min(Math.abs(o[longAxis] - bb.min[longAxis]), Math.abs(o[longAxis] - bb.max[longAxis])) < 0.3;
        if (!atEnd) {
          result.degraded.push('Barrel pivot 在炮管中部(建议设在根部端点)');
          console.log(`    Barrel pivot : ${WARN} ${detail} ${c.dim('(在炮管中部,俯仰画小弧)')}`);
          result.fixes.push(TIP.barrelPivot);
        } else {
          console.log(`    Barrel pivot : ${PASS} ${detail} ${c.dim('(在根部铰链)')}`);
        }
      }
    }
  } else {
    console.log(`    Barrel pivot : ${c.dim('— 无炮管节点可预判')}`);
  }
  if (hasComplex) {
    result.degraded.push('节点含非单位 rotation/scale(pivot 精度为近似,建议人工复核)');
    console.log(`    ${c.dim('注: 检测到非单位 rotation/scale,pivot 判定为近似')}`);
  }

  // —— [C] 单位尺寸 ——
  console.log(c.bold(`\n[C] 单位/尺寸`));
  const full = subtreeBBox(gltf, nodes.findIndex((_, i) => !nodes.some((o) => (o.children || []).includes(i))), wt);
  if (full) {
    const s = bboxSize(full);
    const maxDim = Math.max(s.x, s.y, s.z);
    const isMetric = maxDim < 20;
    console.log(`    包围盒 ${s.x.toFixed(2)}×${s.y.toFixed(2)}×${s.z.toFixed(2)} m ${isMetric ? PASS + ' 米级' : WARN + ' 疑似非米制(归一化会缩放)'}`);
    if (!isMetric) result.degraded.push('包围盒非米级量级(归一化会修正,但建议导出时设米制)');
    // 对照玩家 T14 物理体(仅 t14 类对照)
    console.log(c.dim(`    对照 T14 物理体 ${REF_SIZE.x}×${REF_SIZE.y}×${REF_SIZE.z} (GltfTankAsset 按 Z 归一化对齐)`));
  }

  // —— [D] 材质 ——
  console.log(c.bold(`\n[D] 材质(scorch 焦黑生效要求)`));
  const mats = gltf.materials || [];
  const pbrCount = mats.filter((m) => m.pbrMetallicRoughness !== undefined).length;
  if (pbrCount === mats.length && mats.length > 0) {
    console.log(`    ${PASS} ${mats.length} 个 PBR 材质 ${c.dim('→ 焦黑/受击生效')}`);
  } else {
    result.degraded.push(`仅 ${pbrCount}/${mats.length} 材质含 PBR(焦黑可能不完整)`);
    console.log(`    ${WARN} ${pbrCount}/${mats.length} 含 PBR`);
  }

  // —— [E] 降级项 ——
  console.log(c.bold(`\n[E] 降级项${c.dim('(不致命但丢效果)')}`));
  // 履带独立UV:glb 烘焙死的无法滚动(GltfTank.updateTracks 空转)
  console.log(`    履带滚动 : ${WARN} glb 履带为烘焙贴图 ${c.dim('→ 履带滚动将失效(GltfTank 已空转处理)')}`);
  result.degraded.push('履带滚动失效(glb 烘焙贴图,GltfTank.updateTracks 已空转)');
  // Hull 节点(车身摇晃)
  const hasHull = nodes.some((n) => n.name === 'Hull' || n.name === '车身');
  if (hasHull) {
    console.log(`    车身摇晃 : ${PASS} 有 Hull/车身 节点 ${c.dim('(可作 hullSway pivot)')}`);
  } else {
    console.log(`    车身摇晃 : ${WARN} 无 Hull 节点 ${c.dim('→ 车身摇晃将失效')}`);
    result.degraded.push('车身摇晃失效(无 Hull 节点)');
  }

  result.pass = strictOk && result.fatal.length === 0;
  return result;
}

/** b 是否为 a 的后代(含间接) */
function isDescendant(nodes: Gltf['nodes'], b: number, a: number): boolean {
  const n = nodes![a];
  for (const c of n.children || []) {
    if (c === b) return true;
    if (isDescendant(nodes, b, c)) return true;
  }
  return false;
}

/**
 * 查找语义节点的近似命名(给改名提示用)。
 * ------------------------------------------------------------
 * 按 SEMANTIC_ALIASES 顺序匹配:先精确名(大小写敏感),再包含匹配(大小写不敏感)。
 * 用途:严格英文名未找到时,检测是否有中文/变体名,提示美术"把 X 改成 Y"。
 * 返回首个匹配 {idx, name};无匹配返回 null。
 */
function findSemanticApprox(
  nodes: Gltf['nodes'],
  semantic: 'Turret' | 'Barrel' | 'Muzzle',
): { idx: number; name: string } | null {
  if (!nodes) return null;
  const aliases = SEMANTIC_ALIASES[semantic];
  // 先精确匹配(大小写敏感)
  for (const alias of aliases) {
    const idx = nodes.findIndex((n) => n.name === alias);
    if (idx >= 0) return { idx, name: alias };
  }
  // 再包含匹配(大小写不敏感;跳过已是严格名的节点,避免误报)
  for (let i = 0; i < nodes.length; i++) {
    const name = nodes[i].name ?? '';
    if (!name || name === semantic) continue;
    const lower = name.toLowerCase();
    for (const alias of aliases) {
      if (alias.length >= 2 && lower.includes(alias.toLowerCase())) return { idx: i, name };
    }
  }
  return null;
}

// ============================================================
// main
// ============================================================

function main(): void {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : fs.readdirSync('public/assets').filter((f) => f.endsWith('.glb')).map((f) => `public/assets/${f}`);
  if (files.length === 0) {
    console.log(c.yellow('未找到 glb 文件(默认扫 public/assets/*.glb,或传参指定)'));
    return;
  }
  console.log(c.bold(`检测 ${files.length} 个 glb 文件:`));

  const allFatal: Record<string, string[]> = {};
  const allDegraded: Record<string, string[]> = {};
  const allFixes: Record<string, string[]> = {};
  for (const f of files) {
    try {
      const r = check(f, parseGlb(f));
      allFatal[f] = r.fatal;
      allDegraded[f] = r.degraded;
      allFixes[f] = r.fixes;
    } catch (e) {
      console.log(c.red(`\n═══ ${f} ═══\n  解析失败: ${(e as Error).message}`));
      allFatal[f] = ['glb 解析失败'];
      allFixes[f] = [];
    }
  }

  // —— 总结 ——
  console.log(c.bold(`\n═════════════ 总结 ═════════════`));
  for (const f of files) {
    const fatal = allFatal[f] || [];
    const deg = allDegraded[f] || [];
    const fixes = [...new Set(allFixes[f] || [])]; // 去重(同一提示可能多次收集)
    const ok = fatal.length === 0;
    console.log(`\n${path.basename(f)}: ${ok ? c.green('✓ 可直接套用') : c.red('✗ 不能直接套用')}`);
    if (fatal.length > 0) {
      console.log(c.red(`  致命问题(导致动作失效):`));
      fatal.forEach((x) => console.log(c.red(`    • ${x}`)));
    }
    if (fixes.length > 0) {
      console.log(c.cyan(`  📝 美术修改清单(Blender):`));
      fixes.forEach((x, i) => console.log(c.cyan(`    ${i + 1}. ${x}`)));
    }
    if (deg.length > 0) {
      console.log(c.yellow(`  降级(能跑但丢效果):`));
      deg.forEach((x) => console.log(c.yellow(`    • ${x}`)));
    }
    if (ok && deg.length === 0) console.log(c.green('  所有动作正常,无降级'));
  }
}

main();
