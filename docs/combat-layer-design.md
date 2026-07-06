# 战斗层策略深度增强 · 详细设计文档

> 范围：A1 弹药种类(AP+HE) + A2 弱点部位(临时 debuff) + A3 主动技能(玩家 + veteran NPC)
> 基线：当前 `main` 分支。所有接口签名基于现状真实代码，非臆造。
> 原则：复用现有架构（CONFIG 集中参数 / DirectorSystem 导演层 / Damageable 伤害契约），不推翻重写。

---

## 0. 架构总览

### 0.1 现状数据流（仅战斗相关）

```
玩家/NPC InputState
      │
      ▼
TankController.applyDrive  ──► physics.step
      │                          │
      │                          ▼
      │                    SyncBridge.sync
      │                          │
      ▼                          ▼
WeaponSystem.update ◄──── drainCollisionEvents(h1,h2) ────► DestructionSystem.handleCollision(撞击)
      │ fire()                                                         │
      ▼                                                                ▼
  Projectile(刚体) ──命中──► WeaponSystem.handleCollision ──► detonate
                                                              │
                                                              ▼
                                              DestructionSystem.onExplosion
                                                              │
                                                              ▼
                                              applyDamage(爆心,半径,伤害)  ← 纯 AOE
                                                              │
                                       ┌──────────────────────┼─────────────────────┐
                                       ▼                      ▼                     ▼
                                  坦克.takeHit            砖块/树/塔           补给点.takeHit
                              (含 armorMultiplier 方向装甲)
```

**核心问题**：`applyDamage` 是纯 AOE 模型（爆心+半径衰减），完全不知道"炮弹打中了哪个 collider"。部位瞄准必须知道命中部位 → **必须分裂出直接命中管线**。

### 0.2 增强后数据流

```
                          ┌──────────── TankStatus(状态聚合层·新增) ────────────┐
                          │  moveScale / turretScale / damageReduction / 临时debuff │
                          └────────────────────────┬──────────────────────────────┘
                                                   │ 读
              ┌────────────────────────────────────┼─────────────────────────────────┐
              ▼                                    ▼                                 ▼
   TankController.applyDrive           DestructionSystem 受击结算            SkillSystem(新增)
   (moveSpeed × status.moveScale)      (伤害 × status.damageReduction)       (驱动 status)
                                                   ▲
                                                   │
WeaponSystem.fire(type) ──► Projectile(type) ──命中──► detonate
                                                   │
                              ┌────────────────────┴────────────────────┐
                              ▼ type=AP                                  ▼ type=HE
                  applyDirectHit(命中collider→部位)            onExplosion(AOE，复用现有)
                              │                                          │
                              ▼                                          ▼
                  坦克.takeHit(部位debuff注入status)            现有 AOE 伤害链不变
```

三个子系统的耦合点全部收口在 **`TankStatus`**——这是整个战斗层增强的"地基"，必须最先落地。

---

## 1. 前置工作：TankStatus 状态聚合层

### 1.1 为什么必须先做

| 改动来源 | 影响参数 | 现状写入位置 |
|---------|---------|------------|
| A2 履带命中 | `moveSpeed` ×0.1、`turnSpeed` ×0.1 | 若直接改 cfg 会污染所有同型车 |
| A2 炮塔命中 | `turret.turnSpeed` ×0.4 | 同上 |
| A3 引擎过载 | `moveSpeed` ×1.5、`turnSpeed` ×1.3 | 同上 |
| A3 装甲倾斜 | 受击伤害 ×0.6 | 需在 takeHit 前乘 |

若各系统各自改 `cfg.moveSpeed`，**会互相覆盖**（过载期间履带被打，过载结束履带 debuff 也被清掉）。必须用一个只读聚合层，所有修改经它中转。

### 1.2 数据结构

新增 `src/entities/TankStatus.ts`：

```ts
/** 部位标签(挂在坦克部位 collider 的 userData 上) */
export type TankPart = 'hull' | 'turret' | 'track' | 'ammoRack';

/** 临时 debuff 实例(注入 status.effects，到期自动清除) */
interface TimedEffect {
  id: string;              // 唯一标识(同 id 新覆盖旧，防叠加)
  remaining: number;       // 剩余秒
  moveScale?: number;      // 乘到 moveScale
  turnScale?: number;      // 乘到 turnScale
  turretScale?: number;    // 乘到炮塔转速
  damageReduction?: number;// 受击伤害乘此(0.6=减伤40%)
}

/**
 * 坦克运行时状态聚合层
 * ------------------------------------------------------------
 * 所有"会改变机动/受击参数的临时状态"(履带debuff/引擎过载/装甲倾斜)
 * 统一在此聚合，TankController/DestructionSystem 只读取最终系数，
 * 任何系统都不直接改 cfg.moveSpeed——避免互相覆盖(见 1.1)。
 *
 * 设计：effect 列表驱动，update 递减 remaining，到期移除；
 *       系数用 getter 实时聚合，无需手动重算。
 */
export class TankStatus {
  private effects: TimedEffect[] = [];

  /** 注入/刷新效果(同 id 覆盖，防履带连击无限叠加) */
  apply(e: TimedEffect): void { /* 移除同 id 后 push */ }

  update(dt: number): void { /* remaining-=dt，<=0 移除 */ }

  get moveScale(): number { /* 所有 moveScale 相乘，缺省1 */ }
  get turnScale(): number { /* 同上 */ }
  get turretScale(): number { /* 同上 */ }
  get damageReduction(): number { /* 所有 damageReduction 相乘 */ }

  /** 调试用：当前激活效果摘要 */
  get debugSummary(): string { /* "track×0.1(8s),boost×1.5(3s)" */ }
}
```

