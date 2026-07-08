# 自定义坦克设计文档(部件组合式模型)

> 范围:坦克数据模型从"固定字段 schema"统一为"部件列表组合式";用户可用基础形状(立方体/圆柱体)自定义坦克,立方体支持每角独立圆弧。
> 决策(已确认):① 现有 T14/虎式/M1 统一转为部件列表;② 部位类型模板预填 + 可改;③ 立方体 8 角各自控制圆弧;④ 仅编辑器(游戏集成后续)。
> 基线:当前编辑器(数据驱动 + Builder + 装配约束 Phase 1-4)。

---

## 0. 核心架构转变

```
旧:T14Schema/TigerSchema/AbramsSchema(固定字段,每车型一套)
    ↓ 统一
新:TankModel { parts: TankPart[] }(部件列表,所有车型共用一套)
```

现有 3 种坦克用**转换器**生成等价的 TankModel(保留外观)。用户自定义直接编辑 TankModel。

---

## 1. 数据模型

### 1.1 部件(TankPart)

```ts
type PartType = 'hull' | 'turret' | 'barrel' | 'track' | 'wheel' | 'decorative';
type PartShape = 'box' | 'cylinder' | 'wedge';  // wedge 保留(现有车体/炮塔用)

interface TankPart {
  id: string;                  // 唯一标识('p1'/'p2')
  name: string;                // 显示名("主炮塔"/"左履带")
  partType: PartType;          // 部位类型(决定击中区域,战斗集成用)
  shape: PartShape;
  // —— box 专属 ——
  half?: { x: number; y: number; z: number };
  /** 8 个角各自的圆弧半径(0=直角)。顺序:底面4角(z-,x-/+; z+,x-/)+ 顶面4角。仅 box。 */
  cornerRadii?: number[];      // 长度 8,缺省全 0(直角立方体)
  // —— cylinder 专属 ——
  radius?: number;
  height?: number;
  // —— wedge 专属(现有车体/炮塔的楔形)——
  wedge?: { bottomHalfX: number; topHalfX: number; bottomHalfZ: number; topHalfZ: number; height: number; centerY: number };
  // —— 通用 ——
  position: { x: number; y: number; z: number };
  rotation?: { x: number; y: number; z: number };
  color: number;
  /** 装配约束标记(供 AssemblyEngine:此部件贴哪个命名面)。可选,无则自由。 */
  mateTo?: string;             // 如 'hull.top'
}
```

### 1.2 坦克模型(TankModel)

```ts
interface TankModel {
  id: string;                  // 't14' / 'tiger' / 'abrams' / 'custom-1'
  name: string;                // 显示名
  parts: TankPart[];           // 部件列表(核心)
  // 非视觉参数(从现有 CONFIG 提取)
  mass: number;
  maxHp: number;
  damage?: { smokeThreshold: number; destroyExplosionScale: number; destroySmokeScale: number };
}
```

### 1.3 部位类型语义(战斗集成预留,本期仅标记)

| partType | 击中效果(未来游戏集成) |
|----------|--------------------------|
| `hull` | 方向装甲(前/侧/背) |
| `turret` | 炮塔 debuff(转速降) |
| `track` | 履带 debuff(机动降) |
| `barrel` | 无 debuff(被击但不触发部位) |
| `wheel` | 无 debuff(负重轮,装饰) |
| `decorative` | 无 debuff(天线/储物篮等) |

本期编辑器只做**标记**(partType 字段),游戏集成(部位 sensor 生成 + debuff 分发)后续。

---

## 2. 现有坦克转换(等价迁移)

### 2.1 转换器

新建 `src/data/convertLegacy.ts`:从 T14Visual/TigerVisual/AbramsVisual + CONFIG 生成 TankModel。

```ts
export function convertT14ToModel(v: T14Visual, cfg: typeof CONFIG.tank): TankModel {
  return {
    id: 't14', name: 'T-14 Armata',
    parts: [
      part('hull', 'wedge', { wedge: v.hull, position: {x:0,y:0,z:0}, color: v.colors.hull }),
      part('track-left', 'box', { half: {x:v.track.halfX, y:v.track.halfY, z:v.track.halfZ}, position: {x:-v.track.offsetX, y:v.track.centerY, z:0}, color: v.colors.trackMetal, partType:'track' }),
      part('track-right', 'box', { ...同上 x:+offsetX }),
      part('turret', 'wedge', { wedge: armataToWedge(v.turret.armata), position: v.turret.offset, color: v.colors.turret, partType:'turret' }),
      part('barrel', 'cylinder', { radius: 0.11, height: v.barrel.length, position: v.barrel.offset, color: v.colors.barrel, partType:'barrel' }),
      // afghanit/antenna/sightCmdr/sightGunner/rcws/engineGrille/driverHatch ... 逐一转换
    ],
    mass: cfg.mass, maxHp: cfg.damage.maxHp, damage: {...},
  };
}
// 虎式/M1 同理(convertTiger/convertAbrams)
```

