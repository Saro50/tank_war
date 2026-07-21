import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { SoundHooks } from '../audio/SoundSystem';
import { Logger } from '../utils/Logger';

const log = Logger.create('Skill');

/** 技能标识(三槽:机动/防御/侦查) */
export type SkillId = 'boost' | 'armor' | 'scout';

/** 单技能运行时状态 */
interface SkillState {
  /** 剩余冷却(s,>0 不可再用) */
  cooldown: number;
  /** 剩余激活时长(s,>0 正在生效) */
  active: number;
}

const SKILL_IDS: readonly SkillId[] = ['boost', 'armor', 'scout'];

/**
 * 主动技能系统
 * ============================================================
 * 管理三个技能槽(引擎过载/装甲倾斜/侦查)的冷却/激活/失效。
 * 激活时给 tank.status 注入对应 effect(M0 状态层统一聚合),
 * TankController/DestructionSystem/FogOfWarSystem 读 status 系数自动生效——
 * 本系统不直接改 cfg,与部位 debuff、未来其它 buff 走同一聚合层,互不覆盖。
 *
 * 实例化策略:
 *  - 玩家一份(main 创建,getActiveTank=switcher.activeTank);
 *  - 每辆 veteran NPC 一份(director 创建,getActiveTank=该 NPC 固定);
 *  - rookie/regular NPC 不持有(平衡性:低阶 NPC 仍纯机械 AI)。
 *  按 tank.id 隔离技能状态(玩家 Tab 切换保留各自冷却)。
 *
 * 技能生效路径:三个都是【一次性】apply effect 到 status,到期由 status.update 自动清。
 *              active 计时仅用于 HUD 显示"生效中",本系统 update 不需再 tick。
 *              维修已移至补给点(驶入自动回血),不再作为技能。
 */
export class SkillSystem {
  /** 每辆坦克的技能状态(按 tank.id 隔离) */
  private readonly statesByTank = new Map<number, Record<SkillId, SkillState>>();
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
        boost: { cooldown: 0, active: 0 },
        armor: { cooldown: 0, active: 0 },
        scout: { cooldown: 0, active: 0 },
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
    // 三个技能都一次性注入 status effect(到期 status 自动清),本系统不 tick
    if (id === 'boost') {
      const cfg = CONFIG.combat.skills.boost;
      tank.status.apply({ id: 'boost', remaining: cfg.duration, moveScale: cfg.moveScale, turnScale: cfg.turnScale });
      // 音效:引擎过载激活 → 玩家语音03(全速前进)
      this.sound?.onBoostActivate(tank);
    } else if (id === 'armor') {
      const cfg = CONFIG.combat.skills.armor;
      tank.status.apply({ id: 'armor', remaining: cfg.duration, damageReduction: cfg.damageReduction });
    } else {
      // scout:注入视野倍率,FogOfWarSystem 读 tank.status.sightScale 临时扩大视野
      const cfg = CONFIG.combat.skills.scout;
      tank.status.apply({ id: 'scout', remaining: cfg.duration, sightScale: cfg.sightScale });
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
        // 三技能均一次性注入 status,无需每帧 tick(与原 repair 不同)
        if (s.active <= 0) {
          s.active = 0;
          log.info('SKILL EXPIRE', { tank: tank.displayName, skill: id });
        }
      }
    }
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