### 1.3 接入点

| 文件 | 改动 |
|------|------|
| `IControllableTank.ts` | 加 `readonly status: TankStatus;`（所有坦克强制持有） |
| `TankBase` / `StaticTankBase` | 构造时 `this.status = new TankStatus()` |
| `TankController.applyDrive` | `cfg.moveSpeed` → `cfg.moveSpeed * tank.status.moveScale`；`turnSpeed` 同理 |
| `TankController.applyAim` | 炮塔 `cfg.turret.turnSpeed` → `× tank.status.turretScale` |
| `DestructionSystem` 坦克受击分支 | `damage * falloff * mult` → 再 `× tank.status.damageReduction` |
| `main.ts` 主循环 | `destruction.update` 后调每辆坦克 `status.update(dt)`（或由 destruction.update 统一代理） |

### 1.4 测试用例

1. 无效果时所有 scale = 1.0（基准）
2. 注入履带 debuff(moveScale=0.1, 10s) → 10s 内 moveScale=0.1，到期恢复 1.0
3. 履带 debuff 期间再注入引擎过载(moveScale=1.5) → 聚合为 0.1×1.5=0.15（乘法叠加）
4. 同 id 效果二次注入 → 覆盖而非叠加（履带连击只续期不翻倍）
5. damageReduction 多源叠加（装甲倾斜 0.6 × 某未来技能 0.8 = 0.48）

---

## 2. 里程碑 1：A1 弹药种类（AP + HE）

### 2.1 设计取向

```
AP 穿甲弹：直接命中模型，单体高伤，对装甲有穿透加成，无溅射，对建筑弱
           → 用于精准点杀坦克，是"打坦克"的主弹种
HE 高爆弹：AOE 范围模型（复用现有 applyDamage），对装甲伤害低但溅射，对建筑强
           → 用于清建筑/盲区压制/打集群，是"打环境/消耗"的弹种
```

**关键决策**：AP 走新管线 `applyDirectHit`，HE 走现有 `onExplosion`。两条管线在 `detonate` 处按 `proj.damageType` 分发。这样 HE 完全复用现有 AOE 代码，零回归风险。

### 2.2 CONFIG 数据结构

`config.ts` 改动：

```ts
/** 弹药类型标识 */
type AmmoType = 'ap' | 'he';

/** 武器/开火 —— 改为按弹种分参数 */
weapon: {
  /** 各弹种参数(替换原单一 projectile) */
  ammoTypes: {
    ap: {
      /** 直击伤害倍率(相对基础 hitDamage)——AP 打坦克更强 */
      damageMultiplier: 1.5,
      /** 对装甲的额外穿透(叠加在方向装甲之上) */
      armorPenetration: 0.2,   // 即装甲方向倍率 ×(1-0.2)
      /** 对建筑/可破坏物的伤害倍率——AP 打建筑弱 */
      destructibleMultiplier: 0.4,
      /** 弹体物理参数(沿用原 projectile 字段) */
      radius: 0.13, mass: 3.5, muzzleVelocity: 70, maxLifetime: 6,
      /** 视觉：AP 弹尖头、暗色 */
      color: 0x1c1e22,
    },
    he: {
      /** 直击伤害倍率——HE 直接命中也不算高(主要靠溅射) */
      damageMultiplier: 0.7,
      /** 爆炸半径倍率(相对基础 explosionRadius)——HE 溅射更大 */
      explosionRadiusMultiplier: 1.6,
      /** 对建筑/可破坏物伤害倍率——HE 清建筑强 */
      destructibleMultiplier: 1.5,
      /** 弹体物理参数 */
      radius: 0.15, mass: 2.5, muzzleVelocity: 60, maxLifetime: 6,
      /** 视觉：HE 弹圆钝、橄榄色 */
      color: 0x3a4a2a,
    },
  },
  /** 开火冷却/后坐力/特效 沿用现有(不区分弹种) */
  fireCooldown: 0.55,
  recoil: { /* 不变 */ },
  explosion: { /* 基础爆炸参数，HE 按倍率放大 */ },
  muzzleFlash: { /* 不变 */ },
},

/** 弹药库存 —— 改为按弹种独立 */
ammo: {
  /** 各弹种上限(替换原单一 maxAmmo) */
  maxByType: { ap: 18, he: 12 },
  /** 补给点装填速率(发/秒，按弹种同时回) */
  resupplyRate: { ap: 5, he: 4 },
  resupplyRadius: 5,
  /** NPC 弹药≤此值时主动补给(按当前选弹) */
  npcResupplyThreshold: 5,
},
```