### 2.2 形状映射

| 现有部件 | 转换后 shape | 说明 |
|----------|--------------|------|
| hull(楔形车体) | `wedge` | 保留楔形(上窄下宽) |
| track(履带直段) | `box` | 立方体 |
| roadWheel(负重轮) | `cylinder` | 圆柱(侧放) |
| armata/body(炮塔主体) | `wedge` | 楔形 |
| barrel(炮管) | `cylinder` | 圆柱 |
| afghanit/antenna/sightCmdr 等 | `box`/`cylinder` | 按形状 |
| frontSlope(斜板) | `wedge` 或专用 | 楔形近似 |

### 2.3 验证(零回归)

转换后,Builder 用 TankModel 构建的模型应与现有 `buildT14`/`buildTiger`/`buildAbrams` 视觉一致。验证:转换 → buildCustom → 对比渲染。

---

## 3. 几何工厂

### 3.1 每角独立圆弧立方体 + 边过渡(完整版,本期最大技术难点)

`makeRoundedBoxGeometry(half: {x,y,z}, radii: number[8], edgeSegments = 8): BufferGeometry`

**需求(已确认)**:8 角各自 radius(0=直角),相邻角 radius 不同时边**平滑过渡**(不突变)。完整版,非简化版。

**几何结构**:立方体 = 8 角 + 12 边 + 6 面

**顶点生成算法**:

1. **角顶点(8 组)**:每角位置 `(±hx, ±hy, ±hz)`,radius `r = radii[i]`
   - `r > 0`:该角三轴方向各退 r,生成圆角细分顶点(1/8 球面,按 segments 细分)
   - `r = 0`:保持直角(单顶点,不细分)

2. **边顶点(12 条)**:每边连接两角(radius `r1`、`r2`)
   - 沿边方向,从 r1 端到 r2 端,radius **线性渐变**(r1 → r2)
   - 边中部生成过渡顶点:垂直边方向的偏移 = 该位置插值后的 radius
   - 细分段数 = `edgeSegments`(默认 8,越大边过渡越平滑)
   - 这是"边过渡控制"的核心:相邻角 radius 不同时,边轮廓平滑过渡而非突变

3. **面顶点(6 面)**:每面四角的 radius 之外的区域为平面;边过渡区域已由边顶点覆盖

4. **三角索引**:连接 角/边/面 顶点成三角形(`computeVertexNormals` 算法线)

**参数**:
- `radii[8]`:8 角 radius(顺序:底面 4 角逆时针 + 顶面 4 角逆时针)
- `edgeSegments`:边细分段数(默认 8;用户可在编辑器调,控制过渡平滑度)

**复杂度评估**:约 300-400 行 BufferGeometry 代码。是本期最大技术难点,需仔细调试顶点/索引。

**未来扩展(本期不做)**:若需独立的 12 边 radius 控制(每边各自圆角,独立于角),可加 `edgeRadii[12]` 参数。本期边 radius 由两端角 radius 插值决定(标准完整版行为)。

### 3.2 其他形状

| 形状 | 实现 |
|------|------|
| `box`(无圆弧,radii 全 0) | `BoxGeometry`(three.js 内置) |
| `box`(有圆弧) | `makeRoundedBoxGeometry` |
| `cylinder` | `CylinderGeometry`(three.js 内置,侧放需 rotation) |
| `wedge` | `makeWedgeGeometry`(现有,保留) |

### 3.3 Builder 扩展

`TankVisualBuilder.buildCustom(model: TankModel): BuiltVisuals`
- 遍历 parts,按 shape 调对应几何工厂
- 每个 part → Mesh,加到 group
- 给 part.group 标记 userData(partId/partType,供点选)
- 返回 BuiltVisuals(group + partMap)

---

## 4. 编辑器改造

### 4.1 新布局(在现三栏基础上调整)

```
左侧:部件列表(增/删/选/拖拽排序)
中间:3D 视口(点选部件高亮)
右侧:选中部件的属性编辑(形状/尺寸/位置/部位类型/颜色/圆弧)
```

### 4.2 部件列表面板(左侧,替代/补充参数树)

- 列出 TankModel.parts(每项:名 + 部位类型图标)
- 点击选中(高亮 + 右侧显示属性)
- "+ 添加部件"按钮(选 box/cylinder,默认 decorative)
- "删除"按钮
- 拖拽排序(可选)

### 4.3 部件属性编辑(右侧)

