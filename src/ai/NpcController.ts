import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { TankController } from '../systems/TankController';
import type { WeaponSystem } from '../systems/WeaponSystem';
import type { InputState } from '../systems/InputSystem';
import { findNearestEnemy, hasLineOfSight } from './perception';
import { Logger } from '../utils/Logger';

const log = Logger.create('Npc');

/** NPC 巡逻任务(由 DirectorSystem 分配,对应未来 LLM 的 assignPatrol 工具) */
export interface NpcMission {
  type: 'patrol';
  waypoints: { x: number; z: number }[];
}

type NpcState = 'patrol' | 'approach' | 'engage' | 'retreat';

const EMPTY_INPUT: InputState = {
  forward: 0,
  turn: 0,
  turretDir: 0,
  barrelDir: 0,
  fire: false,
  switchNext: false,
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
  private mission?: NpcMission;
  private missionWpIdx = 0;
  private target?: IControllableTank;
  private scanTimer = 0;
  private loseTimer = 0; // 视野丢失但记忆中还有 target 的累计时间(超 loseTargetTime 放弃)
  private fireCooldown = 0; // NPC 自管开火脉冲冷却(适配 WeaponSystem 边沿触发)
  private targetVisible = false; // 本次 scan 是否在视野内看到目标(区分"记忆目标"与"当前可见")
  private retreatTimer = 0; // retreat 持续时间(超 retreatMaxTime 强制脱离,无回血避免无限后退)
  private stuckTimer = 0; // 卡住检测:想前进但实际速度低,累计后触发侧转绕障
  /** 创建时满血,作 retreat 阈值基准(接口无 maxHp,创建时快照) */
  private readonly maxHp: number;
  /** driveToward/away 算出的转向(-1..1),供 produceInput 取用 */
  private lastTurn = 0;
  /** 当前决策产出的虚拟输入(preStep 算好,applyDrive/applyAim/weapon 共用) */
  private input: InputState = { ...EMPTY_INPUT };

  constructor(
    private readonly tank: IControllableTank,
    private readonly controller: TankController,
    private readonly weapon: WeaponSystem,
    private readonly enemies: () => IControllableTank[],
    private readonly physics: PhysicsWorld,
  ) {
    this.maxHp = tank.getHp();
    log.info('npc ready', { tank: tank.displayName });
  }

  /** 导演分配巡逻任务 */
  setMission(m: NpcMission): void {
    this.mission = m;
    this.missionWpIdx = 0;
    log.info('npc mission', { tank: this.tank.displayName, wp: m.waypoints.length });
  }

  /** step 前:FSM 决策 + applyDrive */
  preStep(dt: number): void {
    if (this.tank.state !== 'intact') return;
    this.think(dt);
    this.controller.applyDrive(this.input);
  }

  /** step 后:applyAim + weapon */
  postStep(dt: number): void {
    if (this.tank.state !== 'intact') return;
    this.controller.applyAim(this.input, dt);
    this.weapon.update(this.input, dt);
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

    // 视野内无目标(本次 scan 没看到)但记忆中还有 target → 累计丢失时间
    if (this.target && !this.targetVisible) {
      this.loseTimer += dt;
    }

    // 目标阵亡即时清空
    if (this.target && this.target.state !== 'intact') {
      this.target = undefined;
      this.targetVisible = false;
      this.loseTimer = 0;
    }

    this.transition(dt);
    this.input = this.produceInput();
    this.checkStuck(dt); // 卡住检测,可能覆盖 input.turn 触发绕障
  }

  /**
   * 感知:刷新视野内最近敌方。
   * 找到→更新 target + 重置 loseTimer;没找到→仅标记不可见(不清 target,
   * 留给 transition 判断超时丢失,避免目标短暂脱离视野就被放弃)。
   */
  private scan(): void {
    const found = findNearestEnemy(this.tank, this.enemies(), CONFIG.npc.sightRange);
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
    if (hpRatio <= cfg.retreatHpRatio && this.target) {
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
        this.state = 'patrol';
      }
      return;
    }
    // RETREAT 中血量回升(无回血机制理论不触发;留作未来扩展) → 脱离
    if (this.state === 'retreat' && hpRatio > cfg.retreatHpRatio + 0.2) {
      this.state = this.target ? 'engage' : 'patrol';
      return;
    }

    if (this.target) {
      // 视野丢失超时 → 放弃目标回巡逻(修复:原来 target 在就清 loseTimer 导致永不丢失)
      if (this.loseTimer > cfg.loseTargetTime) {
        log.info('npc lost target', { tank: this.tank.displayName, lostFor: this.loseTimer.toFixed(1) });
        this.target = undefined;
        this.targetVisible = false;
        this.loseTimer = 0;
        this.state = 'patrol';
        return;
      }
      const dist = this.distTo(this.target);
      const hasLOS = hasLineOfSight(this.physics, this.tank, this.target);
      // 在射程且有视线 → ENGAGE;否则 APPROACH
      this.state = dist <= cfg.fireRange && hasLOS ? 'engage' : 'approach';
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
    if (this.state === 'engage') {
      this.stuckTimer = 0;
      return;
    }
    const vel = this.tank.body.linvel();
    const actualSpeed = Math.hypot(vel.x, vel.z);
    if (this.input.forward > 0.5 && actualSpeed < 1.0) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 0.4) {
        // 卡住:交替左右转向绕障,降速但仍动
        this.input.turn = Math.sin(performance.now() * 0.004) > 0 ? 1 : -1;
        this.input.forward = 0.3;
      }
    } else {
      this.stuckTimer = 0;
    }
  }

  /** 各状态产出虚拟 InputState */
  private produceInput(): InputState {
    switch (this.state) {
      case 'patrol':
        return this.patrolInput();
      case 'approach':
        return this.approachInput();
      case 'engage':
        return this.engageInput();
      case 'retreat':
        return this.retreatInput();
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
    return { forward: 1, turn: this.lastTurn, turretDir: scan, barrelDir: 0, fire: false, switchNext: false, mouseX: 0, mouseY: 0 };
  }

  /** APPROACH:朝目标移动,炮塔指向目标 */
  private approachInput(): InputState {
    if (!this.target) return this.patrolInput();
    this.driveToward(this.target.body.translation(), 0);
    return {
      forward: 1,
      turn: this.lastTurn,
      turretDir: this.aimTurn(this.target),
      barrelDir: 0,
      fire: false,
      switchNext: false,
      mouseX: 0,
      mouseY: 0,
    };
  }

  /** ENGAGE:小幅机动(避免站桩) + 持续瞄准 + 满足条件开火 */
  private engageInput(): InputState {
    if (!this.target) return this.patrolInput();
    const sway = Math.sin(performance.now() * 0.0015) * 0.4; // 小幅前后机动
    const aim = this.aimTurn(this.target);
    const aligned = Math.abs(aim) < CONFIG.npc.aimTolerance * 3;
    return {
      forward: sway,
      turn: 0,
      turretDir: aim,
      barrelDir: 0,
      fire: this.decideFire(aligned),
      switchNext: false,
      mouseX: 0,
      mouseY: 0,
    };
  }

  /** RETREAT:远离目标,炮塔仍朝目标(边撤边打) */
  private retreatInput(): InputState {
    if (!this.target) return this.patrolInput();
    this.driveAwayFrom(this.target.body.translation());
    const aim = this.aimTurn(this.target);
    const aligned = Math.abs(aim) < CONFIG.npc.aimTolerance * 3;
    return {
      forward: 1,
      turn: this.lastTurn,
      turretDir: aim,
      barrelDir: 0,
      fire: this.decideFire(aligned),
      switchNext: false,
      mouseX: 0,
      mouseY: 0,
    };
  }

  // ============================================================
  // 控制辅助
  // ============================================================

  /** 开火脉冲:冷却到 + 瞄准收敛 + 有视线 → true 一帧(触发 WeaponSystem 边沿) */
  private decideFire(aligned: boolean): boolean {
    if (this.fireCooldown > 0 || !aligned || !this.target) return false;
    if (!hasLineOfSight(this.physics, this.tank, this.target)) return false;
    this.fireCooldown = CONFIG.weapon.fireCooldown; // 与武器冷却同步,防止持续触发
    return true;
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
      return true;
    }
    this.lastTurn = this.steerTo(dx, dz);
    const avoid = this.avoidanceTurn();
    if (avoid !== 0) this.lastTurn = avoid; // 前方有障→覆盖转向到通畅侧
    return false;
  }

  /** 远离目标点:朝反方向转向(含前向避障,后撤时不撞身后障碍) */
  private driveAwayFrom(target: { x: number; z: number }): void {
    const sp = this.tank.body.translation();
    this.lastTurn = this.steerTo(sp.x - target.x, sp.z - target.z);
    const avoid = this.avoidanceTurn();
    if (avoid !== 0) this.lastTurn = avoid;
  }

  /** 算车身转向输入(-1..1):让车身朝 (dx,dz) 方向。基于车身当前 yaw 与目标方位差 */
  private steerTo(dx: number, dz: number): number {
    const desiredYaw = Math.atan2(dx, dz); // 0=+z(与车身朝向约定一致)
    let diff = desiredYaw - this.bodyYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff)); // 归一化到 -PI..PI
    return Math.max(-1, Math.min(1, diff * 2)); // 放大系数,小偏差也转
  }

  /** 炮塔转向目标:返回 turretDir(-1..1)。炮塔世界角 = 车身 yaw + 炮塔相对角 */
  private aimTurn(target: IControllableTank): number {
    const sp = this.tank.body.translation();
    const tp = target.body.translation();
    const desiredWorldYaw = Math.atan2(tp.x - sp.x, tp.z - sp.z);
    const turretWorldYaw = this.bodyYaw + this.tank.turret.rotation.y;
    let diff = desiredWorldYaw - turretWorldYaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    return Math.max(-1, Math.min(1, diff * 3));
  }

  /** 水平距离到目标 */
  private distTo(t: IControllableTank): number {
    const sp = this.tank.body.translation();
    const tp = t.body.translation();
    return Math.hypot(tp.x - sp.x, tp.z - sp.z);
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
   * 前向扇形射线避障:返回修正转向(-1..1),0=前方通畅无需修正。
   * 从车身向[左前/正前/右前]射 3 条射线(长度 avoidanceRange):
   *  - 正前方通畅 → 不干预(交还 steerTo 朝目标)
   *  - 正前方挡、某侧通畅 → 朝通畅侧偏转
   *  - 两侧都通 → 朝目标所在侧(lastTurn 符号)偏转
   *  - 三方都挡(死角) → 强转一侧,配合 checkStuck 兜底后退脱困
   * 在 driveToward/driveAwayFrom 内调用,覆盖 lastTurn。与 checkStuck(反应式)互补。
   */
  private avoidanceTurn(): number {
    const cfg = CONFIG.npc;
    const yaw = this.bodyYaw;
    const dist = cfg.avoidanceRange;
    const ang = cfg.avoidanceAngle;
    const o = this.tank.body.translation();
    // 射线起点抬高到车身中部(y=1),避免贴地误判地面 collider
    const origin = { x: o.x, y: 1.0, z: o.z };
    if (this.rayClear(origin, yaw, dist)) return 0; // 正前方通,不干预
    const leftClear = this.rayClear(origin, yaw - ang, dist);
    const rightClear = this.rayClear(origin, yaw + ang, dist);
    if (leftClear && !rightClear) return -1; // 仅左通→偏左
    if (rightClear && !leftClear) return 1; // 仅右通→偏右
    if (leftClear && rightClear) return this.lastTurn >= 0 ? 1 : -1; // 两侧通→朝目标侧
    return -1; // 死角:强转,配合 checkStuck 后退
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
