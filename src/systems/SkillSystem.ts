import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { SoundHooks } from '../audio/SoundSystem';
import { Logger } from '../utils/Logger';

const log = Logger.create('Skill');

/** 技能标识(三槽:续航/机动/防御) */
export type SkillId = 'repair' | 'boost' | 'armor';

/** 单技能运行时状态 */
interface SkillState {
  /** 剩余冷却(s,>0 不可再用) */
  cooldown: number;
  /** 剩余激活时长(s,>0 正在生效) */
  active: number;
}

const SKILL_IDS: readonly SkillId[] = ['repair', 'boost', 'armor'];

/**
 * 主动技能系统(M3)
 * ============================================================
 * 管理三个技能槽(维修/引擎过载/装甲倾斜)的冷却/激活/失效。
 * 激活时给 tank.status 注入对应 effect(M0 状态层统一聚合),
 * TankController/DestructionSystem 读 status 系数自动生效——本系统不直接改 cfg,
 * 与部位 debuff、未来其它 buff 走同一聚合层,互不覆盖。
 *
 * 实例化策略:
 *  - 玩家一份(main 创建,getActiveTank=switcher.activeTank);
 *  - 每辆 veteran NPC 一份(director 创建,getActiveTank=该 NPC 固定);
 *  - rookie/regular NPC 不持有(平衡性:低阶 NPC 仍纯机械 AI)。
 *  按 tank.id 隔离技能状态(玩家 Tab 切换保留各自冷却)。
 *
 * 技能生效路径差异:
 *  - boost/armor:激活时【一次性】apply effect 到 status,到期由 status.update 自动清。
 *                 active 计时仅用于 HUD 显示"生效中",本系统 update 不需再 tick。
 *  - repair:不注入 status(它是回血不是 buff)。激活期间每帧 tickRepair 回血 + 速度中断检测
 *            (站桩 3s 回 30HP;移动超 castMaxSpeed 则中止,已回血保留,惩罚乱用)。
 */
export class SkillSystem {
  /** 每辆坦克的技能状态(按 tank.id 隔离) */
  private readonly statesByTank = new Map<number, Record<SkillId, SkillState>>();
  /** repair 已回血累计(中断日志/调试用) */
  private readonly repairHealedByTank = new Map<number, number>();
  /** 音效钩子(可选:boost 激活时触发玩家语音03) */
  private sound?: SoundHooks;

  constructor(private readonly getActiveTank: () => IControllableTank) {}

  /** 注入音效钩子(boost 激活时触发玩家语音03) */
  setSoundHooks(s: SoundHooks): void {
    this.sound = s;
  }

  /** 取某坦克技能状态(惰性初始化全冷却完毕) */
  private statesOf(tank: IControllableTank): Record<SkillId, SkillState> {
    let s = this.statesByTank.get(tank.id);
    if (!s) {
      s = {
        repair: { cooldown: 0, active: 0 },
        boost: { cooldown: 0, active: 0 },
        armor: { cooldown: 0, active: 0 },
      };
      this.statesByTank.set(tank.id, s);
    }
    return s;
  }

  /**
   * 尝试激活技能。CD 中/已激活/坦克非 intact 则失败(幂等,可高频调用)。
   * @returns 是否成功激活(日志/HUD/NPC 决策反馈用)
   */
  tryActivate(id: SkillId): boolean {
    const tank = this.getActiveTank();
    if (tank.state !== 'intact') return false;
    const s = this.statesOf(tank)[id];
    if (s.cooldown > 0 || s.active > 0) return false;
    // cooldown/duration 三技能都有,联合类型安全访问
    s.cooldown = CONFIG.combat.skills[id].cooldown;
    s.active = CONFIG.combat.skills[id].duration;
    // boost/armor:一次性注入 status effect(到期 status 自动清);repair 不注入
    if (id === 'boost') {
      const cfg = CONFIG.combat.skills.boost;
      tank.status.apply({ id: 'boost', remaining: cfg.duration, moveScale: cfg.moveScale, turnScale: cfg.turnScale });
      // 音效:引擎过载激活 → 玩家语音03(全速前进)
      this.sound?.onBoostActivate(tank);
    } else if (id === 'armor') {
      const cfg = CONFIG.combat.skills.armor;
      tank.status.apply({ id: 'armor', remaining: cfg.duration, damageReduction: cfg.damageReduction });
    } else {
      // repair:重置已回血累计,tickRepair 每帧回血
      this.repairHealedByTank.set(tank.id, 0);
    }
    log.info('SKILL', { tank: tank.displayName, skill: id });
    return true;
  }

  /**
   * 每帧推进:cooldown/active 递减 + repair tick(回血+中断检测)。
   * 由 main(玩家)/NpcController.postStep(veteran NPC)在 step 后调用。
   */
  update(dt: number): void {
    const tank = this.getActiveTank();
    if (tank.state !== 'intact') {
      this.clearActive(tank); // 被击毁:清激活(status 自然失效),冷却保留(无所谓)
      return;
    }
    const states = this.statesOf(tank);
    for (const id of SKILL_IDS) {
      const s = states[id];
      if (s.cooldown > 0) s.cooldown = Math.max(0, s.cooldown - dt);
      if (s.active > 0) {
        s.active -= dt;
        if (id === 'repair') this.tickRepair(tank, dt, s);
        if (s.active <= 0) {
          s.active = 0;
          log.info('SKILL EXPIRE', { tank: tank.displayName, skill: id });
        }
      }
    }
  }

  /**
   * repair 每帧 tick:回血 + 速度中断检测。
   * 速度超 castMaxSpeed → 中止 active(冷却照常走,惩罚乱用;已回血保留)。
   * 这样维修期间是靶子,玩家可趁机绕侧——这是 veteran 维修的战术破绽,平衡其技能优势。
   */
  private tickRepair(tank: IControllableTank, dt: number, s: SkillState): void {
    const cfg = CONFIG.combat.skills.repair;
    const v = tank.body.linvel();
    const speed = Math.hypot(v.x, v.z);
    if (speed > cfg.castMaxSpeed) {
      s.active = 0;
      const healed = this.repairHealedByTank.get(tank.id) ?? 0;
      log.info('SKILL INTERRUPT', { tank: tank.displayName, skill: 'repair', reason: 'moved', healed: healed.toFixed(0) });
      return;
    }
    const rate = cfg.healTotal / cfg.duration;
    tank.heal(rate * dt);
    this.repairHealedByTank.set(tank.id, (this.repairHealedByTank.get(tank.id) ?? 0) + rate * dt);
  }

  /** 清空某坦克所有激活状态(被击毁时;status 效果自然到期) */
  private clearActive(tank: IControllableTank): void {
    const states = this.statesByTank.get(tank.id);
    if (!states) return;
    for (const id of SKILL_IDS) states[id].active = 0;
  }

  // —— HUD/NPC 查询接口 ——
  /** 某技能冷却进度(0=刚释放,1=可用)。HUD 冷却环用 */
  cooldownRatio(id: SkillId): number {
    const tank = this.getActiveTank();
    const s = this.statesOf(tank)[id];
    const max = CONFIG.combat.skills[id].cooldown;
    return s.cooldown <= 0 ? 1 : 1 - s.cooldown / max;
  }

  /** 某技能是否生效中(HUD 高亮 / NPC 维修站桩判定用) */
  isActive(id: SkillId): boolean {
    return this.statesOf(this.getActiveTank())[id].active > 0;
  }
}