选中部件后显示:
- **基础**:名称(文本)/ 部位类型(下拉 hull/turret/...)/ 形状(box/cylinder/wedge)
- **尺寸**:box(halfX/Y/Z + 8 角圆弧)/ cylinder(radius/height)/ wedge(...)
- **位置**:x/y/z 滑块
- **颜色**:拾色器

### 4.4 圆弧编辑器(box 专属,8 角)

8 角独立控制 UI:
```
       顶面                底面
   ┌─┐       ┌─┐      ┌─┐       ┌─┐
   │5│       │6│      │1│       │2│     ← 角编号(示意)
   └─┘       └─┘      └─┘       └─┘
       \     /            \     /
   ┌─┐       ┌─┐      ┌─┐       ┌─┐
   │7│       │8│      │3│       │4│
   └─┘       └─┘      └─┘       └─┘
   
   每角一个滑块(0=直角 ~ max=角到对面距离/2)
   或:点选角 + 滑块调当前角
```

实现:小立方体 SVG/Canvas 示意,8 个角可点选;选中角后滑块调 radius。或直接 8 个滑块(简单粗暴)。

### 4.5 新建坦克流程

- "新建"按钮 → 选模板(空白 / 复制现有 T14/虎式/M1)
- 空白模板:5 部件默认(车体 box + 炮塔 box + 炮管 cylinder + 左右履带 box),部位预填
- 复制现有:转换器生成 TankModel,用户在其上改

---

## 5. 数据存储与加载

- `public/tanks/t14.json` / `tiger.json` / `abrams.json`:现有,转换为 TankModel 格式(转换器在加载时跑,或预转换存储)
- `public/tanks/custom-*.json`:用户自定义
- `TankSchema` 扩展:`TankModelSchema`(zod 校验部件列表)
- 编辑器后台:GET/PUT `/api/tanks/:id`(支持 custom-*)

**存储策略选择**:
- A. 预转换:构建时把现有 .ts → TankModel JSON 存盘(一次性,加载快)
- B. 运行时转换:加载时跑转换器(灵活,代码驱动)
- 建议 B(转换器在代码里,现有 .ts 改了自动反映)

---

## 6. 分阶段实施

| Phase | 内容 | 验证 |
|-------|------|------|
| **A 数据模型** | TankPart/TankModel 类型 + zod schema + 转换器(convertT14/Tiger/Abrams) | 转换后 TankModel 结构正确 |
| **B 几何** | makeRoundedBoxGeometry(8 角 + 边过渡完整版)+ buildCustom | 圆角立方体 + 边过渡视觉正确(本期最大难点) |
| **C 渲染切换** | Builder.buildCustom + 编辑器/游戏改用 TankModel | 现有坦克视觉零回归(转换等价) |
| **D 编辑器** | 部件列表面板 + 部件属性编辑 + 圆弧编辑器 | 增删改部件、调圆弧 |
| **E 新建流程** | 新建按钮 + 默认模板 + 复制现有 | 新建自定义坦克 |
| (后续)游戏集成 | 部位 sensor 生成 + 击中区域 + CustomTank 实体 | 自定义坦克进游戏 |

---

## 7. 影响范围(现有代码改动)

| 模块 | 改动 |
|------|------|
| `TankSchema.ts` | 加 TankPart/TankModel schema(zod) |
| `convertLegacy.ts` | **新建**:现有 → TankModel 转换器 |
| `TankGeometryFactories.ts` | 加 makeRoundedBoxGeometry |
| `TankVisualBuilder.ts` | 加 buildCustom;现有 buildT14/Tiger/Abrams 可改为调 buildCustom(经转换) |
| `TankDataStore.ts` | 加载 TankModel(转换或直读) |
| `editor.ts` / `PropPanel.ts` / `ParamTree.ts` | 部件列表 UI + 部件编辑 + 圆弧编辑(大改) |
| `assemblyRules.ts` / `geometryFaces.ts` | 适配部件列表(部位用 partId 引用) |
| 游戏 T14Tank/StaticTankBase | 可暂不动(用现有 buildT14 等);C 阶段切换 |

**关键**:Phase A-C 是"等价迁移"(现有坦克转为部件列表,视觉不变),风险可控。Phase D-E 是"新能力"(自定义),在等价迁移完成后叠加。

---

## 8. 已确认决策

1. **圆弧**:完整版(8 角独立 radius + 边平滑过渡,edgeSegments 控制过渡平滑度)。见 §3.1。本期最大技术难点。
2. **wedge 暴露**:用户形状选择器含 `box` / `cylinder` / `wedge` 三种。
3. **装配约束适配**:改为按 partId 引用(`partA.mateTo = partB 的命名面`)。
4. **现有 .ts 保留**:作转换源 + TankDataStore 兜底(不删)。
