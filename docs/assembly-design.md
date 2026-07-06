# 装配约束系统 · 设计文档(惰性邻接求解)

> 范围:编辑器内坦克模型的"组合设计"能力 —— 选定部件为主体,调整其尺寸/形状时,邻接部件按"维持紧贴"原则自动跟随。
> 核心:不是表达式参数化,而是基于**物理邻接**的**惰性约束求解**。
> 基线:当前编辑器(A/B/C/D 阶段完成,数据驱动 + Builder 唯一真相源)。

---

## 0. 核心思想(用户意图精确表述)

坦克是**装配体**:部件间通过面接触紧贴(炮塔坐在车体顶、履带贴车体两侧、炮管根部接炮塔前端)。编辑规则:

1. **惰性**:编辑某部件时,若**不破坏邻接**(其他部件仍和它紧贴)→ 其他部件**不动**。
2. **脱离触发**:若编辑导致**悬空/间隙**(部件间出现缝隙)→ 邻居**自动滑动/延展**,恢复紧贴。
3. **不穿透**:延展沿部件的**自由方向**(远离邻居)进行,不侵入其他部件。
4. **选中即主体**:用户点选某部件 → 它成为当前主体 → 编辑它的参数 → 系统维持它和邻居的紧贴。

**关键判例(用户给定)**:选中炮管拉长 → 炮管沿 +z(炮口方向)延展,**不往车身方向**延伸(不穿透)→ 因为炮管根部固定在炮塔,自由端是炮口。

---

## 1. 装配图(坦克的固定邻接结构)

坦克的物理结构决定了**固定的邻接关系**(不需要用户配置,是装配常识):

```
车体 hull —— 根主体(地面坐标系)
├── 炮塔 turret
│   约束:底面 ↔ 车体顶面(Y 贴合)
│   ├── 炮管 barrel
│   │   约束:根部 ↔ 炮塔前端(Z 贴合);延展轴 +z(自由端=炮口)
│   ├── 阿富汗石 afghanit(两侧发射管)
│   │   约束:贴炮塔两侧(X 贴合),分布在 Z 跨度
│   ├── 天线 antenna
│   │   约束:贴炮塔后部
│   └── 瞄准镜/遥控机枪 sight*/rcws
│       约束:贴炮塔顶面
├── 履带 track(左右各一)
│   约束:内侧 ↔ 车体两侧(X 贴合);长度 ↔ 车体长度(Z 对齐);底 ↔ 地面(Y 下限)
│   └── 负重轮 roadWheel
│       约束:Z 跨度在履带跨度内(包含)
├── 挡泥板 fender
│   约束:贴履带上方(Y 贴合)
└── 附件 stowage(格栅/舱盖)
    约束:贴车体特定位置
```

**关键**:这个装配图是**预设的**(坦克结构固定)。系统知道每个部件"应当"贴在谁身上、哪个面贴。用户编辑时,系统按这个图维持紧贴。

---

## 2. 约束类型(三种,覆盖所有邻接)

### 2.1 面贴合(Mate)
子的某面贴父的某面(位置跟随)。
```
炮塔底面 ↔ 车体顶面     → turret.offset.y = hull.centerY + hull.height
履带内侧 ↔ 车体外侧     → track.offsetX = hull.bottomHalfX
炮管根部 ↔ 炮塔前端     → barrel.offset.z = turret.armata.bottomHalfZ
```

### 2.2 范围包含(Contain)
子的范围限制在父的范围内(尺寸跟随,防溢出)。
```
负重轮跨度 ⊂ 履带跨度   → roadWheel.zSpan ≤ track.halfZ - track.halfY
炮塔 Z 位置 ⊂ 车体长度  → |turret.offset.z| ≤ hull.bottomHalfZ
```

### 2.3 边缘对齐(Align)
子的边缘对齐父的边缘(尺寸跟随,填满)。
```
履带长度 ↔ 车体长度     → track.halfZ = hull.bottomHalfZ
挡泥板长度 ↔ 履带长度   → fender.halfZ = track.halfZ
```

---

## 3. 求解规则(父变化 → 子如何调整)

穷举每个邻接的联动公式(实现时编码为规则表):

