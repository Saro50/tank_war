import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import type { CaptureZone } from '../entities/CaptureZone';
import type { CaptureOwner } from '../entities/CaptureZone';
import { Logger } from '../utils/Logger';

const log = Logger.create('Capture');

/**
 * 占领系统(仅占领军关卡激活;歼灭战无 zone 时 update 自动空转)
 * ============================================================
 * 职责:
 *  1. 持有占领点(CaptureZone)与进度状态(player/enemy 双向独立累计)。
 *  2. 每帧扫描区域内坦克集合,按阵营归属推进/回退进度,判定 owner 状态。
 *  3. 推送视觉到 CaptureZone(实体不自己计时,职责单一)。
 *
 * 阵营(team)用"注册到哪个集合"决定,而非坦克固有字段:
 *  - 玩家:registerPlayer(getter) —— getter 动态返回 switcher.activeTank。
 *          原因:Tab 附身敌方 NPC 时那辆坦克应算 player(操控方),team 是操控属性
 *          而非坦克身份属性。
 *  - 敌方:registerEnemy(tank)/unregisterEnemy(tank) —— director 创建/摧毁 NPC 时调。
 *
 * 进度推进规则(见 CONFIG.capturePoint):
 *  - 只玩家在 → playerProgress += playerRate
 *  - 只敌方在 → enemyProgress  += enemyRate
 *  - 双方同区(contestedFreeze=true)→ 冻结(避免"站着蹭")
 *  - 空区/非冻结争夺 → 双方按 decayRate 回退(避免"蹭一下就稳住")
 *
 * 胜负不在本系统判定:仅维护进度值,Objective 通过 getter 读取判定,
 *  保持占领逻辑与获胜条件解耦(未来加积分模式可复用同一套进度)。
 */
export class CaptureSystem {
  /** 占领点;undefined=未激活(歼灭战或占领军未选关)。update 时据此跳过 */
  private zone?: CaptureZone;
  /** 玩家坦克 getter(动态:Tab 切换附身坦克后跟随) */
  private getPlayerTank?: () => IControllableTank;
  /** 敌方坦克集合(director 创建 NPC 时 add,摧毁时 delete) */
  private readonly enemies = new Set<IControllableTank>();
  /** 玩家获胜所需秒数(setZone 时从 level 配置注入) */
  private _playerTarget = 0;
  /** 敌方致玩家失败所需秒数(setZone 时从 level 配置注入) */
  private _enemyTarget = 0;

  // —— 进度状态(Objective 通过 getter 读取判定胜负) ——
  private _playerProgress = 0;
  private _enemyProgress = 0;
  /** 上一次 owner(日志用:状态切换时输出,避免每帧刷屏) */
  private lastOwner: CaptureOwner = 'neutral';

  /**
   * 激活占领:设置占领点 + 重置进度 + 注入胜负阈值。
   * 由 main 在选关回调(占领军)时调用。歼灭战不调用 → 本系统 update 空转。
   */
  setZone(zone: CaptureZone, playerTarget: number, enemyTarget: number): void {
    this.zone = zone;
    this._playerTarget = playerTarget;
    this._enemyTarget = enemyTarget;
    this._playerProgress = 0;
    this._enemyProgress = 0;
    this.lastOwner = 'neutral';
    log.info('capture activated', {
      at: `${zone.position.x},${zone.position.z}`,
      radius: zone.radius,
      playerTarget,
      enemyTarget,
    });
  }

  /** 注册玩家坦克(玩家用 getter:Tab 切换附身坦克后跟随)。main 启动时调用 */
  registerPlayer(getTank: () => IControllableTank): void {
    this.getPlayerTank = getTank;
  }

  /** 注册敌方 NPC(director 创建 NPC 时调用) */
  registerEnemy(tank: IControllableTank): void {
    this.enemies.add(tank);
  }

  /** 注销敌方 NPC(director 清理死亡 NPC 时调用) */
  unregisterEnemy(tank: IControllableTank): void {
    this.enemies.delete(tank);
  }

  /** 每帧:扫描区域内坦克 → 推进/回退进度 → 更新视觉。由 main 主循环调用 */
  update(dt: number): void {
    if (!this.zone || !this.getPlayerTank) return;

    // —— 1. 扫描区域内坦克(按阵营) ——
    const playerTank = this.getPlayerTank();
    const playerIn =
      playerTank.state === 'intact' && this.zone.contains(playerTank.body.translation());
    let enemyIn = false;
    for (const t of this.enemies) {
      // 排除玩家当前附身的坦克(debug Tab 附身 NPC 时,该坦克已通过 getPlayerTank 算作
      //  玩家方;若此处再算敌方会变永远 contested)。符合"team 是操控属性"的设计。
      if (t === playerTank) continue;
      if (t.state === 'intact' && this.zone.contains(t.body.translation())) {
        enemyIn = true;
        break; // 任一敌坦在即算"敌方在场"
      }
    }

    // —— 2. 判定 owner(决定圆盘/光柱配色 + 进度推进方向) ——
    let owner: CaptureOwner;
    if (playerIn && enemyIn) owner = 'contested';
    else if (playerIn) owner = 'player';
    else if (enemyIn) owner = 'enemy';
    else owner = 'neutral';
    if (owner !== this.lastOwner) {
      log.info('capture owner change', { from: this.lastOwner, to: owner });
      this.lastOwner = owner;
    }

    // —— 3. 推进/回退进度(按配置规则) ——
    const cfg = CONFIG.capturePoint;
    if (cfg.contestedFreeze && owner === 'contested') {
      // 争夺冻结:双方同区进度完全不动(避免"站着蹭")
    } else if (owner === 'player') {
      this._playerProgress = Math.min(
        this._playerTarget,
        this._playerProgress + cfg.playerRate * dt,
      );
    } else if (owner === 'enemy') {
      this._enemyProgress = Math.min(
        this._enemyTarget,
        this._enemyProgress + cfg.enemyRate * dt,
      );
    } else {
      // neutral(空区) 或 contested(非冻结模式):双方按 decayRate 回退
      this._playerProgress = Math.max(0, this._playerProgress - cfg.decayRate * dt);
      this._enemyProgress = Math.max(0, this._enemyProgress - cfg.decayRate * dt);
    }

    // —— 4. 推送视觉(实体不自己计时) ——
    this.zone.updateVisual(
      owner,
      this._playerProgress,
      this._playerTarget,
      this._enemyProgress,
      this._enemyTarget,
    );
    this.zone.update(dt);
  }

  // —— Objective 读取接口(获胜判定用) ——

  /** 玩家累计占领秒数(0..playerTarget) */
  get playerProgress(): number {
    return this._playerProgress;
  }
  /** 玩家获胜所需秒数(Objective 算 progress/target 用) */
  get playerTarget(): number {
    return this._playerTarget;
  }
  /** 敌方累计占领秒数(0..enemyTarget) */
  get enemyProgress(): number {
    return this._enemyProgress;
  }
  /** 敌方致玩家失败所需秒数(Objective 算 failed 用) */
  get enemyTarget(): number {
    return this._enemyTarget;
  }
  /** 玩家是否已占满(胜利) */
  get playerCaptured(): boolean {
    return this._playerTarget > 0 && this._playerProgress >= this._playerTarget;
  }
  /** 敌方是否已占满(玩家失败) */
  get enemyCaptured(): boolean {
    return this._enemyTarget > 0 && this._enemyProgress >= this._enemyTarget;
  }

  /** 诊断 */
  get stats(): { active: boolean; owner: CaptureOwner } {
    return { active: this.zone !== undefined, owner: this.lastOwner };
  }
}
