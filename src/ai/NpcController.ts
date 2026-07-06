import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { TankController } from '../systems/TankController';
import type { WeaponSystem } from '../systems/WeaponSystem';
import type { ResupplySystem } from '../systems/ResupplySystem';
import type { SkillSystem } from '../systems/SkillSystem';
import type { InputState } from '../systems/InputSystem';
import { findNearestEnemy, hasLineOfSight } from './perception';
import { Logger } from '../utils/Logger';

const log = Logger.create('Npc');

/** NPC 巡逻任务(由 DirectorSystem 分配,对应未来 LLM 的 assignPatrol 工具) */
export interface NpcMission {
  type: 'patrol';
  waypoints: { x: number; z: number }[];
}

/** NPC 难度档位(对应 CONFIG.npcTiers 的键)。
 *  类型定义已移至 config.ts(共享层),此处 re-export 保持 director 现有 import 路径不变。 */
export type { NpcTier } from '../config';

/** 导演姿态(全阵营,由 DirectorSystem 评估):NPC 据此修饰行为参数实现集体智能 */
export type Posture = 'aggro' | 'normal' | 'defensive';

/**
 * NPC 差异化行为参数(随难度变化的部分)
 * ------------------------------------------------------------
 * 与 CONFIG.npc(通用参数)分离:通用参数(scanInterval/retreat/避障等)所有档位共享,
 * 本接口只含"随难度变化"的字段,由 CONFIG.npcTiers 按档位注入,实例级生效。
 * 这样 DifficultySystem 可逐 NPC 调难度,而不影响全局通用行为。
 */
export interface NpcProfile {
  /** 档位中文名(日志/HUD 用) */
  name: string;
  /** 瞄准锁定秒:炮塔+炮管持续收敛达此秒数才允许开火(本需求核心旋钮) */
  aimTime: number;
  /** 水平瞄准收敛阈值(rad),越小要求越准 */
  aimTolerance: number;
  /** 水平瞄准散布(rad,慢速随机游走),产生命中率梯度 */
  aimNoise: number;
  /** 发现目标后"反应过来"才开始蓄瞄的延迟(s) */
  reactionTime: number;
  /** 开火射程(m) */
  fireRange: number;
  /** 感知半径(m) */
  sightRange: number;
}

/**
 * 按档位解析 NPC 行为参数。
 * 档位缺失/非法 → 回退 regular(老兵),避免旧配置无 tier 时过弱或过强。
 */
export function resolveNpcProfile(tier?: string): NpcProfile {
  const tiers = CONFIG.npcTiers;
  if (tier === 'rookie') return tiers.rookie;
  if (tier === 'veteran') return tiers.veteran;
  return tiers.regular;
}

type NpcState = 'patrol' | 'approach' | 'engage' | 'retreat' | 'resupply';

const EMPTY_INPUT: InputState = {
  forward: 0,
  turn: 0,
  turretDir: 0,
  barrelDir: 0,
  fire: false,
  switchNext: false,
  switchAmmo: null,
  skill: null,
  mouseX: 0,
  mouseY: 0,
};

/**
 * NPC 坦克控制器(机械 AI,确定性,无 LLM)
 * ============================================================
 * 职责分层:
 *  - L1/L2 决策:FSM(patrol/approach/engage/retreat)——未来可被 LLM 导演替换
 *  - L3 反射:瞄准/开火时机/机动——确定性规则,保留
 *  - L4 执行:复用 TankController(applyDrive/applyAim),构造虚拟 InputState
 *
 * 友伤:不在此处理。伤害系统层面已对所有坦克生效(除发射者),
 *       NPC 见敌就打,可能误伤同阵营队友(符合友伤玩法设定)。
 *
 * 时序(主循环保证):
 *  - preStep(dt):  FSM 决策 → 产虚拟 InputState → controller.applyDrive  (step 前)
 *  - postStep(dt): controller.applyAim + weapon.update                   (step 后)
 *
 * 开火脉冲:WeaponSystem 用边沿触发(按一次打一发),故 NPC 不能持续 fire=true。
 *          本控制器自管 fireCooldown,满足条件时输出 true 一帧触发边沿,与武器冷却同步。
 */
export class NpcController {
  private state: NpcState = 'patrol';
  /** 玩家附身本 NPC 时暂停 AI(debug Tab 切到 NPC),避免与玩家双重控制。DirectorSystem 设。 */
  paused = false;
  private mission?: NpcMission;
  private missionWpIdx = 0;
  private target?: IControllableTank;
  private scanTimer = 0;
  private loseTimer = 0; // 视野丢失但记忆中还有 target 的累计时间(超 loseTargetTime 放弃)
  private fireCooldown = 0; // NPC 自管开火脉冲冷却(适配 WeaponSystem 边沿触发)
  private targetVisible = false; // 本次 scan 是否在视野内看到目标(区分"记忆目标"与"当前可见")
  private retreatTimer = 0; // retreat 持续时间(超 retreatMaxTime 强制脱离,无回血避免无限后退)
  private stuckTimer = 0; // 卡住累计:想前进但速度低,超 0.4s 触发脱困
  private unstuckTimer = 0; // 脱困(后退)剩余时间:触发后到期恢复正常前进
  private unstuckDir = 0; // 脱困固定转向侧(±1,触发时随机),避免左右横跳转不开