### 2.3 Projectile 改造

`entities/Projectile.ts`：

```ts
export class Projectile {
  // 新增
  readonly damageType: AmmoType;
  // 模块级共享几何/材质改为按类型缓存(两种弹各一套，避免每发新建材质)
  constructor(
    physics, render,
    pos, dir,
    type: AmmoType,   // 新增入参
  ) {
    this.damageType = type;
    const cfg = CONFIG.weapon.ammoTypes[type];
    // 用 cfg.radius/mass/muzzleVelocity/maxLifetime 替换原 CONFIG.weapon.projectile
    // mesh 用 type 对应的共享几何/材质(颜色区分)
  }
}
```

### 2.4 WeaponSystem 改造

核心：弹药库存从 `Map<tankId, number>` 改为 `Map<tankId, {ap,he}>`，新增选弹状态。

```ts
/** 每辆坦克的弹药库存(按弹种独立) */
private readonly ammoByTank = new Map<number, { ap: number; he: number }>();
/** 每辆坦克当前选弹(默认 ap) */
private readonly selectedByTank = new Map<number, AmmoType>();

/** 切换当前活性坦克的弹种(由 InputSystem 边沿触发调用) */
switchAmmo(type: AmmoType): void {
  const tank = this.getActiveTank();
  const prev = this.selectedByTank.get(tank.id) ?? 'ap';
  if (prev === type) return;
  this.selectedByTank.set(tank.id, type);
  log.info('AMMO SWITCH', { tank: tank.name, from: prev, to: type });
}

/** 当前选弹(HUD/NPC 用) */
getSelectedAmmo(): AmmoType { return this.selectedByTank.get(this.getActiveTank().id) ?? 'ap'; }

/** 取某弹种库存(HUD 三栏显示用) */
getAmmoByType(type: AmmoType): number { /* Math.floor */ }

private fire(tank) {
  const type = this.selectedByTank.get(tank.id) ?? 'ap';
  if (this.ammoOf(tank)[type] < 1) return;           // 该弹种空仓
  const proj = new Projectile(this.physics, this.render, spawnPos, dir, type);
  proj.ownerTank = tank;
  // ... 后坐力、炮口焰、相机震动(按 type 可微调，HE 后坐更大)
  this.ammoOf(tank)[type] -= 1;                       // 扣对应弹种
}
```

`detonate` 按类型分发（**本设计的核心**）：

```ts
private detonate(p: Projectile, explode: boolean): void {
  if (!p.alive) return;
  p.alive = false;
  if (!explode) return;
  const t = p.body.translation();
  const cfg = CONFIG.weapon.ammoTypes[p.damageType];
  if (p.damageType === 'he') {
    // HE：AOE，完全复用现有 onExplosion，仅放大半径
    this.explosions.push(new Explosion(this.render, t));  // HE 爆炸特效更大
    this.destruction.onExplosion(
      t,
      CONFIG.destruction.explosionRadius * cfg.explosionRadiusMultiplier,
      p.ownerTank,
      cfg.destructibleMultiplier,   // 新增参数：可破坏物伤害倍率(见 2.5)
    );
  } else {
    // AP：直接命中，需知道打中了谁(见 2.6)
    this.explosions.push(new Explosion(this.render, t));  // AP 小爆炸(穿甲不爆)
    this.destruction.applyDirectHit(t, p.lastHitColliderHandle, p.ownerTank, cfg);
  }
}
```

**问题**：`detonate` 怎么知道 AP 打中了哪个 collider？现有 `handleCollision(h1,h2)` 拿得到被击 collider handle，但 `detonate` 只收 `Projectile`。**解法**：在 `handleCollision` 里把被击 handle 暂存到 Projectile 上：

```ts
export class Projectile {
  /** 命中时由 WeaponSystem.handleCollision 写入(供 AP 部位判定用) */
  lastHitColliderHandle?: number;
}

handleCollision(h1, h2) {
  const p = this.projByCollider.get(h1) ?? this.projByCollider.get(h2);
  if (!p?.alive) return;
  // 记录被击方的 collider handle(AP 直击管线用)
  p.lastHitColliderHandle = this.projByCollider.has(h1) ? h2 : h1;
  this.detonate(p, true);
}
```

### 2.5 DestructionSystem 改造

#### 2.5.1 `onExplosion` 加可破坏物伤害倍率（HE 用）

```ts
onExplosion(pos, radius, excludeTank?, destructibleMultiplier = 1): void {
  this.applyDamage(pos, radius, CONFIG.destruction.hitDamage, excludeTank, destructibleMultiplier);
}
```