| 父字段变化 | 子字段 | 联动公式 | 约束类型 |
|-----------|--------|----------|----------|
| `hull.centerY` / `hull.height` | `turret.offset.y` | `centerY + height` | Mate(Y) |
| `hull.bottomHalfX` | `track.offsetX` | `= bottomHalfX` | Mate(X) |
| `hull.bottomHalfX` | `fender.offsetX` | `= bottomHalfX + track.halfX` | Mate(X,外侧) |
| `hull.bottomHalfZ` | `track.halfZ` | `= bottomHalfZ` | Align(Z) |
| `hull.bottomHalfZ` | `fender.halfZ` | `= bottomHalfZ` | Align(Z) |
| `track.halfZ` / `track.halfY` | `roadWheel.zSpan` | `halfZ - halfY` | Contain(Z) |
| `turret.armata.bottomHalfZ` | `barrel.offset.z` | `= armata.bottomHalfZ` | Mate(Z,前端) |
| `turret.offset.y` | `barrel.offset.y` | 相对炮塔保持 | Mate(Y) |
| `hull.centerY` / `hull.height` | `track.centerY` | 贴地面/相对车体底 | Mate(Y) |
| `track.halfZ` | `roadWheelStagger.zSpan`(虎式) | `= halfZ` | Align(Z) |

**说明**:公式的右侧引用父字段当前值。父变 → 重算右侧 → 子字段更新。

---

## 4. 惰性求解算法(核心)

"并非一改就变,而是脱离才变"的精确实现:

### 4.1 触发判定

用户改父字段 `P`(如 `hull.height` 从 1.05 → 1.2):

```
对每个依赖 P 的子字段 C(如 turret.offset.y):
  expected = formula(parentVals)        // 应有值 = centerY + height = -0.05 + 1.2 = 1.15
  current = getValue(C)                  // 当前值 = 0.48(老顶面 -0.05+1.05=1.0 附近,但用户可能调过)
  gap = |expected - current|             // 间隙
  if gap > TOLERANCE(如 0.05):          // 脱离:出现可见悬空
    setValue(C, expected)                // 自动调整,恢复紧贴
    recursively onFieldChanged(C, ...)  // 子的子(链式):履带→负重轮
  else:
    不动(用户可能故意创造小间隙,尊重)
```

### 4.2 容差(TOLERANCE)

`TOLERANCE = 0.05m`(可调)。小于此视为"仍紧贴"(用户微调),大于此视为"脱离"(需修复)。

意义:避免每次微小拖动都触发连锁(抖动)。只有明显的脱离才求解。

### 4.3 链式传播(递归)

改 `hull.bottomHalfZ` → `track.halfZ` 变 → 检查 `track.halfZ` 的依赖者(`roadWheel.zSpan`)→ 负重轮跨度也变。

实现:递归调用 `onFieldChanged`,但要**检测循环**(依赖图有环 → 报错,理论上装配图无环)。

### 4.4 拓扑序(防震荡)

多个约束可能相互影响。求解前对依赖图做**拓扑排序**,按序求值(父先于子),避免 A 改 B、B 改 A 的震荡。

装配图是 DAG(有向无环图,因为物理上炮塔在车体上、不会反过来),拓扑排序可行。构造时检测环,有环报错。

---

## 5. 生长方向(不穿透)

"拉长炮管不穿透车身"的实现:

### 5.1 每个部件定义延展属性

```ts
interface ExtensionAxis {
  /** 延展轴:拉长时沿此方向(自由端) */
  axis: 'x' | 'y' | 'z';
  /** 固定端:附着侧(延展时此端不动) */
  fixedEnd: 'min' | 'max';  // min = 负方向端固定,max = 正方向端固定
}
```

部件清单:
```
barrel(炮管):  axis='z', fixedEnd='min'(根部固定,炮口端延展)
track(履带):   axis='z', fixedEnd='center'(中心固定,两端对称延展)
hull(车体):    axis='z', fixedEnd='center'(中心固定,前后对称)
turret(炮塔):  无延展(整体跟随车体顶)
```

### 5.2 延展规则

拉长 `barrel.length`(从 1.9 → 2.5):
- 根部位置 `barrel.offset.z` **不变**(固定端)
- 炮口位置 = 根部 + length → 炮口向 +z 移动(远离车身)
- 不往 -z 延展 → 不穿透炮塔/车身

### 5.3 穿透防护(简化版)

**首期不做碰撞检测**(成本高)。改用"生长方向约束":部件只能沿自由方向延展,物理上不可能穿透(因为固定端贴父,延展远离父)。

若用户强制缩短到穿透(如 barrel.length 极小,炮口缩进炮塔)→ 用 `Math.max(minLength, length)` 限制最短( minLength = 父部件的厚度)。

