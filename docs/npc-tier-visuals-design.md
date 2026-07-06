# NPC 难度外观区分 · 详细设计文档

> 范围：让玩家从外观一眼区分 NPC 难度档位（rookie/regular/veteran）。
> 方案：A 配色分档（远距离主区分）+ B 军衔标识贴花（近战辅助）。
> veteran 主配色：黑灰系（肃杀精锐感）。
> 引导：开始界面图例。
> 基线：当前 main 分支（含战斗层 M0-M3）。

---

## 0. 设计目标

玩家在交火距离（fireRange 50-65m）能**一眼识别**敌方难度：
- 远距离靠**配色**（黑色剪影 = 精英，要小心）
- 近距离靠**标识**（军衔贴花确认）
- 不破坏现有写实军事风（程序迷彩、战术编号、PBR 材质）

---

## 1. 架构改造：tier 传递链路（所有方案的前置）

### 1.1 现状问题
`tier` 只存在于 AI 层（`DirectorSystem` → `NpcController.profile`），坦克实体（`TankBase.buildVisuals`）**完全不知道**自己的 tier，无法据此生成差异化外观。

### 1.2 改造链路

```
CONFIG.tanks[i].tier          (配置层,初始 NPC 声明 tier)
DirectorSystem spawnEnemy     (动态 NPC 决定 tierKey)
        │
        ▼
createTank(variant, ..., tier?)   ← registry.ts 工厂加可选 tier 参数
        │
        ▼
TankBase 构造: this.tier = tier   ← 实体持有 tier(protected readonly)
        │
        ▼
StaticTankBase.buildVisuals:      ← 据 this.tier 选配色 + 贴标识
  - camo = resolveTierCamo(variant, tier)
  - 若 tier 有 rank → makeRankDecalCanvas 贴炮塔后部
```

### 1.3 改动点

| 文件 | 改动 |
|------|------|
| `entities/tanks/registry.ts` | `createTank` 加 `tier?: NpcTier` 末位参数，透传给具体坦克构造 |
| `entities/IControllableTank.ts` | 加 `readonly tier?: NpcTier`（可选，NPC 有，玩家/中立无） |
| `entities/tanks/TankBase.ts` | 构造加 `tier?` 入参，存 `this.tier` |
| `entities/tanks/StaticTankBase.ts` | 构造透传 tier 给 super；`buildVisuals` 据 tier resolve 配色 + 贴标识 |
| `entities/tanks/TigerTank.ts` / `AbramsTank.ts` | 构造透传 tier（super 调用加 tier） |
| `main.ts` `buildTanks` | `createTank(..., (cfg as {tier?:string}).tier)` —— 初始 NPC 从配置读 tier |
| `systems/DirectorSystem.ts` `spawnEnemy` | `createTank(..., tierKey)` —— 动态 NPC 传 tier |

**零回归保证**：玩家 T-14 和中立静态坦克不传 tier（undefined）→ `buildVisuals` 走原配色分支，外观与现在完全一致。

---

## 2. 配色方案（A 主区分）

### 2.1 设计取向

```
rookie（新兵）   原配色不动                        → "量产动员兵"感
regular（老兵）  原配色整体 darken ×0.72 + 磨损加重 → "经历战阵"的暗沉感
veteran（精英）  黑灰系覆盖（绝对值）+ 高磨损        → "精锐特种"肃杀感,远距离黑色剪影醒目
```

关键：rookie/regular **基于原配色派生**（tiger 灰绿、abrams 沙黄各自加深），veteran **统一黑灰覆盖**（两种车型都变黑，强化"精英=黑色"的玩家心智）。

### 2.2 CONFIG 结构

`config.ts` 新增（combat 块内）：

```ts
/**
 * NPC 难度外观映射(M3+ 外观区分)。
 * ------------------------------------------------------------
 * 配色 + 标识按 tier 分档,让玩家一眼识别敌方难度。
 *  - rookie:  原配色不动(量产感)
 *  - regular: 原色 darken + 磨损加重(暗沉老兵感)
 *  - veteran: 黑灰系覆盖 + 高磨损 + 骷髅标识(肃杀精锐感,远距离黑色剪影醒目)
 * darken/wearBoost 基于"原配色"派生;camoOverride 用绝对值覆盖(黑灰系)。
 */
tierVisuals: {
  rookie: {
    /** 无修饰,用原配色 */
  },
  regular: {
    /** 原色整体变暗系数(×0.72),模拟老旧/战损车 */
    darken: 0.72,
    /** 磨损叠加(原 wear + 0.15,clamp 1),加重做旧 */
    wearBoost: 0.15,
    /** 军衔标识:双道 V 杠(士官) */
    rank: 'chevron' as const,
    rankColor: 0xd8a23a,
  },
  veteran: {
    /** 黑灰系绝对覆盖(tiger/abrams 统一变黑,强化"精英=黑色"心智) */
    camoOverride: {
      base: 0x2a2a2a,      // 深灰主色
      blobDark: 0x141414,  // 近黑斑块
      blobMid: 0x4a4a4a,   // 中灰斑块
      wear: 0.7,           // 高磨损(肃杀)
    },
    /** 军衔标识:骷髅(特种精锐) */
    rank: 'skull' as const,
    rankColor: 0xc0392b,   // 暗红(危险信号)
  },
},
```