`applyDamage` 内部对所有可破坏物（箱子/砖/树/塔/房屋）的伤害 `× destructibleMultiplier`，对坦克的伤害**不乘**（坦克走装甲逻辑，由弹药类型在直击管线处理）。这样 HE 对建筑强、对坦克弱的效果自然产生。

#### 2.5.2 新增 `applyDirectHit`（AP 用）

```ts
/**
 * AP 直击伤害：按命中的具体 collider 判定目标 + 部位（M2 部位瞄准用，首期只判目标不判部位）。
 * 与 AOE applyDamage 的区别：精确到单个目标、无衰减(满伤)、按弹药类型算装甲穿透。
 */
applyDirectHit(
  pos: Vec3,
  hitColliderHandle: number,
  excludeTank: IControllableTank | undefined,
  ammoCfg: typeof CONFIG.weapon.ammoTypes.ap,
): void {
  const col = this.physics.world.getCollider(hitColliderHandle);
  if (!col) return;
  // 反查命中目标：优先坦克(部位 collider)，其次其他可破坏物
  const target = this.resolveHitTarget(col);
  if (!target) return;

  if (target.kind === 'tank') {
    if (target.tank === excludeTank || target.tank.state !== 'intact') return;
    // 部位 part 在 M2 用；首期全当 hull
    const baseMult = this.armorMultiplier(target.tank, pos);
    const pen = 1 - ammoCfg.armorPenetration;        // 穿甲削弱装甲
    const reduction = target.tank.status.damageReduction; // 状态层减伤(A3)
    const dmg = CONFIG.destruction.hitDamage * ammoCfg.damageMultiplier * baseMult * pen * reduction;
    this.fragments.push(...target.tank.takeHit(pos, dmg));
  } else {
    // 可破坏物(树/砖/箱子等)：AP 对建筑弱
    this.applyDamage(pos, CONFIG.destruction.explosionRadius * 0.4,
      CONFIG.destruction.hitDamage * ammoCfg.destructibleMultiplier, excludeTank);
  }
}
```

`resolveHitTarget(col)`：用 `col.userData`（部位 collider 标记，见 M2）或 `tankByCollider` 反查。首期（M1）`tankByCollider` 只含主 collider，AP 打坦克判定足够；M2 加部位 collider 后扩展。

### 2.6 InputSystem / HUD / ResupplySystem 改动

| 文件 | 改动 |
|------|------|
| `InputSystem` | `InputState` 加 `switchAmmo: AmmoType \| null`；`1`→`'ap'`、`2`→`'he'` 边沿触发（按下瞬间非空，否则 null） |
| `HUD.ammoInfo` | 文本改为 `AP 12 │ HE 8`，当前选种高亮反色；空仓的弹种置灰 |
| `ResupplySystem.resupply` | 按 `CONFIG.ammo.resupplyRate.{ap,he}` 同时回两种，各自到顶 |
| `main` 切坦克回调 | `switcher.onSwitch` 里无需特殊处理（选弹状态按 tank.id 隔离，切换后读各自选弹） |
| `WeaponSystem.update` | 读 `input.switchAmmo`，非 null 则调 `switchAmmo(type)` |

### 2.7 NPC 弹药策略（轻量）

首期 NPC 默认只用 AP（点杀玩家），不主动切 HE。理由：NPC 清建筑无战术价值，AP 对玩家威胁最大。veteran 可在 M3 后扩展（被建筑挡住时切 HE 开路）。

### 2.8 测试用例

1. **选弹**：按 1/2 切换，HUD 高亮跟随；切换无冷却、不消耗
2. **独立库存**：AP 打光后切 HE 仍能开火；AP/HE 各自计数
3. **AP 直击**：AP 打静止虎式，伤害 = hitDamage×1.5×装甲方向×(1-0.2)，无溅射（旁边砖块不掉）
4. **HE 溅射**：HE 打砖墙，半径 = explosionRadius×1.6，多块砖飞溅；打坦克伤害 = hitDamage×0.7×装甲方向
5. **AP 对建筑弱**：AP 打砖墙伤害×0.4，对比 HE×1.5，验证倍率
6. **补给分种**：补给点同时回 AP+HE，各自独立到顶
7. **空仓**：某弹种为 0 时该弹种开火无效（不触发冷却），另一种正常
8. **异常**：AP 飞行中切 HE，已发射的 AP 仍按 AP 结算（damageType 生成时定型）

---

## 3. 里程碑 2：A2 弱点部位（临时 debuff）

### 3.1 部位设计（用户已定：全为临时 debuff，无殉爆秒杀）

```
hull   车体(主 collider) → 走现有方向装甲逻辑(前1.0/侧1.5/背2.0)，无额外 debuff
turret 炮塔 collider     → 命中后炮塔转速 ×0.4，持续 8s（炮塔跟不上，准星劣势）
track  履带 collider(左右各一) → 命中后 moveScale ×0.15、turnScale ×0.15，持续 12s（几乎瘫掉，鼓励绕侧）
```

