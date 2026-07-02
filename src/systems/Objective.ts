import { CONFIG } from '../config';
import type { CaptureSystem } from './CaptureSystem';
import { Logger } from '../utils/Logger';

const log = Logger.create('Objective');

/** 关卡配置类型(从 CONFIG.levels 推导的判别联合,switch 按 id 收窄) */
export type LevelConfig = (typeof CONFIG.levels)[number];

/**
 * 关卡目标抽象(数据驱动获胜条件,可扩展)
 * ============================================================
 * main / HUD / Overlay 只依赖本接口的通用字段
 * (type/description/progress/target/completed),**不写死具体获胜方式**。
 *
 * 新增获胜类型只需 3 步(main/UI 主体零改动):
 *  1. 实现本接口(如 SurviveObjective 生存计时)
 *  2. createObjective 工厂加 case 分支
 *  3. config.levels 加一条关卡配置
 *
 * 这样"获胜逻辑"与"游戏循环/UI"解耦,后续扩展游玩空间不破坏现有代码。
 *
 * failed 字段(可选):部分获胜类型(如占领军)有"敌方达成目标→玩家失败"的
 *  逆向失败条件。kill 类无此条件(failed 为 undefined),main 胜负判定中
 *  `objective.failed || director.playerDead` 兼容两种类型。
 */
export interface Objective {
  /** 目标类型标识(对应 level.objectiveType) */
  readonly type: string;
  /** UI 显示文案(数据驱动,如"击毁 15 辆敌坦")——HUD/结算面板直接显示 */
  readonly description: string;
  /** 当前进度(0..target) */
  readonly progress: number;
  /** 目标值 */
  readonly target: number;
  /** 是否已达成(=胜利) */
  readonly completed: boolean;
  /** 是否已失败(敌方达成逆向条件 → 玩家失败)。缺省=该类型无逆向失败条件 */
  readonly failed?: boolean;
}

/**
 * 击毁目标:击毁 N 辆敌坦通关。
 * progress 读导演击杀计数(getter 注入,不耦合 DirectorSystem 类型)。
 */
export class KillObjective implements Objective {
  readonly type = 'kill';
  readonly failed = undefined;
  constructor(
    readonly target: number,
    private readonly descriptionText: string,
    private readonly getCount: () => number,
  ) {}
  get progress(): number {
    return Math.min(this.getCount(), this.target);
  }
  get description(): string {
    return this.descriptionText;
  }
  get completed(): boolean {
    return this.getCount() >= this.target;
  }
}

/**
 * 占领目标:玩家累计占领据点 N 秒通关;敌方累计占领 M 秒则玩家失败。
 * ------------------------------------------------------------
 * progress/target/completed 读 CaptureSystem(占领逻辑与获胜判定解耦:
 *  CaptureSystem 只维护进度值,本类只读不写)。
 * failed:敌方占领达 enemyTarget → true(逆向失败条件,本类独有)。
 */
export class CaptureObjective implements Objective {
  readonly type = 'capture';
  constructor(
    private readonly capture: CaptureSystem,
    readonly target: number,
    private readonly descriptionText: string,
  ) {}
  get progress(): number {
    return Math.min(this.capture.playerProgress, this.target);
  }
  get description(): string {
    return this.descriptionText;
  }
  get completed(): boolean {
    return this.capture.playerCaptured;
  }
  get failed(): boolean {
    return this.capture.enemyCaptured;
  }
}

/** createObjective 的依赖项(由 main 注入,工厂按 level.objectiveType 选用) */
export interface ObjectiveDeps {
  /** 击毁计数 getter(歼灭战用,读 DirectorSystem.killCount) */
  getKillCount: () => number;
  /** 占领系统(占领军用,读双方进度)。歼灭战时仍传入(系统始终存在,无 zone 时空转) */
  capture: CaptureSystem;
}

/**
 * 目标工厂:按 level 配置创建对应实现。
 * 新增获胜类型在此加 case(如 'survive' → SurviveObjective)。
 * 未知类型回退 kill 并告警(永不静默失败)。
 *
 * @param level   关卡配置(从 CONFIG.levels 取,switch 按 id 收窄类型)
 * @param deps    依赖(getKillCount / capture),由 main 注入
 */
export function createObjective(level: LevelConfig, deps: ObjectiveDeps): Objective {
  // 拓宽为 string 供 default 日志记录:switch 内 case 已覆盖所有字面量,
  // default 分支 level 会被 TS 收窄为 never(无法再访问其字段),故提前取别名。
  const objectiveType: string = level.objectiveType;
  switch (level.objectiveType) {
    case 'kill':
      return new KillObjective(level.target, level.brief, deps.getKillCount);
    case 'capture':
      return new CaptureObjective(deps.capture, level.target, level.brief);
    default:
      // 运行期兜底(as const 下编译期不可达,但防御配置手改)
      log.warn('unknown objective type, fallback to kill', { type: objectiveType });
      return new KillObjective(15, '击毁 15 辆敌坦', deps.getKillCount);
  }
}