---

## 6. 数据结构

### 6.1 装配图(预设,代码内常量)

```ts
/** 一条邻接约束 */
interface Constraint {
  /** 子字段路径,如 'turret.offset.y' */
  child: string;
  /** 依赖的父字段路径数组(公式可能引用多个) */
  depends: string[];
  /** 联动公式:传父字段值的字典,返回子字段应有值 */
  resolve: (vals: Record<string, number>) => number;
  /** 约束类型(决定 UI 显示) */
  type: 'mate' | 'contain' | 'align';
}

/** 坦克装配图(三车型共用结构;车型差异由字段存在性自然处理) */
const ASSEMBLY: Constraint[] = [
  { child: 'turret.offset.y', depends: ['hull.centerY', 'hull.height'],
    resolve: (v) => v['hull.centerY'] + v['hull.height'], type: 'mate' },
  { child: 'track.offsetX', depends: ['hull.bottomHalfX'],
    resolve: (v) => v['hull.bottomHalfX'], type: 'mate' },
  { child: 'track.halfZ', depends: ['hull.bottomHalfZ'],
    resolve: (v) => v['hull.bottomHalfZ'], type: 'align' },
  { child: 'roadWheel.zSpan', depends: ['track.halfZ', 'track.halfY'],
    resolve: (v) => v['track.halfZ'] - v['track.halfY'], type: 'contain' },
  { child: 'barrel.offset.z', depends: ['turret.armata.bottomHalfZ'],
    resolve: (v) => v['turret.armata.bottomHalfZ'], type: 'mate' },
  // ... 完整清单见 §3 表格
];
```

### 6.2 延展轴(预设)

```ts
const EXTENSION_AXES: Record<string, ExtensionAxis> = {
  'barrel.length': { axis: 'z', fixedEnd: 'min' },
  'track.halfZ':   { axis: 'z', fixedEnd: 'center' },
  'hull.bottomHalfZ': { axis: 'z', fixedEnd: 'center' },
  // ...
};
```

### 6.3 数据兼容

- **不改 JSON 格式**:tank.json 仍是纯数值(无表达式)。
- 约束关系是**代码内的预设规则**,不是数据的一部分。
- 用户编辑 → 引擎算出新值 → 写回 JSON(仍是数值)。
- 老数据完全兼容(数值就是数值,引擎读它、检查约束、必要时改它)。

**这个决定的意义**:装配能力是**编辑器的行为**,不是数据格式。JSON 产出和以前一样,游戏加载无感知。

---

## 7. 求解引擎(AssemblyEngine)

```ts
class AssemblyEngine {
  private constraints: Constraint[];
  private tolerance: number;  // 脱离容差

  /** 用户改了某字段(如拖滑块改 hull.height) */
  onFieldChanged(data: TankData, path: string): TankData {
    // 1. 找所有依赖此 path 的约束
    const affected = this.constraints.filter(c => c.depends.includes(path));
    // 2. 按拓扑序处理(防震荡;此处简化为迭代到收敛)
    let changed = true;
    let iterations = 0;
    while (changed && iterations < MAX_ITER) {
      changed = false;
      for (const c of affected) {
        const parentVals = this.readVals(data, c.depends);
        const expected = c.resolve(parentVals);
        const current = this.readVal(data, c.child);
        if (Math.abs(expected - current) > this.tolerance) {
          data = this.writeVal(data, c.child, expected);  // 脱离 → 调整
          changed = true;
          // 子字段变了,可能触发它的依赖者(链式)→ 下轮迭代处理
        }
      }
      iterations++;
    }
    return data;
  }
}
```

**收敛保证**:装配图是 DAG,每次调整让子字段逼近应有值,有限步内收敛。MAX_ITER 防御(如 10)。

---

## 8. 编辑器交互流程

### 8.1 当前主体 + 邻接可视化

1. 用户点 3D 模型某部件(Raycaster 拾取)→ 该部件选中(高亮发光)
2. **成为当前主体**:属性面板显示它的参数 + 邻居列表
3. **邻接可视化**:用浅色线/标记标出"哪些部件附着在它上"
   - 例如选车体 → 炮塔/履带/挡泥板高亮,连线显示"贴顶/贴侧/贴长"

### 8.2 编辑 + 实时求解