**设计要点**（用户原则"用结果反馈而非操作限制"）：debuff 是临时 debuff 而非永久损坏，到期自动恢复，玩家被废后仍有翻盘窗口。

### 3.2 部位 collider 挂载

rapier 一个 RigidBody 可挂多个 Collider。部位 collider 挂在 `tank.body` 上（共享刚体，无需新 body）。`userData` 存部位标签：

```ts
// 坦克实体构造时(在 TankBase/StaticTankBase)，主 collider 之后追加：
const turretCol = RAPIER.ColliderDesc.cuboid(/*炮塔包围盒*/)
  .setTranslation(0, turretY, 0)           // 相对 body 局部偏移
  .setSensor(true)                          // sensor：不参与物理推挤，只报碰撞事件(防履带collider把坦克顶飞)
  .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
turretCol.userData = { part: 'turret', tank: this };  // 反查用(见下)
const tc = physics.world.createCollider(turretCol, this.body);

// 履带 collider：左右各一个，覆盖履带区域
// ...

// 注册到 DestructionSystem 部位反查表
this.partColliders = [
  { handle: tc.handle, part: 'turret' },
  { handle: leftTrack.handle,  part: 'track' },
  { handle: rightTrack.handle, part: 'track' },
];
```

**为什么 sensor**：部位 collider 若是实体，会扩大坦克物理碰撞体，导致撞击判定变形（现有 `tankByCollider` 撞树逻辑会用错 collider）。sensor 只触发碰撞事件、不影响物理形状，恰好满足"命中部位判定"需求。

### 3.3 DestructionSystem 部位反查

新增部位反查表（setControllableTanks / registerTank 时填充）：

```ts
/** collider handle → {tank, part}（部位 collider 反查，AP 直击用） */
private readonly partByCollider = new Map<number, { tank: IControllableTank; part: TankPart }>();

setControllableTanks(tanks) {
  // ... 现有
  this.partByCollider.clear();
  for (const t of tanks) {
    for (const pc of t.partColliders) this.partByCollider.set(pc.handle, { tank: t, part: pc.part });
    // 主 collider 也登记为 hull(兜底)
    this.partByCollider.set(t.colliderHandle, { tank: t, part: 'hull' });
  }
}
```

### 3.4 部位伤害结算（升级 M1 的 applyDirectHit）

```ts
applyDirectHit(pos, hitColliderHandle, excludeTank, ammoCfg) {
  const info = this.partByCollider.get(hitColliderHandle);
  if (!info) {
    // 非坦克部位 collider：当作环境可破坏物(走 AOE 小半径)
    this.applyDamage(pos, ..., ammoCfg.destructibleMultiplier);
    return;
  }
  const { tank, part } = info;
  if (tank === excludeTank || tank.state !== 'intact') return;

  // 1. 伤害结算(部位仅影响 debuff，伤害本身走方向装甲)
  const baseMult = this.armorMultiplier(tank, pos);
  const dmg = CONFIG.destruction.hitDamage * ammoCfg.damageMultiplier * baseMult * (1 - ammoCfg.armorPenetration) * tank.status.damageReduction;
  this.fragments.push(...tank.takeHit(pos, dmg));

  // 2. 部位 debuff 注入状态层(M2 核心)
  this.applyPartDebuff(tank, part);
  log.info('PART HIT', { tank: tank.displayName, part, hp: tank.getHp() });
}

private applyPartDebuff(tank, part) {
  const cfg = CONFIG.combat.parts;  // 见 3.5
  if (part === 'turret') {
    tank.status.apply({ id: 'turret-dmg', remaining: cfg.turret.duration, turretScale: cfg.turret.scale });
  } else if (part === 'track') {
    tank.status.apply({ id: 'track-dmg', remaining: cfg.track.duration, moveScale: cfg.track.scale, turnScale: cfg.track.scale });
  }
  // hull/ammoRack：hull 无 debuff；ammoRack 本期不做(用户已定无秒杀)
}
```

### 3.5 CONFIG 数据

```ts
/** 战斗层增强(部位/技能)统一参数 */
combat: {
  /** 弱点部位 debuff(临时，到期恢复) */
  parts: {
    turret: { scale: 0.4, duration: 8 },   // 炮塔转速×0.4，8s
    track:  { scale: 0.15, duration: 12 }, // 机动×0.15，12s
  },
},
```

### 3.6 IControllableTank 接口扩展

```ts
export interface IControllableTank {
  // ... 现有
  readonly status: TankStatus;                          // M0 状态层
  /** 部位 collider 列表(主 collider 之外追加的炮塔/履带 sensor) */
  readonly partColliders: ReadonlyArray<{ handle: number; part: TankPart }>;
}
```

### 3.7 测试用例

