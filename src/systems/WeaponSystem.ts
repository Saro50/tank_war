import { CONFIG } from '../config';
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

/**
 * 武器系统
 * ============================================================
 * 职责：开火判定 → 生成炮弹 → 三层后坐力 → 炮弹寿命/命中管理 → 爆炸。
 *
 * 现在绑定“当前活性坦克”提供者，支持多坦克切换控制。
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

  // —— 弹药(M5:炮弹总量限制,按坦克独立计) ——
  /** 弹药上限(所有坦克统一 CONFIG.ammo.maxAmmo) */
  private readonly maxAmmo: number;
  /** 每辆坦克的弹药量(按 tank.id 独立,与 recoilByTank 同模式)。
   *  玩家 Tab 切换坦克后,各坦克保留各自弹药;NPC 各自 weapon 实例只有一个条目。
   *  浮点:装填按速率平滑累加;开火以整发为单位扣减(fire 检查 ammo>=1)。 */
  private readonly ammoByTank = new Map<number, number>();
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
    this.maxAmmo = CONFIG.ammo.maxAmmo;
    log.info('weapon system ready', { cooldown: `${CONFIG.weapon.fireCooldown}s`, ammo: this.maxAmmo });
  }

  /** 取某坦克当前弹药(浮点);首次访问按满弹药初始化(惰性,避免构造时不知有哪些 tank) */
  private ammoOf(tank: IControllableTank): number {
    const a = this.ammoByTank.get(tank.id);
    if (a === undefined) {
      this.ammoByTank.set(tank.id, this.maxAmmo);
      return this.maxAmmo;
    }
    return a;
  }

  update(input: InputState, dt: number): void {
    const tank = this.getActiveTank();

    // 冷却 + 边沿触发开火(按一次打一发)。被击毁后无法开火。
    // 弹药检查:ammo>=1 才能开火;空仓时不触发 fire 也不设冷却(避免空仓误占冷却)。
    this.cooldown -= dt;
    if (this.resupplyFlash > 0) this.resupplyFlash -= dt;
    const edge = input.fire && !this.prevFire;
    this.prevFire = input.fire;
    if (edge && this.cooldown <= 0 && tank.state === 'intact' && this.ammoOf(tank) >= 1) {
      this.fire(tank);
      this.cooldown = CONFIG.weapon.fireCooldown;
    }

    // 炮管回缩动画（绑定当前活性坦克）
    this.updateRecoil(tank);

    // 炮弹寿命(超时静默销毁，不爆炸)
    for (const p of this.projectiles) {
      if (!p.alive) continue;
      p.life -= dt;
      if (p.life <= 0) {
        const t = p.body.translation();
        const v = p.body.linvel();
        log.warn('炮弹超时未命中', {
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

  // —— 弹药接口(M5,基于当前活性坦克) ——
  /** 当前活性坦克的弹药数(整数已装好发数;内部浮点,装填平滑累加) */
  getAmmo(): number {
    return Math.floor(this.ammoOf(this.getActiveTank()));
  }
  /** 弹药上限 */
  getMaxAmmo(): number {
    return this.maxAmmo;
  }
  /** 当前活性坦克弹药是否耗尽(不足 1 发) */
  isEmpty(): boolean {
    return this.ammoOf(this.getActiveTank()) < 1;
  }
  /** 是否正在装填(本帧 resupply 触发,resupplyFlash>0)——HUD 提示用 */
  isResupplying(): boolean {
    return this.resupplyFlash > 0;
  }
  /**
   * 装填补给(由 ResupplySystem 在坦克处于补给点半径内时调用)。
   * 给当前活性坦克按速率平滑回弹,clamp 到上限;置 resupplyFlash 供 HUD 显示"装填中"。
   * 依赖 weapon.activeTank == ResupplySystem 注册的 tank 的一致性(玩家/NPC 均成立)。
   */
  resupply(dt: number): void {
    const tank = this.getActiveTank();
    const cur = this.ammoOf(tank);
    if (cur >= this.maxAmmo) return;
    this.ammoByTank.set(tank.id, Math.min(this.maxAmmo, cur + CONFIG.ammo.resupplyRate * dt));
    this.resupplyFlash = 0.25;
  }

  private fire(tank: IControllableTank): void {
    if (this.ammoOf(tank) < 1) return; // 弹药耗尽:空仓不发射(防御;update 边沿已挡)
    const cfg = CONFIG.weapon;
    const pos = tank.muzzleWorldPosition();
    const dir = tank.muzzleWorldDirection();
    // 炮弹生成位置沿炮口方向前移 0.6m，避免与坦克车身重叠被物理弹飞
    const spawnPos = {
      x: pos.x + dir.x * 0.6,
      y: pos.y + dir.y * 0.6,
      z: pos.z + dir.z * 0.6,
    };

    // 1. 生成炮弹(记录发射者,爆炸时 exclude 防自伤——友伤基础)
    const proj = new Projectile(this.physics, this.render, spawnPos, dir);
    proj.ownerTank = tank;
    this.projectiles.push(proj);
    this.projByCollider.set(proj.colliderHandle, proj);

    // 2. 车身反向冲量(只取水平分量，避免抬车/扎地)
    const J =
      cfg.projectile.mass * cfg.projectile.muzzleVelocity * cfg.recoil.bodyImpulseScale;
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

    // 6. 弹药消耗(M5:开火扣 1 发,按坦克独立计)
    this.ammoByTank.set(tank.id, this.ammoOf(tank) - 1);

    log.info('FIRE', {
      tank: tank.name,
      ammo: `${Math.floor(this.ammoOf(tank))}/${this.maxAmmo}`,
      muzzle: `${pos.x.toFixed(1)},${pos.y.toFixed(1)},${pos.z.toFixed(1)}`,
      dir: `${dir.x.toFixed(2)},${dir.y.toFixed(2)},${dir.z.toFixed(2)}`,
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
   * 引爆：alive 置 false，可选生成爆炸特效。
   * exclude 用炮弹记录的发射者(ownerTank)防自伤——这是友伤的基础:
   * 爆炸伤害所有坦克(含同阵营),只跳过发射者本人。
   */
  private detonate(p: Projectile, explode: boolean): void {
    if (!p.alive) return;
    p.alive = false;
    if (explode) {
      const t = p.body.translation();
      this.explosions.push(new Explosion(this.render, t));
      // 通知破坏系统:爆炸半径内可破坏物触发破碎。exclude 发射者防自伤。
      this.destruction.onExplosion(t, CONFIG.destruction.explosionRadius, p.ownerTank);
      log.info('HIT', {
        at: `${t.x.toFixed(1)},${t.y.toFixed(1)},${t.z.toFixed(1)}`,
        owner: p.ownerTank?.displayName ?? 'none',
      });
    }
  }

  /** 碰撞分发回调(由 main 统一 drain 调用)：检测炮弹命中 → 引爆。多实例各自管自己的炮弹 */
  handleCollision(h1: number, h2: number): void {
    const p = this.projByCollider.get(h1) ?? this.projByCollider.get(h2);
    if (p && p.alive) this.detonate(p, true);
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