  // —— 瞄准系统状态(本需求新增) ——
  /** 瞄准锁定累计(s):炮塔+炮管持续收敛且目标可见时累计,达 profile.aimTime 才可开火;
   *  脱靶时快速衰减(×2),避免"曾对准就能打"的取巧。开火后归零,下一发重新蓄瞄。 */
  private aimTimer = 0;
  /** 目标可见累计(s):达 profile.reactionTime 才算"反应过来"开始蓄瞄。弱 NPC 反应慢。 */
  private spotTimer = 0;
  /** 当前水平瞄准散布(rad):慢速随机游走,叠加在目标方位上产生命中率差异。
   *  每 0.3s 或开火后重 roll 一个 [-aimNoise, aimNoise] 内的新值。 */
  private aimNoiseOffset = 0;
  /** 散布重 roll 计时(到期触发 aimNoiseOffset 换新值) */
  private aimNoiseTimer = 0;

  /** 创建时满血,作 retreat 阈值基准(接口无 maxHp,创建时快照) */
  private readonly maxHp: number;
  /** driveToward/away 算出的转向(-1..1),供 produceInput 取用 */
  private lastTurn = 0;
  /** 绕侧/侧撤的固定偏好方向(±1,构造时随机):让各 NPC 机动方向多样化,避免整齐划一 */
  private readonly orbitSign: number;
  /** driveToward 本帧是否在避障(调用者据此降速,避免高速绕障撞墙) */
  private avoiding = false;
  /** 当前决策产出的虚拟输入(preStep 算好,applyDrive/applyAim/weapon 共用) */
  private input: InputState = { ...EMPTY_INPUT };

  constructor(
    private readonly tank: IControllableTank,
    private readonly controller: TankController,
    private readonly weapon: WeaponSystem,
    private readonly enemies: () => IControllableTank[],
    private readonly physics: PhysicsWorld,
    /** 本 NPC 的难度参数(按档位注入,实例级生效,不影响其他 NPC) */
    private readonly profile: NpcProfile,
    /** 补给系统(NPC 弹药耗尽时导航去最近补给点装填) */
    private readonly resupply: ResupplySystem,
    /** 导演姿态访问器:NPC 据此修饰反应/蓄瞄/撤退参数,实现集体智能(aggro/normal/defensive) */
    private readonly getPosture: () => Posture,
    /** 技能系统(M3 仅 veteran 注入;rookie/regular 为 undefined → 不决策技能,保持纯机械 AI) */
    private readonly skill?: SkillSystem,
  ) {
    this.maxHp = tank.getHp();
    this.orbitSign = Math.random() < 0.5 ? -1 : 1; // 随机偏好绕侧/侧撤方向
    log.info('npc ready', { tank: tank.displayName, tier: profile.name, hasSkill: !!skill });
  }

  /** 导演分配巡逻任务 */
  setMission(m: NpcMission): void {
    this.mission = m;
    this.missionWpIdx = 0;
    log.info('npc mission', { tank: this.tank.displayName, wp: m.waypoints.length });
  }

  // —— 导演/诊断查询(DirectorSystem 用) ——
  /** 供导演查询所控坦克(清理死亡/姿态评估) */
  get controlledTank(): IControllableTank {
    return this.tank;
  }
  /** 当前血量比例(创建时满血快照 maxHp 为基准) */
  get hpRatio(): number {
    return this.maxHp > 0 ? this.tank.getHp() / this.maxHp : 1;
  }
  /** 是否已击毁(导演清理用) */
  get dead(): boolean {
    return this.tank.state !== 'intact';
  }

  // —— 姿态修饰的有效参数(A2:导演姿态 → NPC 行为参数缩放) ——
  private get postureMod() {
    return CONFIG.director.postureMod[this.getPosture()];
  }
  /** 有效反应时间(×姿态系数):aggro 更快、defensive 更慢 */
  private get effReactionTime(): number {
    return this.profile.reactionTime * this.postureMod.reaction;
  }
  /** 有效蓄瞄时间(×姿态系数) */
  private get effAimTime(): number {
    return this.profile.aimTime * this.postureMod.aimTime;
  }
  /** 有效撤退血量阈值(×姿态系数):aggro 更少撤退、defensive 更早撤 */
  private get effRetreatHpRatio(): number {
    return CONFIG.npc.retreatHpRatio * this.postureMod.retreat;
  }

  /** step 前:FSM 决策 + applyDrive(玩家附身时 paused,让出控制权) */
  preStep(dt: number): void {
    if (this.paused || this.tank.state !== 'intact') return;
    this.think(dt);
    this.controller.applyDrive(this.input);
  }

  /** step 后:applyAim + weapon(玩家附身时 paused) */
  postStep(dt: number): void {
    if (this.paused || this.tank.state !== 'intact') return;
    this.controller.applyAim(this.input, dt);
    this.weapon.update(this.input, dt);
    this.skill?.update(dt); // M3:推进技能冷却/激活(repair tick 回血+中断检测)
  }