1. **collider 稳定**：部位 sensor 不影响坦克行驶/撞击判定（撞树/撞墙行为与改造前一致）
2. **履带命中**：AP 打 NPC 履带 → NPC `moveScale=0.15`，observe `NpcController.engage` 开不快、`retreat` 失效，12s 后恢复
3. **炮塔命中**：AP 打 NPC 炮塔 → 炮塔转速明显变慢，玩家更容易绕到侧背
4. **玩家被废**：调试按钮模拟玩家履带命中 → 驾驶降速但不锁死（仍能微动+开火，保留可玩性）
5. **debuff 不叠加**：连续两发打履带 → 只续期 12s，不变成 ×0.15²
6. **debuff 叠加**：履带 debuff + 引擎过载(M3) → 0.15×1.5=0.225（乘法叠加，状态层保证）
7. **hull 命中**：打车体无 debuff，仅方向装甲生效（回归测试）
8. **HE 不触发部位**：HE 是 AOE，不判部位（AOE 半径内全员受方向装甲伤害，无 debuff）——这是 AP/HE 的战术区分

### 3.8 风险

- **sensor 性能**：每辆坦克多 3 个 sensor collider，全图坦克数 ×3。当前坦克数 <15，影响可忽略。
- **部位 collider 与主 collider 重叠**：AP 可能同时触发主 collider 和部位 collider 的碰撞事件。**对策**：`projByCollider` 只匹配炮弹自身 collider，被击方只取一个 handle（h1/h2 中非炮弹的那个），不会重复 detonate。

---

## 4. 里程碑 3：A3 主动技能（玩家 + veteran NPC）

### 4.1 技能集（用户已定：veteran NPC 也带；A1 无烟雾，故技能集为三个）

```
应急维修 repair ：20s CD，3s 内回 30HP。施法期间需站桩(速度<阈值才生效)，被打断(移动)则中止
引擎过载 boost  ：15s CD，4s 内 moveScale×1.5、turnScale×1.3。冲锋/抢点/逃命
装甲倾斜 armor  ：18s CD，5s 内受击伤害×0.6(damageReduction)。硬换窗口
```

**为什么三个正好**：覆盖 续航/机动/防御 三维，玩家必须选此刻最缺的——这才是"选择"。烟雾放后续（A1.5）再做。

### 4.2 CONFIG 数据

```ts
combat: {
  // parts: {...},  // M2
  skills: {
    repair: {
      cooldown: 20, duration: 3, healTotal: 30,
      /** 施法最大速度(m/s)：超此视为移动中断 */
      castMaxSpeed: 1.5,
    },
    boost:  { cooldown: 15, duration: 4, moveScale: 1.5, turnScale: 1.3 },
    armor:  { cooldown: 18, duration: 5, damageReduction: 0.6 },
  },
  /** veteran NPC 技能决策参数 */
  npcSkill: {
    /** 维修触发血量比 */
    repairHpRatio: 0.4,
    /** 装甲倾斜触发血量比 */
    armorHpRatio: 0.6,
    /** 引擎过载触发距离比(相对 fireRange，>此值需冲锋) */
    boostDistRatio: 1.2,
  },
},
```

### 4.3 SkillSystem 新系统

`src/systems/SkillSystem.ts`，与 WeaponSystem 同级，绑定活性坦克：

```ts
export type SkillId = 'repair' | 'boost' | 'armor';

interface SkillState { cooldown: number; active: number; }  // 剩余冷却 / 剩余激活时长

/**
 * 技能系统
 * ------------------------------------------------------------
 * 每辆坦克独立技能状态(按 tank.id 隔离，同 WeaponSystem 弹药模式)。
 * 激活时给 tank.status 注入对应 effect(M0 状态层统一聚合)。
 * repair 特殊：激活期间检测速度，超 castMaxSpeed 则中止(不回冷却的一半，惩罚乱用)。
 */
export class SkillSystem {
  private readonly statesByTank = new Map<number, Record<SkillId, SkillState>>();

  constructor(private readonly getActiveTank: () => IControllableTank) {}

  /** 尝试激活(玩家按键/NPC 决策调用)。CD 中或已激活则忽略。 */
  tryActivate(id: SkillId): boolean {
    const tank = this.getActiveTank();
    const s = this.stateOf(tank)[id];
    if (s.cooldown > 0 || s.active > 0) return false;
    s.cooldown = CONFIG.combat.skills[id].cooldown;
    s.active = CONFIG.combat.skills[id].duration;
    this.injectEffect(tank, id);
    log.info('SKILL', { tank: tank.name, skill: id });
    return true;
  }

  update(dt: number): void {
    const tank = this.getActiveTank();
    const states = this.stateOf(tank);
    for (const id of ['repair','boost','armor'] as SkillId[]) {
      const s = states[id];
      if (s.cooldown > 0) s.cooldown -= dt;
      if (s.active > 0) {
        s.active -= dt;
        this.tickSkill(tank, id, dt);   // repair 每帧回血 / 中断检测
        if (s.active <= 0) this.onExpire(tank, id);
      }
    }
  }

  /** HUD 用：某技能冷却进度(0~1，1=可用) */
  cooldownRatio(id: SkillId): number { /* 1 - cooldown/maxCooldown */ }
  isActive(id: SkillId): boolean { /* active>0 */ }
}
```

