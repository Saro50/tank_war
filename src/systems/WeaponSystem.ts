import { CONFIG, type AmmoType } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import type { IControllableTank } from '../entities/IControllableTank';
import { Projectile } from '../entities/Projectile';
import { Explosion } from '../effects/Explosion';
import { MuzzleFlash } from '../effects/MuzzleFlash';
import type { CameraShake } from '../effects/CameraShake';
import type { InputState } from './InputSystem';
import type { DestructionSystem } from './DestructionSystem';
import { Logger } from '../utils/Logger';

const log = Logger.create('Weapon');

/** 单辆坦克的弹药库存(按弹种独立,浮点:装填平滑累加,开火整发扣减) */
interface AmmoStock {
  ap: number;
  he: number;
}

/**
 * 武器系统
 * ============================================================
 * 职责：开火判定 → 按弹种生成炮弹 → 三层后坐力 → 炮弹寿命/命中管理 → 爆炸。
 *
 * 弹药种类增强(详见 docs/combat-layer-design.md §2):
 *  - 弹药按弹种独立库存(ammoByTank: tankId → {ap,he}),按 tank.id 隔离。
 *  - 选弹状态(selectedByTank: tankId → AmmoType),默认 ap,1/2 键切换。
 *  - 命中按弹种分发:AP→applyDirectHit(直击),HE→onExplosion(AOE)。
 *
 * 后坐力三层(同时触发，叠加层次感)：
 *  1. 车身反向物理冲量 —— 车身被真推后退(物理)
 *  2. 炮管沿炮轴后缩回弹 —— 视觉强化(动画)
 *  3. 相机震动 —— 临场感(镜头)
 *
 * 命中：每帧 drain 碰撞事件，炮弹碰到任何物体即引爆+销毁。
 */
export class WeaponSystem {
  private readonly getActiveTank: () => IControllableTank;
  private readonly physics: PhysicsWorld;
  private readonly render: RenderScene;
  private readonly shake: CameraShake | undefined;
  private readonly destruction: DestructionSystem;

  private projectiles: Projectile[] = [];
  private explosions: Explosion[] = [];
  private muzzleFlashes: MuzzleFlash[] = [];
  private projByCollider = new Map<number, Projectile>();

  private cooldown = 0;
  private prevFire = false;
  /** 每辆坦克独立的后坐量，避免切换坦克时串位 */
  private recoilByTank = new Map<number, number>();

  // —— 弹药(M5 + 弹药种类增强:按弹种独立库存,按坦克隔离) ——
  /** 弹药上限(按弹种,所有坦克统一 CONFIG.ammo.maxByType) */
  private readonly maxByType = CONFIG.ammo.maxByType;
  /** 每辆坦克的弹药库存(按 tank.id 独立,玩家 Tab 切换保留各自弹药;NPC 各自 weapon 实例) */
  private readonly ammoByTank = new Map<number, AmmoStock>();
  /** 每辆坦克当前选弹(默认 ap)。按 tank.id 隔离,切换坦克读各自选弹 */
  private readonly selectedByTank = new Map<number, AmmoType>();
  /** 装填闪光计时(s):resupply 调用时置 0.25,update 递减;>0 表示本帧在装填(HUD 提示用) */
  private resupplyFlash = 0;

  constructor(
    getActiveTank: () => IControllableTank,
    physics: PhysicsWorld,
    render: RenderScene,
    /** 相机震动(玩家开火震屏)。NPC 传 undefined:NPC 开火不震玩家相机 */
    shake: CameraShake | undefined,
    destruction: DestructionSystem,
  ) {
    this.getActiveTank = getActiveTank;
    this.physics = physics;
    this.render = render;
    this.shake = shake;
    this.destruction = destruction;
    log.info('weapon system ready', {
      cooldown: `${CONFIG.weapon.fireCooldown}s`,
      ammo: `AP ${this.maxByType.ap} / HE ${this.maxByType.he}`,
    });
  }

  /**
   * 移除某坦克的弹药/选弹/后坐状态(NPC 被击毁清理时调用)。
   * 避免 tank.id 单调递增导致 WeaponSystem 内部 Map 无限增长。
   */
  removeTank(tankId: number): void {
    this.ammoByTank.delete(tankId);
    this.selectedByTank.delete(tankId);
    this.recoilByTank.delete(tankId);
  }