### 2.3 配色 resolve 逻辑（`StaticTankBase.buildVisuals` 内）

```ts
const baseCamo = cfg.colors.camo;  // 原配色(tiger 灰绿 / abrams 沙黄)
const tierCfg = this.tier ? CONFIG.combat.tierVisuals[this.tier] : null;

let camoParams = { ...baseCamo };
if (tierCfg) {
  if ('darken' in tierCfg && tierCfg.darken) {
    camoParams.base = darken(baseCamo.base, tierCfg.darken);
    camoParams.blobDark = darken(baseCamo.blobDark, tierCfg.darken);
    camoParams.blobMid = darken(baseCamo.blobMid, tierCfg.darken);
  }
  if ('wearBoost' in tierCfg && tierCfg.wearBoost) {
    camoParams.wear = Math.min(1, (baseCamo.wear ?? 0.25) + tierCfg.wearBoost);
  }
  if ('camoOverride' in tierCfg && tierCfg.camoOverride) {
    camoParams = { ...camoParams, ...tierCfg.camoOverride };
  }
}
const camoCanvas = makeCamouflageCanvas(camoParams, { seed: this.id });
```

`darken` 复用 `TankGeometryFactories` 现有工具（需 export 它，目前是模块私有）。

### 2.4 预期视觉效果

| tier | tiger（原灰绿 0x6b6a55） | abrams（原沙黄 0xb5a06a） |
|------|------------------------|--------------------------|
| rookie | 灰绿 nato 斑块（不变） | 沙黄 nato 斑块（不变） |
| regular | 深灰绿（×0.72）+ 重磨损 | 深沙褐（×0.72）+ 重磨损 |
| veteran | **黑色**（0x2a2a2a 覆盖）| **黑色**（0x2a2a2a 覆盖）|

veteran 两种车型都呈黑色剪影 → 远距离一眼可辨"这是精英"。

---

## 3. 军衔标识贴花（B 辅区分）

### 3.1 标识图案

| tier | 图案 | 含义 | 颜色 |
|------|------|------|------|
| rookie | 无 | 新兵无标识 | — |
| regular | **双道 V 杠**（chevron）| 士官军衔 | 橙金 0xd8a23a |
| veteran | **骷髅**（skull）| 特种精锐/死神头 | 暗红 0xc0392b |

> 备选：veteran 若嫌骷髅难画/出戏，可改「三星」（three-star，简单三个圆点/星）。骷髅更配黑灰肃杀风，是默认推荐。

### 3.2 新增工厂 `makeRankDecalCanvas`

`TankGeometryFactories.ts` 加（与 `makeNumberDecalCanvas`/`makeCrossDecalCanvas` 同级）：

```ts
/**
 * 军衔标识贴花(M3+ 难度区分)。
 * ------------------------------------------------------------
 *  - chevron: 双道 V 形杠(士官),regular 用
 *  - skull:   简化骷髅(圆头+双眼洞+牙齿线),veteran 用
 * 圆形深底 + 彩色图案,贴炮塔后部两侧。alphaTest 抠圆外。
 */
export function makeRankDecalCanvas(
  rank: 'chevron' | 'skull',
  color: number,
  size = 128,
): HTMLCanvasElement { /* canvas 绘制 */ }
```

绘制要点：
- **chevron**：圆底 + 两道开口向上的 V 形粗线（橙金），简洁军衔感
- **skull**：圆底 + 上半圆头形（暗红填充）+ 两个椭圆眼洞（透明）+ 下方短横牙齿线

### 3.3 贴花位置（`StaticTankBase.buildVisuals` 的 `addDecals` 内）

现有 decals：编号贴炮塔两侧（z=-0.2），十字贴炮塔两侧（z=0.4）。
rank 贴花放**炮塔后部两侧**（z=-0.7 附近），避开编号/十字，且后方视角可见（玩家追击时看到标识知难度）。