`injectEffect`：boost/armor 调 `tank.status.apply({id, remaining, moveScale/damageReduction})`（状态层自动到期清理）；repair 不注入 status（它是回血，不改变机动/受击），由 `tickSkill` 每帧 `tank.heal(amount)`。

**IControllableTank 需新增** `heal(amount: number): void`（现有只有 takeHit 扣血）。

### 4.4 玩家输入与 HUD

| 文件 | 改动 |
|------|------|
| `InputSystem` | `InputState` 加 `skill: SkillId \| null`；`E`→repair、`R`→boost、`F`→armor（避开 1/2 弹药、Q/W/A/S 炮塔炮管） |
| `HUD` | 新增技能栏（3 格，位于弹药栏左侧），每格：图标 + 冷却环（CD 中灰色扇形收缩）+ 激活高亮（金色边框） |
| `WeaponSystem.update` 改为 `CombatSystems.update`？否 | 技能系统独立，main 主循环里加 `skill.update(dt)` 一行 |
| `main` | `new SkillSystem(() => switcher.activeTank)`；主循环 playing 块加 `if (input.skill) skill.tryActivate(input.skill); skill.update(dt);` |

### 4.5 veteran NPC 技能决策（本里程碑最大增量）

`NpcController` 新增技能决策模块。**关键约束**：NPC 复用玩家的 SkillSystem 接口，但每辆 NPC 有独立 SkillSystem 实例（避免共享冷却）。

#### 4.5.1 架构

```ts
// DirectorSystem.initNpcs / spawnEnemy 里：
const skill = new SkillSystem(() => tank);
const npc = new NpcController(..., skill, profile);  // 多传 skill
```

`NpcController` 仅当 `profile === veteran` 时启用技能决策（rookie/regular 不持有技能，平衡性：低阶 NPC 仍是纯机械 AI）。

#### 4.5.2 决策规则（在 think() 里，transition 之后）

```ts
private thinkSkill(dt: number): void {
  if (this.profile !== CONFIG.npcTiers.veteran) return;  // 仅 veteran
  if (!this.target) return;
  const hpRatio = this.tank.getHp() / this.maxHp;
  const dist = this.distTo(this.target);
  const cfg = CONFIG.combat.npcSkill;

  // 维修：残血 + 脱战(无视线或远) → 站桩回血(战斗中修是送死)
  if (hpRatio < cfg.repairHpRatio) {
    const hasLOS = hasLineOfSight(this.physics, this.tank, this.target);
    if (!hasLOS || dist > this.profile.fireRange * 1.3) {
      this.skill.tryActivate('repair');
      return;
    }
  }
  // 装甲倾斜：中血 + 正在交战 → 硬换
  if (hpRatio < cfg.armorHpRatio && this.state === 'engage') {
    this.skill.tryActivate('armor');
    return;
  }
  // 引擎过载：目标太远需逼近 / 残血需逃跑
  if (dist > this.profile.fireRange * cfg.boostDistRatio && this.state === 'approach') {
    this.skill.tryActivate('boost');
    return;
  }
  if (hpRatio < cfg.repairHpRatio && this.state === 'retreat') {
    this.skill.tryActivate('boost');   // 残血逃跑加速
  }
}
```

#### 4.5.3 NPC 维修时的机动约束

repair 施法要求站桩（`castMaxSpeed`）。NPC 维修时需主动减速——`thinkSkill` 激活 repair 后，`produceInput` 检测到 repair 激活则输出 `forward=0,turn=0`（站桩），覆盖 engage 的绕侧指令。这样 NPC 维修期间是靶子，玩家可趁机绕侧——**这是 veteran 的战术破绽**，平衡其技能优势。

### 4.6 测试用例

1. **冷却**：技能激活后 CD 内重复按无效；CD 到期可再用
2. **状态聚合**：boost 激活时 `status.moveScale=1.5`，TankController 驾驶明显加速
3. **装甲叠加**：装甲倾斜(0.6) + 现有方向装甲(侧1.5) → 受击伤害 = 基础×1.5×0.6，验证乘法顺序
4. **repair 中断**：激活 repair 后立即移动（速度>castMaxSpeed）→ 中止，HP 不再回（已回的保留）
5. **repair 站桩**：NPC veteran 残血脱战维修 → 停下回血；玩家逼近 → NPC 被迫中断（state 变 engage）
6. **veteran 限定**：rookie/regular NPC 全程不触发技能（验证 profile 门控）
7. **视觉**：boost=车尾喷焰、armor=车身泛蓝光、repair=头顶维修图标（视觉反馈优先于文字）
8. **多源不冲突**：玩家 boost + NPC veteran armor 同时存在，各自 status 独立

### 4.7 风险