  /** 取某坦克弹药库存(首次访问按满弹药初始化,惰性,避免构造时不知有哪些 tank) */
  private ammoOf(tank: IControllableTank): AmmoStock {
    const a = this.ammoByTank.get(tank.id);
    if (a === undefined) {
      const full: AmmoStock = { ap: this.maxByType.ap, he: this.maxByType.he };
      this.ammoByTank.set(tank.id, full);
      return full;
    }
    return a;
  }

  update(input: InputState, dt: number): void {
    const tank = this.getActiveTank();

    // 选弹切换(边沿触发:input.switchAmmo 非空表示本帧按下切换键)
    if (input.switchAmmo) this.switchAmmo(input.switchAmmo);

    // 冷却 + 边沿触发开火(按一次打一发)。被击毁后无法开火。
    // 弹药检查:当前选弹>=1 才能开火;空仓不触发也不设冷却。
    this.cooldown -= dt;
    if (this.resupplyFlash > 0) this.resupplyFlash -= dt;
    const edge = input.fire && !this.prevFire;
    this.prevFire = input.fire;
    const type = this.selectedOf(tank);
    if (edge && this.cooldown <= 0 && tank.state === 'intact' && this.ammoOf(tank)[type] >= 1) {
      this.fire(tank, type);
      this.cooldown = CONFIG.weapon.fireCooldown;
    }

    // 炮管回缩动画（绑定当前活性坦克）
    this.updateRecoil(tank);

    // 处理本帧碰撞收集的命中:选部位优先(M2),统一引爆。
    // 必须在超时检测【前】:否则超时帧恰好命中的炮弹会被静默销毁(先 detonate(false) 设
    // alive=false → pending 处理因 !alive 跳过 → 丢失命中)。命中优先于超时。
    for (const p of this.projectiles) {
      if (!p.alive || p.pendingHitHandles.length === 0) continue;
      const handle = this.destruction.pickPartHandle(p.pendingHitHandles);
      p.pendingHitHandles.length = 0;
      this.detonate(p, true, handle);
    }
    // 炮弹寿命(超时静默销毁，不爆炸)
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        const t = p.body.translation();
        const v = p.body.linvel();
        log.warn('炮弹超时未命中', {
          type: p.damageType,
          at: `${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)}`,
          vel: `${v.x.toFixed(0)},${v.y.toFixed(0)},${v.z.toFixed(0)}`,
        });
        this.detonate(p, false);
      }
    }
    this.cleanupProjectiles();

    // 命中检测由 main 统一 drain 分发(weapon.handleCollision)

    // 爆炸更新
    this.updateExplosions(dt);

    // 炮口焰烟更新
    this.updateMuzzleFlashes(dt);
  }

  /** 诊断：当前炮弹/爆炸数 */
  get stats(): { projectiles: number; explosions: number } {
    return { projectiles: this.projectiles.length, explosions: this.explosions.length };
  }

  // ============================================================
  // 弹药接口(基于当前活性坦克)
  // ============================================================

  /** 当前活性坦克当前选弹的弹药数(整数已装好发数;兼容旧调用) */
  getAmmo(): number {
    const tank = this.getActiveTank();
    return Math.floor(this.ammoOf(tank)[this.selectedOf(tank)]);
  }
  /** 当前选弹上限(兼容旧调用) */
  getMaxAmmo(): number {
    return this.maxByType[this.selectedOf(this.getActiveTank())];
  }
  /** 指定弹种弹药数(HUD 三栏显示用) */
  getAmmoByType(type: AmmoType): number {
    return Math.floor(this.ammoOf(this.getActiveTank())[type]);
  }
  /** 指定弹种上限 */
  getMaxByType(type: AmmoType): number {
    return this.maxByType[type];
  }
  /** 所有弹种是否都满(ResupplySystem 判断是否停止补给用) */
  isAmmoFull(): boolean {
    const a = this.ammoOf(this.getActiveTank());
    return a.ap >= this.maxByType.ap && a.he >= this.maxByType.he;
  }
  /** 当前活性坦克是否弹药耗尽(当前选弹不足 1 发) */
  isEmpty(): boolean {
    const tank = this.getActiveTank();
    return this.ammoOf(tank)[this.selectedOf(tank)] < 1;
  }
  /** 当前选弹类型(HUD 高亮 / NPC 决策用) */
  getSelectedAmmo(): AmmoType {
    return this.selectedOf(this.getActiveTank());
  }
  /** 是否正在装填(本帧 resupply 触发,resupplyFlash>0)——HUD 提示用 */
  isResupplying(): boolean {
    return this.resupplyFlash > 0;
  }

  /**
   * 切换当前活性坦克的弹种。
   * 切换不消耗、不冷却(鼓励灵活选弹);同弹种再切无效(避免日志刷屏)。
   */
  switchAmmo(type: AmmoType): void {
    const tank = this.getActiveTank();
    const prev = this.selectedOf(tank);
    if (prev === type) return;
    this.selectedByTank.set(tank.id, type);
    log.info('AMMO SWITCH', { tank: tank.displayName, from: prev, to: type });
  }

  /**
   * 装填补给(由 ResupplySystem 在坦克处于补给点半径内时调用)。
   * 同时按各弹种速率平滑回弹,各自 clamp 到上限;置 resupplyFlash 供 HUD 显示"装填中"。
   */
  resupply(dt: number): void {
    const tank = this.getActiveTank();
    const stock = this.ammoOf(tank);
    const rate = CONFIG.ammo.resupplyRate;
    let changed = false;
    if (stock.ap < this.maxByType.ap) {
      stock.ap = Math.min(this.maxByType.ap, stock.ap + rate.ap * dt);
      changed = true;
    }
    if (stock.he < this.maxByType.he) {
      stock.he = Math.min(this.maxByType.he, stock.he + rate.he * dt);
      changed = true;
    }
    if (changed) {
      this.ammoByTank.set(tank.id, stock);
      this.resupplyFlash = 0.25;
    }
  }

  /** 取某坦克当前选弹(默认 ap) */
  private selectedOf(tank: IControllableTank): AmmoType {
    return this.selectedByTank.get(tank.id) ?? 'ap';
  }

  private fire(tank: IControllableTank, type: AmmoType): void {
    const stock = this.ammoOf(tank);
    if (stock[type] < 1) return; // 该弹种空仓:不发射(防御;update 边沿已挡)
    const cfg = CONFIG.weapon;
    const ammoCfg = cfg.ammoTypes[type];
    const pos = tank.muzzleWorldPosition();
    const dir = tank.muzzleWorldDirection();
    // 炮弹生成位置沿炮口方向前移 0.6m，避免与坦克车身重叠被物理弹飞
    const spawnPos = {
      x: pos.x + dir.x * 0.6,
      y: pos.y + dir.y * 0.6,
      z: pos.z + dir.z * 0.6,
    };

    // 1. 生成炮弹(记录发射者,爆炸时 exclude 防自伤——友伤基础)
    const proj = new Projectile(this.physics, this.render, spawnPos, dir, type);
    proj.ownerTank = tank;
    this.projectiles.push(proj);
    this.projByCollider.set(proj.colliderHandle, proj);

    // 2. 车身反向冲量(只取水平分量，避免抬车/扎地)。后坐力按弹种动量(mass×vel)
    const J = ammoCfg.mass * ammoCfg.muzzleVelocity * cfg.recoil.bodyImpulseScale;
    const hLen = Math.hypot(dir.x, dir.z) || 1;
    tank.body.applyImpulse(
      { x: (-dir.x / hLen) * J, y: 0, z: (-dir.z / hLen) * J },
      true,
    );

    // 3. 炮口焰 + 烟雾(视觉，开火瞬间生成于炮口)
    this.muzzleFlashes.push(new MuzzleFlash(this.render, pos, dir));

    // 4. 炮管后缩
    this.recoilByTank.set(tank.id, -cfg.recoil.barrelBack);

    // 5. 相机震动(玩家开火;NPC weapon 无 shake,不震)
    this.shake?.add(0.8);

    // 6. 弹药消耗(扣对应弹种,按坦克独立计)
    stock[type] -= 1;
    this.ammoByTank.set(tank.id, stock);

    log.info('FIRE', {
      tank: tank.displayName,
      type,
      ammo: `AP ${Math.floor(stock.ap)}/HE ${Math.floor(stock.he)}`,
      muzzle: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
      impulse: J.toFixed(0),
    });
  }

  private updateRecoil(tank: IControllableTank): void {
    const cfg = CONFIG.weapon.recoil;
    let recoil = this.recoilByTank.get(tank.id) ?? 0;
    recoil = lerp(recoil, 0, cfg.barrelRecoverLerp);
    if (Math.abs(recoil) < 0.001) {
      this.recoilByTank.delete(tank.id);
      recoil = 0;
    } else {
      this.recoilByTank.set(tank.id, recoil);
    }
    tank.barrel.position.z = tank.barrelBaseZ + recoil;
  }

  /**
   * 引爆：alive 置 false，按弹种分发命中结算 + 生成爆炸特效。
   * ------------------------------------------------------------
   * AP → applyDirectHit(直击:按命中 collider 反查部位,M2 部位优先由 update 选好 handle 传入)
   * HE → onExplosion(AOE:复用现有范围伤害,放大半径 + 可破坏物倍率)
   * exclude 用炮弹记录的发射者(ownerTank)防自伤——友伤基础。
   *
   * @param hitHandle AP 直击命中的 collider handle(由 pickPartHandle 选部位优先);
   *                  HE/超时不传(HE 走 AOE 无视 collider)。
   */
  private detonate(p: Projectile, explode: boolean, hitHandle?: number): void {
    if (!p.alive) return;
    p.alive = false;
    if (!explode) return;
    const t = p.body.translation();
    this.explosions.push(new Explosion(this.render, t));

    if (p.damageType === 'he') {
      // HE:AOE,完全复用现有 onExplosion,放大半径 + 可破坏物伤害倍率
      const he = CONFIG.weapon.ammoTypes.he;
      this.destruction.onExplosion(
        t,
        CONFIG.destruction.explosionRadius * he.explosionRadiusMultiplier,
        p.ownerTank,
        he.destructibleMultiplier,
      );
    } else {
      // AP:直击,需命中 collider 反查目标 + 部位。handle 由 update 经 pickPartHandle 选好。
      const ap = CONFIG.weapon.ammoTypes.ap;
      if (hitHandle !== undefined) {
        this.destruction.applyDirectHit(t, hitHandle, p.ownerTank, ap);
      }
    }
    log.info('HIT', {
      type: p.damageType,
      at: `${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)}`,
      owner: p.ownerTank?.displayName ?? 'none',
    });
  }

  /**
   * 碰撞分发回调(由 main 统一 drain 调用)：收集命中 collider,不立即引爆。
   * ------------------------------------------------------------
   * 一帧内炮弹可能同时接触主 collider + 多个部位 sensor(逐事件上报)。
   * 立即引爆会让主 collider(外表面)总先触发,部位 collider 失效。
   * 故本方法只把被击 handle 收集到 Projectile.pendingHitHandles,
   * 由 update 调 pickPartHandle 选部位优先后统一引爆。
   */
  handleCollision(h1: number, h2: number): void {
    const p = this.projByCollider.get(h1) ?? this.projByCollider.get(h2);
    if (!p?.alive) return;
    // 被击方 = 非炮弹的那个 handle(h1/h2 中不属于本炮弹 collider 的那个)
    p.pendingHitHandles.push(this.projByCollider.has(h1) ? h2 : h1);
  }

  private cleanupProjectiles(): void {
    this.projectiles = this.projectiles.filter((p) => {
      if (p.alive) return true;
      this.projByCollider.delete(p.colliderHandle);
      p.dispose(this.physics, this.render);
      return false;
    });
  }

  private updateExplosions(dt: number): void {
    this.explosions = this.explosions.filter((e) => {
      if (e.update(dt)) return true;
      e.dispose(this.render);
      return false;
    });
  }

  private updateMuzzleFlashes(dt: number): void {
    this.muzzleFlashes = this.muzzleFlashes.filter((f) => {
      if (f.update(dt)) return true;
      f.dispose(this.render);
      return false;
    });
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
