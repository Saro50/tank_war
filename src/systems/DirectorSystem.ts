import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { createTank } from '../entities/tanks/registry';
import { StaticTankBase } from '../entities/tanks/StaticTankBase';
import { TankController } from './TankController';
import { WeaponSystem } from './WeaponSystem';
import type { DestructionSystem } from './DestructionSystem';
import { NpcController, type NpcMission, type NpcTier, type Posture, resolveNpcProfile } from '../ai/NpcController';
import type { ResupplySystem } from './ResupplySystem';
import type { CaptureSystem } from './CaptureSystem';
import { SkillSystem } from './SkillSystem';
import { Logger } from '../utils/Logger';

const log = Logger.create('Director');

/**
 * 导演系统(敌方阵营管理)
 * ============================================================
 * 职责:管理所有 NPC 敌坦的生命周期——启动时接管 CONFIG.tanks 中 npc:true
 * 的坦克(possess 转可驾驶 + 分配巡逻任务),每帧驱动它们(step 前 drive /
 * step 后 aim+weapon),并转发炮弹碰撞到各 NPC 的 weapon。
 *
 * 阵营(team):用 CONFIG.tanks 的 team 字段(与 allTanks 同序)判定敌我。
 *   NPC 的敌方 = team==='player' 的坦克(首期=玩家)。中立/敌方不在目标内。
 *
 * 友伤:不在本系统处理。 Projectile.ownerTank + DestructionSystem.applyDamage
 *   已对所有坦克生效(除发射者),NPC 之间/NPC 与玩家之间自然互相伤害。
 *
 * 时序(主循环调用):
 *   updateDrive(dt)  —— step 前,所有 NPC 决策+applyDrive
 *   handleCollision  —— drain 碰撞时转发给各 NPC weapon
 *   update(dt)       —— step 后,所有 NPC applyAim+weapon
 *
 * LLM 接入点(未来):本系统的公开方法即未来 LLM 导演调用的工具——
 *   spawnEnemy/assignPatrol/setPosture/getOverview。首期用机械规则(initNpcs
 *   静态生成 + pickPatrolMission 轮询分配),未来 LLM 决策调用同样方法,
 *   执行体不变。NpcController 产出"单车指令",本系统产出"阵营指令"。
 */
export class DirectorSystem {
  private npcs: NpcController[] = [];
  /** NPC 的 weapon 列表(碰撞分发用;NpcController 内部也持有各自 weapon) */
  private npcWeapons: WeaponSystem[] = [];
  /** tank → NpcController 映射(玩家附身时按 tank 查找并暂停/恢复其 AI) */
  private readonly npcByTank = new Map<IControllableTank, NpcController>();
  /** 每辆坦克的阵营(与 allTanks 同序),用于敌我判定 */
  private teams: string[];