- **NPC 技能决策频率**：think 每帧调 thinkSkill 会高频 tryActivate，但 SkillSystem 内部 CD 检查使其幂等，无副作用。可加 0.5s 计时节流省日志。
- **repair 让 NPC 变靶子**：若 veteran 维修时被秒，体感像 bug。**对策**：repair 回血速率调高（healTotal/duration = 10HP/s），3s 回 30HP 够扛 1-2 发，而非"修着修着就死了"。

---

## 5. 跨切面约定

### 5.1 日志规范（用户原则：关键交互必加日志）

所有新增交互点必须 log，关键字段：
- `AMMO SWITCH` {tank, from, to}
- `FIRE` {tank, type, ammo}（扩展现有 FIRE 日志加 type）
- `PART HIT` {tank, part, hp}（部位命中）
- `SKILL` {tank, skill}（技能激活）
- `SKILL EXPIRE` {tank, skill}（技能到期）
- `SKILL INTERRUPT` {tank, skill, reason}（repair 被中断，回溯用）

### 5.2 状态聚合优先级（乘法链）

最终受击伤害计算顺序（不可乱序）：
```
finalDamage = baseHitDamage
             × ammoCfg.damageMultiplier      // 弹种(M1)
             × armorDirectionMult             // 方向装甲(现有)
             × (1 - ammoCfg.armorPenetration) // 穿甲(M1,AP)
             × tank.status.damageReduction    // 状态层减伤(M3 armor)
```
机动参数：
```
effectiveMoveSpeed = cfg.moveSpeed × tank.status.moveScale  // 含 boost buff / track debuff
```

### 5.3 调试支持

复用现有 `?debug=1` + TuningPanel：
- 新增调试按钮：`模拟AP直击`、`模拟履带命中`、`满技能CD刷新`
- 周期诊断日志补充：`ammo: AP12/HE8`、`skill: boost(3s)`、`status: track×0.15(8s)`

---

## 6. 开发顺序与验证节点

```
M0  TankStatus 状态聚合层
    └ 验证：注入测试 effect，观察 TankController 驾驶参数变化、到期恢复
    └ 验证：无 effect 时全 scale=1.0（回归零影响）

M1  A1 弹药 AP+HE
    ├ CONFIG weapon.ammoTypes / ammo.maxByType
    ├ Projectile 加 damageType
    ├ WeaponSystem 多弹药库存 + 选弹 + detonate 分发
    ├ DestructionSystem applyDirectHit + onExplosion 加 destructibleMultiplier
    ├ InputSystem/HUD/ResupplySystem
    └ 验证节点：8 项测试用例(2.8)，重点是 AP直击 vs HE溅射 的伤害差异

M2  A2 弱点部位
    ├ 坦克实体挂部位 sensor collider + userData
    ├ IControllableTank 加 partColliders
    ├ DestructionSystem partByCollider 反查 + applyPartDebuff
    ├ applyDirectHit 接入部位判定
    └ 验证节点：8 项测试用例(3.7)，重点履带 debuff 让 NPC 机动失效

M3  A3 主动技能
    ├ IControllableTank 加 heal()
    ├ SkillSystem 新系统
    ├ 玩家输入(E/R/F) + HUD 技能栏
    ├ main 接入
    ├ DirectorSystem 给 veteran NPC 注入 SkillSystem
    ├ NpcController.thinkSkill 决策 + 维修站桩约束
    └ 验证节点：8 项测试用例(4.6)，重点 veteran NPC 战术行为
```

每个里程碑结束的**回归测试**：歼灭战 + 占领军各打一局，确认现有玩法（补给/占领/姿态/NPC 难度梯度）无回归。

---

## 附：关键文件改动清单

| 文件 | M0 | M1 | M2 | M3 |
|------|----|----|----|----|
| `config.ts` | — | weapon.ammoTypes, ammo.maxByType | combat.parts | combat.skills, npcSkill |
| `entities/TankStatus.ts` | **新建** | — | — | — |
| `entities/IControllableTank.ts` | +status | — | +partColliders | +heal() |
| `entities/Projectile.ts` | — | +damageType | — | — |
| `entities/tanks/*` | +status | — | +部位collider | — |
| `systems/TankController.ts` | 读status | — | — | — |
| `systems/WeaponSystem.ts` | — | 多弹药+选弹+分发 | — | — |
| `systems/DestructionSystem.ts` | 读status | +applyDirectHit | +部位反查 | — |
| `systems/SkillSystem.ts` | — | — | — | **新建** |
| `systems/InputSystem.ts` | — | +switchAmmo | — | +skill |
| `systems/ResupplySystem.ts` | — | 分种补给 | — | — |
| `ui/HUD.ts` | — | 弹药三栏 | 部位命中提示 | 技能栏 |
| `ai/NpcController.ts` | — | — | 读status判机动 | +thinkSkill |
| `systems/DirectorSystem.ts` | — | — | — | NPC注SkillSystem |
| `main.ts` | status.update | skill接入 | — | skill接入 |