1. 用户拖主体的某滑块(如 hull.height)
2. 每次 input 事件:
   - 更新 hull.height
   - 调 `engine.onFieldChanged(data, 'hull.height')`
   - 返回新 data(邻居已调整)
   - rebuild 预览
3. 用户看到:车体变高的同时,炮塔自动上移(脱离触发)

### 8.3 约束开关(尊重用户设计)

每个邻接约束可**临时关闭**(用户故意创造间隙):
- 邻接部件旁显示 🔗/🔓 图标
- 点 🔒 解锁:该约束不自动维持(用户手动定位)
- 默认全部锁定(自动维持)

---

## 9. 分阶段实现(建议)

这个功能复杂,建议分 4 阶段,每阶段可独立验证:

### Phase 1:装配图 + 位置 Mate(基础,MVP)
- 定义 `ASSEMBLY` 规则表(§6.1)
- `AssemblyEngine.onFieldChanged`(惰性求解,§7)
- 编辑器集成:改字段 → 引擎 → rebuild
- 覆盖:炮塔贴车体顶(Y Mate)、履带贴车体侧(X Mate)
- **验证**:改 hull.height → 炮塔 Y 自动跟;改 hull.bottomHalfX → 履带 X 自动跟

### Phase 2:尺寸 Align/Contain(完整联动)
- 履带长度跟随车体(Align Z)
- 负重轮跨度跟随履带(Contain Z)
- 链式传播(车体→履带→负重轮)
- **验证**:改 hull.bottomHalfZ → 履带变长 → 负重轮跨度变大

### Phase 3:生长方向(不穿透)
- `EXTENSION_AXES` 定义(§5)
- 炮管延展沿 +z(固定根部)
- 最短长度限制(防缩进穿透)
- **验证**:拉长炮管 → 炮口远移,不穿透车身

### Phase 4:3D 交互(选中/可视化)
- Raycaster 点击拾取部件
- 选中高亮 + 邻接连线可视化
- 约束开关 UI(🔗/🔓)
- **验证**:点炮管 → 选中,拖长度 → 实时跟随

---

## 10. 复杂度与风险

| 维度 | 评估 |
|------|------|
| 难度 | **高**(约束求解是 CAD 核心技术) |
| 工作量 | 大(引擎 + 规则表 + 交互 + 可视化),约相当于 combat-layer 的量级 |
| 风险 | 中(求解算法需调试;多约束冲突时可能有多解,需定义优先级) |
| 收益 | 高(编辑器从"调参工具"升级为"装配设计工具",体验质变) |

**主要风险点**:
1. **多约束冲突**:某字段同时被多个约束影响(如 track.offsetX 被 Mate 约束,又被别的约束)→ 需定义优先级或合并。
2. **拓扑序震荡**:迭代求解可能不收敛(两个约束互相拉扯)→ MAX_ITER 兜底 + 拓扑排序预防。
3. **虎式/M1 差异**:交错轮/托带轮/侧裙等车型独有部件的邻接,要单独定义。

---

## 11. 待确认的设计细节(实现前需定)

1. **TOLERANCE 值**:0.05m 合适?还是更小(0.02)?影响"何时算脱离"。
2. **约束优先级**:多约束冲突时,位置(Mate)优先于尺寸(Align)?还是尺寸优先?
3. **链式深度**:车体→履带→负重轮→交错轮(虎式),4 级链式,收敛性需验证。
4. **3D 拾取精度**:点炮管时,炮管细长,拾取命中难;是否加"选区放大"?
5. **虎式/M1 独有部件**:交错轮/托带轮/侧裙/机枪站的邻接规则,需要单独梳理(可 Phase 2 补)。

---

## 附:与现有架构的集成点

| 模块 | 改动 |
|------|------|
| `tank.json` | **不改**(纯数值,约束是编辑器行为) |
| `TankSchema` | **不改**(数值 schema 不变) |
| `TankVisualBuilder` | **不改**(只消费最终数值) |
| `TankDataStore` | **不改**(游戏加载无需约束,约束仅编辑器用) |
| **新增** `AssemblyEngine.ts` | 求解引擎(editor 用) |
| **新增** `assemblyRules.ts` | 装配图规则表 |
| `editor.ts` | 集成引擎:onPropChange 时调 engine |
| `PropPanel` | 显示约束状态(🔗 图标,可选 Phase 4) |

**对游戏零影响**:装配约束是编辑器能力,JSON 产出格式不变,游戏加载/渲染完全不感知。这是设计的关键优点。