```ts
// 在 addDecals 内,编号/十字之后追加:
const tierCfg = this.tier ? CONFIG.combat.tierVisuals[this.tier] : null;
if (tierCfg && 'rank' in tierCfg && tierCfg.rank) {
  const rankTex = new CanvasTexture(makeRankDecalCanvas(tierCfg.rank, tierCfg.rankColor));
  const rankMat = new MeshStandardMaterial({ map: rankTex, transparent: true, alphaTest: 0.5, depthWrite: false });
  const rankGeo = new PlaneGeometry(0.4, 0.4);
  for (const side of [-1, 1]) {
    const decal = new Mesh(rankGeo, rankMat);
    decal.position.set(side * (tb.bottomHalfX + 0.02), tb.centerY + 0.05, -0.7);  // 炮塔后部
    decal.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
    turret.add(decal);
  }
}
```

---

## 4. 开始界面图例（引导）

### 4.1 问题
玩家第一次见黑色坦克可能以为是 bug。需一次性告知"配色/标识 = 难度"。

### 4.2 图例设计（Overlay 开始界面）

在开始界面关卡卡片下方加一行**难度图例条**：

```
[灰绿方块] 新兵   [深色方块] 老兵   [黑色方块●] 精英(危险)
```

实现：Overlay 渲染 3 个色块（对应 rookie/regular/veteran 主色）+ 标签。色块用 CSS background（#6b6a55 / darken后 / #2a2a2a），无需 canvas。

veteran 色块加红色边框 + "危险"标注，强化"看到就怕"。

### 4.3 改动点

| 文件 | 改动 |
|------|------|
| `ui/Overlay.ts` | 开始界面 DOM 加图例条(3 色块 + 标签) |
| `config.ts` | (可选)导出 tierVisuals 主色供 Overlay 复用,避免硬编码两处 |

---

## 5. 改动文件清单

| 文件 | 改动类型 | 内容 |
|------|---------|------|
| `config.ts` | 新增 | `combat.tierVisuals`(rookie/regular/veteran 配色+标识) |
| `entities/TankGeometryFactories.ts` | 新增 | `makeRankDecalCanvas` 工厂 + export `darken` |
| `entities/IControllableTank.ts` | 新增 | `readonly tier?: NpcTier` 字段 |
| `entities/tanks/TankBase.ts` | 改 | 构造加 `tier?` 入参,存 `this.tier` |
| `entities/tanks/StaticTankBase.ts` | 改 | 构造透传 tier;`buildVisuals` 据 tier resolve 配色;`addDecals` 贴 rank |
| `entities/tanks/TigerTank.ts`/`AbramsTank.ts` | 改 | 构造透传 tier |
| `entities/tanks/registry.ts` | 改 | `createTank` 加 `tier?` 参数 |
| `main.ts` | 改 | `buildTanks` 传 `cfg.tier` |
| `systems/DirectorSystem.ts` | 改 | `spawnEnemy` 传 `tierKey` |
| `ui/Overlay.ts` | 改 | 开始界面加难度图例条 |

---

## 6. 验证点

1. **零回归**：玩家 T-14、中立静态坦克外观与改造前完全一致（无 tier）
2. **rookie**：原配色（tiger 灰绿/abrams 沙黄），无标识
3. **regular**：配色明显加深 + 重磨损，炮塔后部橙金双道杠
4. **veteran**：黑色剪影，炮塔后部暗红骷髅，远距离一眼可辨
5. **动态生成**：`spawnEnemy` 生成的 NPC 也能正确显示 tier 外观
6. **图例**：开始界面图例条显示，色块与游戏内一致
7. **同型号区分**：场上同时有 rookie tiger 和 veteran tiger，配色/标识清晰区分

---

## 7. 已知风险与对策

- **darken 工具私有**：`TankGeometryFactories` 的 `darken` 当前模块私有，需 export。一行改动。
- **骷髅图案识别度**：canvas 手绘骷髅简化版可能不够"骷髅"。对策：先用三星（简单可靠）做 fallback，骷髅作为视觉增强可选。
- **tier 与型号正交**：tiger 和 abrams 都可能出任一 tier。配色 override 后 veteran 两种都黑，可能丢失型号辨识（远看都是黑坦克）。**这其实是设计意图**（veteran 就是该醒目），近战仍可凭炮塔形状（虎式方盒 vs M1 楔形）辨型号。
- **标识远距离不可辨**：方案 A 配色已解决远距离识别，标识仅近战辅助，符合设计预期。