  // ============================================================
  // FSM
  // ============================================================

  /** 决策:感知 → 状态转移 → 产出虚拟 InputState → 卡住检测 */
  private think(dt: number): void {
    if (this.fireCooldown > 0) this.fireCooldown -= dt;

    // 周期感知(省性能,不必每帧扫)
    this.scanTimer -= dt;
    if (this.scanTimer <= 0) {
      this.scan();
      this.scanTimer = CONFIG.npc.scanInterval;
    }

    // 瞄准散布:慢速随机游走(每 0.3s 重 roll),叠加在目标方位上产生命中率梯度。
    // 开火时也会强制 aimNoiseTimer=0 触发重 roll,下一发打向新散布方向。
    this.aimNoiseTimer -= dt;
    if (this.aimNoiseTimer <= 0) {
      this.aimNoiseOffset = (Math.random() * 2 - 1) * this.profile.aimNoise;
      this.aimNoiseTimer = 0.3;
    }

    // 反应时间:目标持续可见才累计 spotTimer,达 reactionTime 才算"反应过来"开始蓄瞄;
    // 看不见立即清零(重新发现要重新反应),弱 NPC 反应更慢。
    if (this.target && this.targetVisible) {
      this.spotTimer += dt;
    } else {
      this.spotTimer = 0;
    }

    // 视野内无目标(本次 scan 没看到)但记忆中还有 target → 累计丢失时间
    if (this.target && !this.targetVisible) {
      this.loseTimer += dt;
    }

    // 目标阵亡即时清空(含瞄准进度)
    if (this.target && this.target.state !== 'intact') {
      this.target = undefined;
      this.targetVisible = false;
      this.loseTimer = 0;
      this.aimTimer = 0;
      this.spotTimer = 0;
    }

    this.transition(dt);
    this.updateAimTimer(dt); // 蓄瞄计时:engage/retreat 且对准时累计,脱靶衰减
    this.thinkSkill(); // M3:veteran 技能决策(激活后 produceInput 据 isActive('repair') 站桩)
    this.input = this.produceInput();
    this.checkStuck(dt); // 卡住检测,可能覆盖 input.turn 触发绕障
  }

  /**
   * 技能决策(M3,仅 veteran)。
   * ------------------------------------------------------------
   * rookie/regular 无 skill(undefined)直接返回,保持纯机械 AI(平衡性)。
   * veteran 按态势触发:
   *  - 残血 + 脱战(无视线/远)→ 维修(战斗中修是送死,须脱战)
   *  - 中血 + 正交战 → 装甲倾斜(硬换窗口)
   *  - 目标远 + approach → 引擎过载(冲锋逼近)
   *  - 残血 + retreat → 引擎过载(逃跑加速)
   * tryActivate 内部 CD/激活去重,高频调用幂等无副作用。
   */
  private thinkSkill(): void {
    if (!this.skill) return; // 无 skill = 非 veteran,不决策
    if (!this.target) return;
    const hpRatio = this.maxHp > 0 ? this.tank.getHp() / this.maxHp : 1;
    const dist = this.distTo(this.target);
    const cfg = CONFIG.combat.npcSkill;
    // 维修:残血 + 脱战(无视线或远,避免战斗中站桩送死)
    if (hpRatio < cfg.repairHpRatio) {
      const hasLOS = hasLineOfSight(this.physics, this.tank, this.target);
      if (!hasLOS || dist > this.profile.fireRange * 1.3) {
        this.skill.tryActivate('repair');
        return;
      }
    }
    // 装甲倾斜:中血 + 正交战(硬换窗口)
    if (hpRatio < cfg.armorHpRatio && this.state === 'engage') {
      this.skill.tryActivate('armor');
      return;
    }
    // 引擎过载:目标远需逼近冲锋
    if (dist > this.profile.fireRange * cfg.boostDistRatio && this.state === 'approach') {
      this.skill.tryActivate('boost');
      return;
    }
    // 引擎过载:残血逃跑加速
    if (hpRatio < cfg.repairHpRatio && this.state === 'retreat') {
      this.skill.tryActivate('boost');
    }
  }

  /**
   * 感知:刷新视野内最近敌方。
   * 找到→更新 target + 重置 loseTimer;没找到→仅标记不可见(不清 target,
   * 留给 transition 判断超时丢失,避免目标短暂脱离视野就被放弃)。
   */
  private scan(): void {
    const found = findNearestEnemy(this.tank, this.enemies(), this.profile.sightRange);
    if (found) {
      this.target = found;
      this.targetVisible = true;
      this.loseTimer = 0;
    } else {
      this.targetVisible = false;
    }
  }

