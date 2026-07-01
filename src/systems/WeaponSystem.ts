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
    log.info('weapon system ready', { cooldown: `${CONFIG.weapon.fireCooldown}s` });
  }

  update(input: InputState, dt: number): void {
    const tank = this.getActiveTank();

    // 冷却 + 边沿触发开火(按一次打一发)。被击毁后无法开火。
    this.cooldown -= dt;
    const edge = input.fire && !this.prevFire;
    this.prevFire = input.fire;
    if (edge && this.cooldown <= 0 && tank.state === 'intact') {
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

  private fire(tank: IControllableTank): void {
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

    log.info('FIRE', {
      tank: tank.name,
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
