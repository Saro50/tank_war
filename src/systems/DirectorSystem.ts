import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { TankController } from './TankController';
import { WeaponSystem } from './WeaponSystem';
import type { DestructionSystem } from './DestructionSystem';
import { NpcController, type NpcMission } from '../ai/NpcController';
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
  /** 每辆坦克的阵营(与 allTanks 同序),用于敌我判定 */
  private teams: string[];

  constructor(
    private readonly physics: PhysicsWorld,
    private readonly render: RenderScene,
    private readonly destruction: DestructionSystem,
    private readonly allTanks: IControllableTank[],
  ) {
    // 从 CONFIG.tanks 派生阵营(与 allTanks 同序;buildTanks 保证顺序一致)
    this.teams = CONFIG.tanks.map((t) => t.team ?? 'neutral');
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
      const npc = new NpcController(tank, controller, weapon, () => this.enemiesOf(tank), this.physics);
      npc.setMission(this.pickPatrolMission());
      this.npcs.push(npc);
      this.npcWeapons.push(weapon);
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

  /** 选一个巡逻任务(首期:按已有 NPC 数轮询 patrolAreas,错开区域) */
  private pickPatrolMission(): NpcMission {
    const areas = CONFIG.enemyFaction.patrolAreas;
    const area = areas[this.npcs.length % areas.length];
    return { type: 'patrol', waypoints: area.waypoints.map((w) => ({ x: w.x, z: w.z })) };
  }

  /** step 前:所有 NPC 决策 + applyDrive */
  updateDrive(dt: number): void {
    for (const npc of this.npcs) npc.preStep(dt);
  }

  /** step 后:所有 NPC applyAim + weapon */
  update(dt: number): void {
    for (const npc of this.npcs) npc.postStep(dt);
  }

  /** 碰撞分发:转发给所有 NPC weapon(各自管自己的炮弹集合) */
  handleCollision(h1: number, h2: number): void {
    for (const w of this.npcWeapons) w.handleCollision(h1, h2);
  }

  /** 诊断:NPC 数 */
  get stats(): { npcs: number } {
    return { npcs: this.npcs.length };
  }

  // ============================================================
  // LLM 接入点(未来):以下为 LLM 导演工具的首期占位/雏形。
  // 当前首期用 initNpcs 静态生成 + pickPatrolMission 机械分配。
  // 未来 LLM 调用 spawnEnemy/assignPatrol/setPosture 调控节奏,执行体复用。
  // ============================================================
  // spawnEnemy(variant, spawnIdx) { ... 新建 StaticTank+possess+NpcController ... }
  // assignPatrol(npcIdx, areaId) { ... this.npcs[npcIdx].setMission(...) ... }
  // setPosture('aggro'|'normal'|'defensive') { ... 调整 NPC sightRange/fireRange ... }
  // getOverview() { ... 返回全局态势给 LLM 决策 ... }
}