  /** 状态转移 */
  private transition(dt: number): void {
    const cfg = CONFIG.npc;
    const hpRatio = this.maxHp > 0 ? this.tank.getHp() / this.maxHp : 1;

    // 血量低且有目标 → RETREAT
    if (hpRatio <= this.effRetreatHpRatio && this.target) {
      if (this.state !== 'retreat') {
        log.info('npc RETREAT', { tank: this.tank.displayName, hp: hpRatio.toFixed(2) });
        this.retreatTimer = 0;
      }
      this.state = 'retreat';
      this.retreatTimer += dt;
      // retreat 超时(无回血机制,避免无限后退撞墙)→ 强制脱离放弃当前目标
      if (this.retreatTimer > cfg.retreatMaxTime) {
        log.info('npc retreat timeout, disengage', { tank: this.tank.displayName });
        this.target = undefined;
        this.targetVisible = false;
        this.loseTimer = 0;
        this.aimTimer = 0;
        this.spotTimer = 0;
        this.state = 'patrol';
      }
      return;
    }
    // RETREAT 中血量回升(无回血机制理论不触发;留作未来扩展) → 脱离
    if (this.state === 'retreat' && hpRatio > this.effRetreatHpRatio + 0.2) {
      this.state = this.target ? 'engage' : 'patrol';
      return;
    }

    // 弹药补给(M5):放 RETREAT 之后(保命优先于补给)。
    //  - 已在 resupply:补满才走(或全部补给点被毁则回 patrol 等再生);
    //  - 不在 resupply:弹药≤阈值 → 进入 resupply 自主导航去补给。
    // resupply 中不被 target 判定打断(没弹药打了也没用);但血量骤降时上方
    //  RETREAT 块仍会优先接管 → 保命第一。
    const ammoFull = this.weapon.isAmmoFull();
    if (this.state === 'resupply') {
      const hasPoint = this.resupply.nearestActivePoint(this.tank.body.translation()) !== undefined;
      if (ammoFull || !hasPoint) {
        log.info('npc resupply done', { tank: this.tank.displayName, ammo: this.weapon.getAmmo(), hasPoint });
        this.state = this.target ? 'engage' : 'patrol';
      }
      return; // resupply 中不往下走(避免被 target 判定打断)
    }
    if (this.weapon.getAmmo() <= CONFIG.ammo.npcResupplyThreshold) {
      // 有可用补给点才进 resupply;全被毁时不进——否则会在 patrol↔resupply 间
      //  每帧震荡 + 日志刷屏。NPC 继续用剩余弹药作战/巡逻,等补给点再生后下次再进。
      const hasPoint = this.resupply.nearestActivePoint(this.tank.body.translation()) !== undefined;
      if (hasPoint) {
        log.info('npc RESUPPLY', { tank: this.tank.displayName, ammo: this.weapon.getAmmo() });
        this.state = 'resupply';
      }
      return;
    }

    if (this.target) {
      // 视野丢失超时 → 放弃目标回巡逻(修复:原来 target 在就清 loseTimer 导致永不丢失)
      if (this.loseTimer > cfg.loseTargetTime) {
        log.info('npc lost target', { tank: this.tank.displayName, lostFor: this.loseTimer.toFixed(1) });
        this.target = undefined;
        this.targetVisible = false;
        this.loseTimer = 0;
        this.aimTimer = 0;
        this.spotTimer = 0;
        this.state = 'patrol';
        return;
      }
      const dist = this.distTo(this.target);
      const hasLOS = hasLineOfSight(this.physics, this.tank, this.target);
      // 在射程(按档位)且有视线 → ENGAGE;否则 APPROACH
      this.state = dist <= this.profile.fireRange && hasLOS ? 'engage' : 'approach';
    } else {
      this.state = 'patrol';
    }
  }

