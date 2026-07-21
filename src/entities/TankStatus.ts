import { Logger } from '../utils/Logger';

const log = Logger.create('TankStatus');

/**
 * 坦克部位标签(M2 弱点部位瞄准)。
 * ------------------------------------------------------------
 * 挂在坦克部位 collider 的 userData 上,AP 直击时据此判定命中部位并注入 debuff。
 *  hull     车体(主 collider)——走方向装甲,无额外 debuff
 *  turret   炮塔 sensor       ——命中后炮塔转速 debuff
 *  track    履带 sensor(左右) ——命中后机动 debuff
 *  ammoRack 弹药架(本期不做,用户已定无殉爆秒杀;留类型供未来扩展)
 */
export type TankPart = 'hull' | 'turret' | 'track' | 'ammoRack';

/**
 * 临时状态效果(注入 TankStatus.effects,到期自动清除)
 * ------------------------------------------------------------
 * 每个 effect 修改坦克的某个运行参数(机动/炮塔转速/受击减伤)。
 * 同 id 的 effect 后注入覆盖前者(防连击无限叠加:履带连打只续期不翻倍)。
 *
 * 设计为可选字段:不提供的字段缺省视为 1.0(不影响该参数)。
 * 这样部位 debuff 只填 moveScale/turnScale,技能 buff 只填各自字段,互不干扰。
 */
export interface TimedEffect {
  /** 唯一标识(同 id 新覆盖旧,防叠加)。如 'track-dmg' / 'boost' / 'armor' */
  id: string;
  /** 剩余秒数(update 递减,<=0 自动移除) */
  remaining: number;
  /** 移动速度系数(乘到 cfg.moveSpeed)。缺省=1(不影响) */
  moveScale?: number;
  /** 转向速度系数(乘到 cfg.turnSpeed)。缺省=1 */
  turnScale?: number;
  /** 炮塔转速系数(乘到 cfg.turret.turnSpeed)。缺省=1 */
  turretScale?: number;
  /** 受击伤害系数(乘到最终伤害,0.6=减伤40%)。缺省=1 */
  damageReduction?: number;
  /**
   * 视野半径系数(乘到 sightRadius,1.5=视野扩大50%)。缺省=1。
   * 侦查技能(⇧~)注入,FogOfWarSystem 读取以临时扩大视野范围。
   */
  sightScale?: number;
}

/**
 * 坦克运行时状态聚合层
 * ============================================================
 * 所有"会临时改变机动/受击参数"的状态(履带 debuff / 引擎过载 buff / 装甲倾斜减伤)
 * 统一在此聚合。TankController / DestructionSystem 只读最终系数,
 * 任何系统都不直接改 cfg.moveSpeed——避免多源修改互相覆盖。
 *
 * 设计要点:
 *  - effect 列表驱动:apply 注入(同 id 覆盖),update 递减 remaining 到期移除;
 *  - 系数用 getter 实时聚合(遍历 effect 乘法叠加),无需手动重算;
 *  - 乘法叠加保证多源共存合理(履带0.15 × 过载1.5 = 0.225,debuff 与 buff 自然抵消)。
 *
 * 上下游影响(改动一处,全链路生效):
 *  - TankController.applyDrive 读 moveScale/turnScale → 决定实际车速/转向;
 *  - TankController.applyAim  读 turretScale        → 决定炮塔转速;
 *  - DestructionSystem 受击分支读 damageReduction    → 决定最终伤害。
 *  任一系统注入 effect 都经此聚合,互不覆盖。
 */
export class TankStatus {
  private effects: TimedEffect[] = [];

  /**
   * 注入/刷新效果。
   * 同 id 的旧 effect 先移除再 push 新的(覆盖语义):
   *  - 履带连打只续期 remaining,不让 debuff 累乘到 ×0.15²;
   *  - 引擎过载激活中再次触发只续时长,不叠加速率。
   */
  apply(e: TimedEffect): void {
    this.effects = this.effects.filter((x) => x.id !== e.id);
    this.effects.push(e);
    log.debug('effect apply', { id: e.id, remaining: e.remaining.toFixed(1) });
  }

  /** 每帧递减所有 effect 剩余时间,到期移除。由 TankBase.update 统一调用。 */
  update(dt: number): void {
    if (this.effects.length === 0) return;
    let expired = false;
    for (const e of this.effects) {
      e.remaining -= dt;
      if (e.remaining <= 0) expired = true;
    }
    if (expired) {
      this.effects = this.effects.filter((e) => {
        if (e.remaining <= 0) {
          log.debug('effect expire', { id: e.id });
          return false;
        }
        return true;
      });
    }
  }

  /** 移动速度系数(所有 moveScale 乘法叠加,无 effect=1.0) */
  get moveScale(): number {
    let s = 1;
    for (const e of this.effects) if (e.moveScale !== undefined) s *= e.moveScale;
    return s;
  }

  /** 转向速度系数(同上) */
  get turnScale(): number {
    let s = 1;
    for (const e of this.effects) if (e.turnScale !== undefined) s *= e.turnScale;
    return s;
  }

  /** 炮塔转速系数(同上) */
  get turretScale(): number {
    let s = 1;
    for (const e of this.effects) if (e.turretScale !== undefined) s *= e.turretScale;
    return s;
  }

  /** 受击伤害系数(0.6=减伤40%;多个减伤源乘法叠加,无 effect=1.0) */
  get damageReduction(): number {
    let s = 1;
    for (const e of this.effects) if (e.damageReduction !== undefined) s *= e.damageReduction;
    return s;
  }

  /** 视野半径系数(侦查技能用;多个源乘法叠加,无 effect=1.0) */
  get sightScale(): number {
    let s = 1;
    for (const e of this.effects) if (e.sightScale !== undefined) s *= e.sightScale;
    return s;
  }

  /** 某效果是否正在生效(视觉层查询用:技能特效显隐) */
  hasEffect(id: string): boolean {
    return this.effects.some((e) => e.id === id);
  }

  /** 谋试用:当前激活效果摘要,如 "track-dmg:move×0.15,turn×0.15(8.2s);boost:move×1.5(3.1s)" */
  get debugSummary(): string {
    if (this.effects.length === 0) return '';
    return this.effects
      .map((e) => {
        const parts: string[] = [];
        if (e.moveScale !== undefined) parts.push(`move×${e.moveScale}`);
        if (e.turnScale !== undefined) parts.push(`turn×${e.turnScale}`);
        if (e.turretScale !== undefined) parts.push(`turret×${e.turretScale}`);
        if (e.damageReduction !== undefined) parts.push(`dmg×${e.damageReduction}`);
        if (e.sightScale !== undefined) parts.push(`sight×${e.sightScale}`);
        parts.push(`(${e.remaining.toFixed(1)}s)`);
        return `${e.id}:${parts.join(',')}`;
      })
      .join(';');
  }
}