  // —— 导演策略状态(A1 波次 + A2 姿态) ——
  /** 当前全阵营姿态;public 供 NpcController 闭包读取修饰行为参数 */
  posture: Posture = 'normal';
  /** 玩家击毁的 NPC 数(B1 目标/分数) */
  private _killCount = 0;
  /** 玩家坦克引用(姿态评估/死亡检测用) */
  private playerTank?: IControllableTank;
  /** 补充生成计时(s):存活 NPC<targetConcurrent 时累计,达 spawnInterval 生成一个 */
  private spawnTimer = 0;
  /** 生成序号(轮询 variant/spawnPoint/tier) */
  private spawnCounter = 0;
  /** 姿态评估计时(s) */
  private postureEvalTimer = 0;
  /** 占领军关卡的占领目标(占领点位置 + 巡逻半径)。setCaptureTarget 设置;
   *  设后 pickPatrolMission 返回围绕占领点的 waypoints,NPC 自然在据点周围形成对抗。
   *  undefined=歼灭战,用原 patrolAreas 轮询。 */
  private captureTarget?: { pos: { x: number; z: number }; radius: number };

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly render: RenderScene,
    private readonly destruction: DestructionSystem,
    private readonly allTanks: IControllableTank[],
    /** 补给系统:NPC 弹药耗尽时导航补给;NPC 创建时注册其 (tank,weapon) 供装填 */
    private readonly resupply: ResupplySystem,
    /** 占领系统:NPC 创建/摧毁时注册/注销,纳入占领判定。歼灭战无 zone 时空转 */
    private readonly capture: CaptureSystem,
  ) {
    // 从 CONFIG.tanks 派生阵营(与 allTanks 同序;buildTanks 保证顺序一致)
    this.teams = CONFIG.tanks.map((t) => t.team ?? 'neutral');
    // 找玩家坦克(team==='player'):姿态评估(残血时 aggro)+ 死亡检测(Game Over)
    const playerIdx = this.teams.indexOf('player');
    this.playerTank = playerIdx >= 0 ? this.allTanks[playerIdx] : undefined;
    this.initNpcs();
  }

  /** 启动:接管所有 npc:true 的坦克 */
  private initNpcs(): void {
    for (let i = 0; i < CONFIG.tanks.length; i++) {
      const cfg = CONFIG.tanks[i];
      // npc 字段仅敌坦项有(as const 联合形状不同),用断言安全访问
      if (!(cfg as { npc?: boolean }).npc) continue;
      const tank = this.allTanks[i];
      if (!tank) continue;
      tank.possess(); // fixed→dynamic,使可驾驶(NPC 复用玩家驾驶层)
      // 每 NPC 独立的驾驶控制器(复用 TankController,但不调 updateCamera)
      const controller = new TankController(tank, this.render);
      // 每 NPC 独立的武器(shake=undefined:NPC 开火不震玩家相机)
      const weapon = new WeaponSystem(() => tank, this.physics, this.render, undefined, this.destruction);
      // 按档位(tier)解析难度参数注入;缺失回退 regular(老兵)
      const tierKey = (cfg as { tier?: string }).tier;
      const profile = resolveNpcProfile(tierKey);
      // M3:veteran 注入技能系统(rookie/regular 不传 skill,保持纯机械 AI——平衡性)
      const skill = tierKey === 'veteran' ? new SkillSystem(() => tank) : undefined;
      const npc = new NpcController(tank, controller, weapon, () => this.enemiesOf(tank), this.physics, profile, this.resupply, () => this.posture, skill);
      npc.setMission(this.pickPatrolMission());
      this.npcs.push(npc);
      this.npcWeapons.push(weapon);
      this.npcByTank.set(tank, npc); // 供 main 玩家附身时按 tank 暂停/恢复 AI
      // 注册到补给系统:NPC 弹药耗尽时导航补给,驶入补给点时自动装填
      this.resupply.register(tank, weapon);
      // 注册到占领系统:NPC 纳入占领判定(敌方在场)。歼灭战无 zone 时空转
      this.capture.registerEnemy(tank);
    }
    log.info('director ready', { npcs: this.npcs.length });
  }

  /** 返回某 NPC 的敌方候选(team==='player' 且存活)。首期=玩家 */
  private enemiesOf(self: IControllableTank): IControllableTank[] {
    const idx = this.allTanks.indexOf(self);
    if (idx < 0) return [];
    return this.allTanks.filter(
      (t, i) => t !== self && t.state === 'intact' && this.teams[i] === 'player',
    );
  }

  /**
   * 选一个巡逻任务。
   * 占领军关卡(captureTarget 已设):围绕占领点 4 方位巡逻,NPC 自然在据点周围
   *  逗留形成对抗(看到玩家就交战,玩家被赶走后回来继续绕)。零侵入 NpcController 的 FSM。
   * 歼灭战:按已有 NPC 数轮询 patrolAreas,错开区域。
   */
  private pickPatrolMission(): NpcMission {
    if (this.captureTarget) {
      const { pos, radius } = this.captureTarget;
      return {
        type: 'patrol',
        waypoints: [
          { x: pos.x + radius, z: pos.z },
          { x: pos.x, z: pos.z + radius },
          { x: pos.x - radius, z: pos.z },
          { x: pos.x, z: pos.z - radius },
        ],
      };
    }
    const areas = CONFIG.enemyFaction.patrolAreas;
    const area = areas[this.npcs.length % areas.length];
    return { type: 'patrol', waypoints: area.waypoints.map((w) => ({ x: w.x, z: w.z })) };
  }

  /**
   * 设置占领目标(占领军关卡由 main 选关回调调用)。
   * 设置后:① 新生成 NPC 的巡逻围绕占领点;② 现存 NPC 立即重派围绕占领点的巡逻任务。
   *  歼灭战不调用 → captureTarget 保持 undefined → 用原 patrolAreas。
   */
  setCaptureTarget(pos: { x: number; z: number }, radius: number): void {
    this.captureTarget = { pos, radius };
    // 现存 NPC 立即重派(启动时拿的是 patrolAreas mission,需切换到占领点巡逻)
    for (const npc of this.npcs) npc.setMission(this.pickPatrolMission());
    log.info('director capture target set', {
      pos: `${pos.x},${pos.z}`,
      radius,
      npcs: this.npcs.length,
    });
  }

  /** step 前:所有 NPC 决策 + applyDrive */
  updateDrive(dt: number): void {
    for (const npc of this.npcs) npc.preStep(dt);
  }

  /** step 后:清理死亡 + 调度生成 + 姿态评估 + 所有 NPC applyAim+weapon */
  update(dt: number): void {
    this.cleanupDeadNpcs();
    this.scheduleSpawn(dt);
    this.evaluatePosture(dt);
    for (const npc of this.npcs) npc.postStep(dt);
  }

  // ============================================================
  // A1 波次生成
  // ============================================================

  /** 清理已摧毁的 NPC(从列表移除 + 击杀计数 + 各系统注销,防内存泄漏) */
  private cleanupDeadNpcs(): void {
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      if (this.npcs[i].dead) {
        const tank = this.npcs[i].controlledTank;
        const weapon = this.npcWeapons[i];
        this._killCount++;
        this.npcs.splice(i, 1);
        this.npcWeapons.splice(i, 1);
        this.npcByTank.delete(tank);
        // 从各系统注销:死后不再参与补给/碰撞判定,释放 Map 引用
        this.resupply.unregister(tank);
        weapon.removeTank(tank.id);
        this.destruction.unregisterTank(tank);
        // 从占领判定注销:死后不再算"敌方在场据点"
        this.capture.unregisterEnemy(tank);
        log.info('npc destroyed', { tank: tank.displayName, killCount: this._killCount });
      }
    }
  }

  /** 调度生成:存活 NPC < targetConcurrent 时计时,达 spawnInterval 补一个;玩家死则停 */
  private scheduleSpawn(dt: number): void {
    if (this.playerDead) return; // Game Over:不再生成
    if (this.npcs.length >= CONFIG.enemyFaction.targetConcurrent) {
      this.spawnTimer = 0;
      return;
    }
    this.spawnTimer += dt;
    if (this.spawnTimer >= CONFIG.enemyFaction.spawnInterval) {
      this.spawnTimer = 0;
      this.spawnCounter++;
      this.spawnEnemy();
    }
  }

  /**
   * 生成一个新 NPC:从 reserveVariants/spawnPoints 轮询创建坦克实体,
   * 接入 destruction(受击)+ resupply(装填),创建 NpcController 驱动。
   * 轮询参数后委托 spawnEnemyAt(核心逻辑),DebugConsole 直接调 spawnEnemyAt 指定参数。
   */
  private spawnEnemy(): void {
    const variants = CONFIG.enemyFaction.reserveVariants;
    const variant = variants[this.spawnCounter % variants.length];
    const points = CONFIG.enemyFaction.spawnPoints;
    const point = points[this.spawnCounter % points.length];
    // tier 轮询(rookie→regular→veteran),供 createTank 外观 + NpcController 共用
    const tiers: NpcTier[] = ['rookie', 'regular', 'veteran'];
    const tierKey = tiers[this.spawnCounter % tiers.length];
    this.spawnEnemyAt({ variant, tier: tierKey, x: point.x, z: point.z });
  }

  /**
   * 在指定位置生成敌方坦克(完整接入各系统的核心逻辑)。
   * ------------------------------------------------------------
   * spawnEnemy(轮询参数) 与 DebugConsole(指定参数)共用此入口,
   * 保证调试生成的 NPC 与波次生成的 NPC 行为/接入完全一致。
   */
  spawnEnemyAt(opts: { variant: string; tier: NpcTier; x: number; z: number }): void {
    const { variant, tier, x, z } = opts;
    const tank = createTank(variant, this.physics, this.render, { x, y: 0, z }, 0, tier);
    if (tank instanceof StaticTankBase) this.destruction.addStaticTank(tank);
    this.allTanks.push(tank); // 共享引用 → destruction.controllableTanks 自动包含(炮弹伤害)
    this.destruction.registerTank(tank); // 补 collider 映射(撞击判定)
    tank.possess(); // fixed→dynamic 可驾驶
    const controller = new TankController(tank, this.render);
    const weapon = new WeaponSystem(() => tank, this.physics, this.render, undefined, this.destruction);
    const profile = resolveNpcProfile(tier);
    // M3:veteran 注入技能(rookie/regular 不传,保持纯机械 AI)
    const skill = tier === 'veteran' ? new SkillSystem(() => tank) : undefined;
    const npc = new NpcController(tank, controller, weapon, () => this.enemiesOf(tank), this.physics, profile, this.resupply, () => this.posture, skill);
    npc.setMission(this.pickPatrolMission());
    this.npcs.push(npc);
    this.npcWeapons.push(weapon);
    this.npcByTank.set(tank, npc);
    this.resupply.register(tank, weapon);
    // 注册到占领系统:补充的 NPC 也纳入占领判定
    this.capture.registerEnemy(tank);
    log.info('npc spawned', { tank: tank.displayName, variant, tier: profile.name, at: `${x.toFixed(0)},${z.toFixed(0)}`, alive: this.npcs.length });
  }

  // ============================================================
  // A2 姿态调控
  // ============================================================

  /** 评估态势切换全阵营姿态:玩家残血→aggro、NPC 残血→defensive、否则 normal */
  private evaluatePosture(dt: number): void {
    this.postureEvalTimer -= dt;
    if (this.postureEvalTimer > 0) return;
    this.postureEvalTimer = CONFIG.director.postureEvalInterval;
    if (!this.playerTank || this.playerTank.state !== 'intact') {
      this.setPosture('normal');
      return;
    }
    const playerHpRatio = this.playerTank.getHp() / CONFIG.tank.damage.maxHp;
    if (playerHpRatio < CONFIG.director.aggroPlayerHpRatio) {
      this.setPosture('aggro');
      return;
    }
    if (this.avgNpcHpRatio() < CONFIG.director.defensiveNpcHpRatio) {
      this.setPosture('defensive');
      return;
    }
    this.setPosture('normal');
  }

  private setPosture(p: Posture): void {
    if (this.posture !== p) {
      log.info('posture change', { from: this.posture, to: p });
      this.posture = p;
    }
  }

  /** 存活 NPC 平均血量比例 */
  private avgNpcHpRatio(): number {
    if (this.npcs.length === 0) return 1;
    let sum = 0;
    for (const npc of this.npcs) sum += npc.hpRatio;
    return sum / this.npcs.length;
  }

  // ============================================================
  // B1 目标/诊断(HUD 用)
  // ============================================================

  /** 玩家击毁的 NPC 数(分数) */
  get killCount(): number {
    return this._killCount;
  }

  /** 玩家是否已死亡(Game Over) */
  get playerDead(): boolean {
    return this.playerTank?.state === 'destroyed';
  }

  /** 碰撞分发:转发给所有 NPC weapon(各自管自己的炮弹集合) */
  handleCollision(h1: number, h2: number): void {
    for (const w of this.npcWeapons) w.handleCollision(h1, h2);
  }

  /** 诊断:NPC 数 */
  get stats(): { npcs: number } {
    return { npcs: this.npcs.length };
  }

  /** 某坦克是否是本系统管理的 NPC(供 main 判断是否需暂停 AI / 跳过 release) */
  isNpc(tank: IControllableTank): boolean {
    return this.npcByTank.has(tank);
  }

  /** 标记某 NPC 暂停/恢复(玩家附身时暂停 AI 避免双重控制;切走时恢复)。非 NPC 无效 */
  setNpcPaused(tank: IControllableTank, paused: boolean): void {
    const npc = this.npcByTank.get(tank);
    if (npc) npc.paused = paused;
  }

  // ============================================================
  // LLM 接入点(未来)
  // ------------------------------------------------------------
  // 当前已实现的导演能力(规则式,执行体就绪,LLM 可直接调用):
  //  - spawnEnemy():动态生成 NPC(A1 波次补充)
  //  - setPosture(p):切换全阵营姿态(A2,evaluatePosture 自动评估)
  // 未来 LLM 导演可叠加的更高层工具:
  //  - assignPatrol(npcIdx, areaId):给指定 NPC 分配巡逻区(目前 pickPatrolMission 轮询)
  //  - getOverview():返回全局态势(双方血量/姿态/击杀数)供 LLM 决策
  // 规则式骨架已就绪;LLM 接入时只需替换 evaluatePosture/scheduleSpawn 的决策来源,
  // 执行体(spawnEnemy/NpcController)不变。
  // ============================================================
}