  /**
   * 简化避障:检测"想前进但实际速度低"(被障碍卡住),累计后强制侧转绕行。
   * 仅 patrol/approach/retreat(会移动的状态)适用;engage 原地机动不判。
   * 非射线避障,不完美,但能让 NPC 挣脱简单卡死,避免顶墙 indefinitely。
   */
  private checkStuck(dt: number): void {
    // 脱困中(后退拉开):强制后退+固定转向,持续 unstuckTimer 到期后恢复正常。
    // 关键:卡墙后必须后退(原来前进0.3顶墙→越卡越死);固定转向侧避免左右横跳转不开。
    if (this.unstuckTimer > 0) {
      this.unstuckTimer -= dt;
      this.input.forward = -0.7; // 后退拉开
      this.input.turn = this.unstuckDir; // 固定一侧转向
      return;
    }
    // 检测卡住:想前进但实际速度低(被障碍挡)。engage 现在会机动也需检测。
    const vel = this.tank.body.linvel();
    const actualSpeed = Math.hypot(vel.x, vel.z);
    if (this.input.forward > 0.5 && actualSpeed < 1.0) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.4) {
        // 触发脱困:后退 0.6s + 随机一侧转向,拉开后重试
        this.unstuckTimer = 0.6;
        this.unstuckDir = Math.random() < 0.5 ? -1 : 1;
        this.stuckTimer = 0;
      }
    } else {
      this.stuckTimer = 0;
    }
  }

  /** 各状态产出虚拟 InputState */
  private produceInput(): InputState {
    // M3:维修激活时强制站桩(castMaxSpeed 约束),覆盖移动但保留瞄准/开火。
    // NPC 维修期间是靶子,玩家可趁机绕侧——这是 veteran 维修的战术破绽,平衡其技能优势。
    if (this.skill?.isActive('repair')) {
      return {
        forward: 0,
        turn: 0,
        turretDir: this.target ? this.aimTurn(this.target) : 0,
        barrelDir: this.target ? this.aimBarrel(this.target) : 0,
        fire: this.decideFire(),
        switchNext: false,
        switchAmmo: null,
        skill: null,
        mouseX: 0,
        mouseY: 0,
      };
    }
    switch (this.state) {
      case 'patrol':
        return this.patrolInput();
      case 'approach':
        return this.approachInput();
      case 'engage':
        return this.engageInput();
      case 'retreat':
        return this.retreatInput();
      case 'resupply':
        return this.resupplyInput();
    }
  }

  // ============================================================
  // 各状态控制律
  // ============================================================

  /** PATROL:沿 mission waypoints 循环游走,炮塔缓慢扫描 */
  private patrolInput(): InputState {
    if (!this.mission || this.mission.waypoints.length === 0) {
      return { ...EMPTY_INPUT };
    }
    const wp = this.mission.waypoints[this.missionWpIdx];
    const arrived = this.driveToward(wp, 2.0);
    if (arrived) {
      this.missionWpIdx = (this.missionWpIdx + 1) % this.mission.waypoints.length;
    }
    const scan = Math.sin(performance.now() * 0.0008) * 0.5; // 炮塔缓慢扫描
    return { forward: this.avoiding ? 0.4 : 1, turn: this.lastTurn, turretDir: scan, barrelDir: 0, fire: false, switchNext: false, switchAmmo: null, skill: null, mouseX: 0, mouseY: 0 };
  }

  /** APPROACH:朝目标移动,炮塔指向目标 */
  private approachInput(): InputState {
    if (!this.target) return this.patrolInput();
    this.driveToward(this.target.body.translation(), 0);
    return {
      forward: this.avoiding ? 0.4 : 1, // 避障降速:绕障时减速,避免高速撞墙
      turn: this.lastTurn,
      turretDir: this.aimTurn(this.target),
      barrelDir: this.aimBarrel(this.target), // 接近途中预瞄炮管(抛物线弹道补偿),进射程即可打
      fire: false, // 接近中不开火(专注机动逼近),留给 engage/retreat
      switchNext: false,
      switchAmmo: null,
      skill: null,
      mouseX: 0,
      mouseY: 0,
    };
  }

  /**
   * ENGAGE(A2:距离保持 + 绕侧弧线 + 避障) + 持续瞄准(含抛物线弹道补偿) + 蓄瞄开火。
   * ------------------------------------------------------------
   * 不再原地站桩摇摆,而是:
   *  - 距离控制:维持理想交战距离(fireRange×0.7),太近后退/太远靠近/区间内小幅前后;
   *  - 绕侧弧线:固定方向(orbitSign)小转向 + 前进 → 围绕目标走弧线,车身绕侧、炮塔锁定;
   *  - 避障:前方有障覆盖转向(engage 现在会移动,不再豁免避障)。
   * 效果:NPC 边打边走位、卡自己擅长的距离,玩家难以站桩命中。
   */
  private engageInput(): InputState {
    if (!this.target) return this.patrolInput();
    // 距离保持:维持理想交战距离(命中率与安全的平衡点)
    const dist = this.distTo(this.target);
    const ideal = this.profile.fireRange * 0.7;
    let forward: number;
    if (dist > ideal * 1.2) forward = 1; // 太远:靠近
    else if (dist < ideal * 0.8) forward = -0.6; // 太近:慢退拉开(避免被贴脸)
    else forward = 0.4 + Math.sin(performance.now() * 0.0015) * 0.3; // 理想区间:小幅前后
    // 绕侧弧线:对准时才绕(aimQuality 调制)+ 弱系数(0.3),未对准稳住车身让炮塔追上——
    // 否则车身持续转,炮塔(惯性 omegaLerp=0.12)跟不上 → turretErr 永超 aimTolerance → 不开火(曾现 BUG)
    const aimErr = Math.abs(this.turretAimError(this.target));
    const aimQuality = Math.max(0, 1 - aimErr / this.profile.aimTolerance); // 0(未对准)~1(对准)
    let turn = this.orbitSign * 0.3 * aimQuality;
    let fwd = forward;
    const avoid = this.avoidanceTurn();
    if (avoid !== 0) {
      turn = avoid;
      fwd *= 0.3; // 避障减速:给转向反应时间,避免 9m/s 高速撞障(BUG2)
    }
    return {
      forward: fwd,
      turn,
      turretDir: this.aimTurn(this.target),
      barrelDir: this.aimBarrel(this.target), // 炮管俯仰:抛物线弹道补偿
      fire: this.decideFire(),
      switchNext: false,
      switchAmmo: null,
      skill: null,
      mouseX: 0,
      mouseY: 0,
    };
  }

  /**
   * RETREAT(A3 侧撤保侧面 + A4轻量 弧线不可预测):炮塔仍朝目标(边撤边打)。
   * ------------------------------------------------------------
   * 不再正对远离方向(会把伤害×2 的背面暴露给追击者),改为侧撤:
   *  - 车头朝远离方向的侧方(orbitSign 偏 1.0rad≈57°),前进 → 移动方向是侧后方;
   *  - 用侧面装甲(1.5×)替代背面(2.0×),且前进方向有避障、撤退速度快;
   *  - 叠加周期翻转偏移(wobble):撤退路线呈弧线、不可预测,更易借地形挡视线。
   */
  private retreatInput(): InputState {
    if (!this.target) return this.patrolInput();
    const sp = this.tank.body.translation();
    const tp = this.target.body.translation();
    const awayYaw = Math.atan2(sp.x - tp.x, sp.z - tp.z); // 远离目标的方向
    const wobble = Math.sin(performance.now() * 0.0008) * 0.4; // 周期翻转:弧线撤退,不可预测
    this.lastTurn = this.steerToYaw(awayYaw + this.orbitSign * 1.0 + wobble);
    let fwd = 1;
    const avoid = this.avoidanceTurn();
    if (avoid !== 0) {
      this.lastTurn = avoid;
      fwd = 0.3; // 避障减速:侧撤时前方有障降速,避免撞(BUG2)
    }
    return {
      forward: fwd,
      turn: this.lastTurn,
      turretDir: this.aimTurn(this.target),
      barrelDir: this.aimBarrel(this.target),
      fire: this.decideFire(),
      switchNext: false,
      switchAmmo: null,
      skill: null,
      mouseX: 0,
      mouseY: 0,
    };
  }

  /**
   * RESUPPLY:导航到最近可用补给点装填(M5)。
   * 到达后停下(forward=0),装填由 ResupplySystem 自动完成(驶入半径即回弹);
   * transition 检测满弹药后退出 resupply。无可用补给点(全被毁)→ 暂回巡逻等再生。
   */
  private resupplyInput(): InputState {
    const myPos = this.tank.body.translation();
    const dest = this.resupply.nearestActivePoint({ x: myPos.x, z: myPos.z });
    if (!dest) return this.patrolInput(); // 无可用补给点:暂时巡逻等再生
    const arrived = this.driveToward(dest, CONFIG.ammo.resupplyRadius * 0.7);
    if (arrived) {
      this.lastTurn = 0; // 到达:停下装填
      return { forward: 0, turn: 0, turretDir: 0, barrelDir: 0, fire: false, switchNext: false, switchAmmo: null, skill: null, mouseX: 0, mouseY: 0 };
    }
    return { forward: this.avoiding ? 0.4 : 1, turn: this.lastTurn, turretDir: 0, barrelDir: 0, fire: false, switchNext: false, switchAmmo: null, skill: null, mouseX: 0, mouseY: 0 };
  }

  // ============================================================
  // 控制辅助
  // ============================================================

  /**
   * 开火脉冲(无参自算对准条件,内聚瞄准判定)。
   * 四重前置(全满足才 true 一帧,触发 WeaponSystem 边沿开火):
   *  1. fireCooldown 到(与武器冷却同步)
   *  2. aimTimer >= profile.aimTime(蓄瞄足够;弱 NPC 蓄瞄久 → 玩家有反应窗口)
   *  3. 当前帧炮塔+炮管都对准(水平误差<aimTolerance 且 俯仰误差<0.03rad)
   *  4. 有视线(中间无遮挡)
   * 开火后:重置 aimTimer(重新蓄瞄下一发)+ 强制散布重 roll(下一发打向新散布)。
   */
  private decideFire(): boolean {
    if (this.fireCooldown > 0 || !this.target) return false;
    if (this.aimTimer < this.effAimTime) return false;
    // 当前帧对准复检(aimTimer 是历史累计,需确认此刻仍对准,避免打移动目标的滞后)
    const turretErr = Math.abs(this.turretAimError(this.target));
    const barrelErr = Math.abs(this.barrelAimError(this.target));
    const aligned = turretErr < this.profile.aimTolerance && barrelErr < 0.03;
    if (!aligned) return false;
    if (!hasLineOfSight(this.physics, this.tank, this.target)) return false;
    this.fireCooldown = CONFIG.weapon.fireCooldown; // 与武器冷却同步,防止持续触发
    this.aimTimer = 0; // 开火后重新蓄瞄(下一发需再次锁定 aimTime 秒)
    this.aimNoiseTimer = 0; // 立即换散布,下一发打向新方向
    log.debug('npc fire', { tank: this.tank.displayName, tier: this.profile.name });
    return true;
  }

  /**
   * 蓄瞄计时(每帧由 think 调用,介于 transition 与 produceInput 之间)。
   * 仅 engage/retreat 蓄瞄;需 已反应(reactionTime) + 目标可见 + 当前对准 → aimTimer 累计;
   * 脱靶则快速衰减(×2),避免"曾对准就能打"的取巧。判定标准与 decideFire 完全一致。
   */
  private updateAimTimer(dt: number): void {
    if (this.state !== 'engage' && this.state !== 'retreat') return;
    if (!this.target || !this.targetVisible) return;
    if (this.spotTimer < this.effReactionTime) return; // 未反应,不蓄瞄
    const turretErr = Math.abs(this.turretAimError(this.target));
    const barrelErr = Math.abs(this.barrelAimError(this.target));
    const aligned = turretErr < this.profile.aimTolerance && barrelErr < 0.03;
    if (aligned) {
      this.aimTimer += dt;
    } else {
      this.aimTimer = Math.max(0, this.aimTimer - dt * 2); // 脱靶快速流失
    }
  }

  /**
   * 朝目标点转向;返回是否到达(tolerance 内)。设置 this.lastTurn。
   * 含前向避障:steerTo 算目标转向后,若正前方有障则覆盖到通畅侧(预测式绕障)。
   */
  private driveToward(target: { x: number; z: number }, tolerance: number): boolean {
    const sp = this.tank.body.translation();
    const dx = target.x - sp.x;
    const dz = target.z - sp.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= tolerance) {
      this.lastTurn = 0;
      this.avoiding = false;
      return true;
    }
    this.lastTurn = this.steerTo(dx, dz);
    const avoid = this.avoidanceTurn();
    this.avoiding = avoid !== 0;
    if (avoid !== 0) this.lastTurn = avoid; // 前方有障→覆盖转向到通畅侧
    return false;
  }

  /** 算车身转向输入(-1..1):让车身朝向指定 yaw 角(0=+z)。基于车身当前 yaw 与目标偏航差 */
  private steerToYaw(desiredYaw: number): number {
    let diff = desiredYaw - this.bodyYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // 归一化到 -PI..PI
    return Math.max(-1, Math.min(1, diff * 2)); // 放大系数,小偏差也转
  }
  /** 算车身转向输入(-1..1):让车身朝 (dx,dz) 方向(steerToYaw 的方位便捷封装) */
  private steerTo(dx: number, dz: number): number {
    return this.steerToYaw(Math.atan2(dx, dz)); // 0=+z(与车身朝向约定一致)
  }

  /**
   * 炮塔瞄准误差(水平):目标方位与炮塔世界偏航的夹角(rad,-PI..PI)。
   * 在目标方位上叠加 aimNoiseOffset(慢速随机散布),产生命中率梯度。
   * turretAimError 供 updateAimTimer/decideFire 判定对准;aimTurn 据此产 turretDir。
   */
  private turretAimError(target: IControllableTank): number {
    const sp = this.tank.body.translation();
    const lead = this.leadPos(target); // 提前量预测位置(A1):打移动目标不再打在身后
    const desiredWorldYaw = Math.atan2(lead.x - sp.x, lead.z - sp.z) + this.aimNoiseOffset;
    const turretWorldYaw = this.bodyYaw + this.tank.turret.rotation.y;
    const diff = desiredWorldYaw - turretWorldYaw;
    return Math.atan2(Math.sin(diff), Math.cos(diff));
  }

  /** 炮塔转向目标:据瞄准误差产 turretDir(-1..1) */
  private aimTurn(target: IControllableTank): number {
    const diff = this.turretAimError(target);
    return Math.max(-1, Math.min(1, diff * 3));
  }

  /**
   * 抛物线弹道解算:给定炮口与目标,反解炮管仰角(rad),使炮弹抛物落点≈目标。
   * ------------------------------------------------------------
   * 物理前提:炮弹是受重力 g 的 dynamic 刚体、LinearDamping=0(无空气阻力),
   * 初速 v=muzzleVelocity 恒定。游戏化近似,忽略 Coriolis/风。
   *
   * 推导:水平匀速 t=d/(v·cosθ);垂直 Δy=v·sinθ·t−½g·t²。
   *       令 u=tanθ,用 1/cos²θ=1+tan²θ 消元得关于 u 的二次方程:
   *         A·u² − d·u + (Δy + A) = 0,  其中 A = g·d²/(2v²)。
   *       判别式≥0 取较小根 u=(d−√Δ)/(2A)(平直弹道,落点准);
   *       <0 表示目标超出最大射程,取炮管最大仰角尽力抛射。
   *
   * 仰角最终 clamp 到炮管机械限位(pitchRange),超出则命中率自然下降——
   * 这正是"远距离难打"的现实,符合难度梯度设计。
   */
  private solveBallisticPitch(target: IControllableTank): number {
    const muzzle = this.tank.muzzleWorldPosition();
    const lead = this.leadPos(target); // 提前量预测位置(A1):抛物弹道落点对准预测位
    const dx = lead.x - muzzle.x;
    const dz = lead.z - muzzle.z;
    const d = Math.hypot(dx, dz);
    const dy = lead.y - muzzle.y;
    const v = CONFIG.weapon.ammoTypes[this.weapon.getSelectedAmmo()].muzzleVelocity;
    const g = Math.abs(CONFIG.physics.gravity.y);
    const range = this.tank.driveConfig.barrel.pitchRange;
    if (d < 1) return 0; // 太近:水平直射,无需补偿
    const A = (g * d * d) / (2 * v * v);
    const disc = d * d - 4 * A * (dy + A);
    const u = disc < 0 ? Math.tan(range.max) : (d - Math.sqrt(disc)) / (2 * A);
    const pitch = Math.atan(u);
    return Math.max(range.min, Math.min(range.max, pitch));
  }

  /** 炮管俯仰误差:目标仰角 − 当前炮管角(rad)。正=需抬起,负=需压低。 */
  private barrelAimError(target: IControllableTank): number {
    return this.solveBallisticPitch(target) - this.tank.barrel.rotation.x;
  }

  /**
   * 炮管俯仰输入:据俯仰误差产 barrelDir(-1/0/1),带死区防微抖。
   * 不直接设角度,而是产方向输入交由 TankController.applyAim 的 pitchSpeed 积分驱动,
   * 保持"NPC 只产 InputState、复用玩家驾驶层"的架构一致性。
   */
  private aimBarrel(target: IControllableTank): number {
    const diff = this.barrelAimError(target);
    const dead = 0.02; // 死区(rad≈1.1°),误差小于此不再调整,防炮管来回微抖
    if (diff > dead) return 1;
    if (diff < -dead) return -1;
    return 0;
  }

  /** 水平距离到目标 */
  private distTo(t: IControllableTank): number {
    const sp = this.tank.body.translation();
    const tp = t.body.translation();
    return Math.hypot(tp.x - sp.x, tp.z - sp.z);
  }

  /**
   * 提前量预测(A1):估算炮弹飞行时间内目标的移动位置,作为瞄准点。
   * 飞行时间 t=距离/初速(游戏化近似,忽略抛物线额外距离);
   * 预测位置 = 目标当前位置 + 目标速度 × t → 打移动目标不再系统性打偏。
   * y 不预测(坦克水平行驶,预测 vy 的噪声会让仰角乱跳),用目标当前 y。
   */
  private leadPos(target: IControllableTank): { x: number; y: number; z: number } {
    const sp = this.tank.body.translation();
    const tp = target.body.translation();
    const dist = Math.hypot(tp.x - sp.x, tp.z - sp.z);
    const t = dist / CONFIG.weapon.ammoTypes[this.weapon.getSelectedAmmo()].muzzleVelocity;
    const vel = target.body.linvel();
    return { x: tp.x + vel.x * t, y: tp.y, z: tp.z + vel.z * t };
  }

  /** 车身偏航(从刚体四元数) */
  private get bodyYaw(): number {
    const q = this.tank.body.rotation();
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  // ============================================================
  // 前向避障(预测式射线)
  // ============================================================

  /**
   * 前向+侧面射线避障:返回修正转向(-1..1),0=无需修正。
   * ------------------------------------------------------------
   * 前方 3 条(±avoidanceAngle + 正前, 长 avoidanceRange):正前方挡 → 朝通畅侧转。
   * 侧面 2 条(±70°, 短 4m):正前方通但侧面近障 → 微调反向偏转,防转向/绕侧时侧面撞。
   * 死角(前方+前侧都挡):强转,配合 checkStuck 后退脱困。
   * 在 driveToward/engage/retreat 内调用,覆盖 lastTurn。与 checkStuck(反应式后退)互补。
   */
  private avoidanceTurn(): number {
    const cfg = CONFIG.npc;
    const yaw = this.bodyYaw;
    const dist = cfg.avoidanceRange; // 前方射线长度
    const ang = cfg.avoidanceAngle; // 前扇半角
    const o = this.tank.body.translation();
    const origin = { x: o.x, y: 1.0, z: o.z }; // 抬高到车身中部防贴地误判

    if (this.rayClear(origin, yaw, dist)) {
      // 正前方通:检查侧面近距障碍做微调(防转向时侧面盲区撞墙)
      const leftSide = this.rayClear(origin, yaw - 1.2, 4);
      const rightSide = this.rayClear(origin, yaw + 1.2, 4);
      if (!leftSide && rightSide) return 0.5; // 左侧近障→微右偏
      if (!rightSide && leftSide) return -0.5; // 右侧近障→微左偏
      return 0; // 前方+侧面都通,不干预
    }
    // 正前方挡:按左前/右前通畅选转向(前扇加宽到±40°,更早发现侧前障碍)
    const leftClear = this.rayClear(origin, yaw - ang, dist);
    const rightClear = this.rayClear(origin, yaw + ang, dist);
    if (leftClear && !rightClear) return -1; // 仅左通→偏左
    if (rightClear && !leftClear) return 1; // 仅右通→偏右
    if (leftClear && rightClear) return this.lastTurn >= 0 ? 1 : -1; // 两侧通→朝目标侧
    return -1; // 死角:强转,配合 checkStuck 后退脱困
  }

  /**
   * 射线探测:从 origin 沿 yaw 方向(0=+z)射 maxDist,返回是否通畅(无障碍命中)。
   * 排除自身刚体防自射;命中任何 collider(建筑/树/山/坦克)在 maxDist 内即视为挡。
   */
  private rayClear(origin: { x: number; y: number; z: number }, yaw: number, maxDist: number): boolean {
    const dir = { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }; // 0=+z 单位向量(水平)
    const ray = new RAPIER.Ray(origin, dir);
    // castRay 返回命中 toi(沿 dir 距离,dir 单位故=实际距离);null=未命中=通畅
    const toi = this.physics.world.castRay(
      ray, maxDist, true, undefined, undefined, undefined, this.tank.body,
    );
    return toi === null;
  }
}
