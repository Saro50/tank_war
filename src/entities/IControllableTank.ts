import type RAPIER from '@dimforge/rapier3d-compat';
import type { Group, Object3D } from 'three';
import type { Fragment } from './Destructible';
import type { TankStatus, TankPart } from './TankStatus';
import type { NpcTier, Team } from '../config';

/**
 * 可驾驶坦克的运行参数
 * ------------------------------------------------------------
 * 把手感/几何参数从全局 CONFIG 中解耦，让不同车型（T-14/虎式/M1）
 * 都能被同一套 TankController 驾驶。
 */
export interface DriveConfig {
  moveSpeed: number;
  turnSpeed: number;
  accelLerp: number;
  reverseScale: number;
  turret: {
    turnSpeed: number;
    omegaLerp: number;
  };
  barrel: {
    pitchRange: { min: number; max: number };
    pitchSpeed: number;
  };
  track: {
    offsetX: number;
    halfZ: number;
    rollScale: number;
  };
  camera: {
    offset: { x: number; y: number; z: number };
    lookOffset: { x: number; y: number; z: number };
    lerp: number;
  };
  dust: {
    minSpeed: number;
    spawnPerMeter: number;
  };
  sway: {
    pitchScale: number;
    rollScale: number;
    lerp: number;
  };
}

/**
 * 统一可控制坦克接口
 * ------------------------------------------------------------
 * 玩家 T-14（Tank）和静态展示坦克（StaticTank）都实现此接口，
 * 这样 TankController / WeaponSystem / DestructionSystem 无需关心具体车型。
 */
export interface IControllableTank {
  readonly body: RAPIER.RigidBody;
  readonly colliderHandle: number;
  readonly group: Group;
  readonly turret: Group;
  readonly barrel: Group;
  readonly muzzle: Object3D;
  readonly hullSway?: Group;

  /**
   * 弱点部位 collider 列表(M2):主 collider 之外追加的炮塔/履带 sensor collider。
   * 每项含 collider handle + 部位标签;DestructionSystem 据此构建 partByCollider
   * 反查表,AP 直击命中部位 collider 时注入对应 debuff 到 status。
   * hull 不在此列表(主 collider 兜底登记为 hull)。
   */
  readonly partColliders: ReadonlyArray<{ handle: number; part: TankPart }>;

  /** 显示名称(型号名)，如 "T-14 03" / "Tiger 231" / "Abrams A11" */
  readonly name: string;

  /** 实例唯一 ID(自增,从 1 开始)。区分同型号多辆,displayName 组合用 */
  readonly id: number;

  /** 展示名 = 型号名 + #id,如 "Tiger 231 #2"。HUD/日志统一用此避免重名 */
  readonly displayName: string;

  /**
   * NPC 难度档位(仅 NPC 有;玩家 T-14/中立静态坦克 undefined)。
   * 决定外观配色 + 炮塔军衔标识(M3+),让玩家一眼识别敌方难度。
   * undefined → buildVisuals 走原配色(零回归)。
   */
  readonly tier?: NpcTier;

  /**
   * 阵营(构造注入,所有坦克必有)。
   * 迷雾系统据此判定显隐:只隐藏 team==='enemy',中立靶子(neutral)始终可见。
   */
  readonly team: Team;

  state: 'intact' | 'destroyed';

  /** 当前运行参数（手感、履带尺寸、相机偏移等） */
  readonly driveConfig: DriveConfig;

  /**
   * 运行时状态聚合层(临时 buff/debuff 统一聚合)。
   * 所有"会改变机动/受击参数"的临时状态(履带 debuff/引擎过载/装甲倾斜)
   * 经此聚合,TankController/DestructionSystem 只读最终系数。
   * 详见 TankStatus 类注释。
   */
  readonly status: TankStatus;

  /** 当前血量（调试用） */
  getHp(): number;

  /** 最大血量(=初始血量)。姿态评估等需按车型自身 maxHp 算比例,而非硬编码 CONFIG */
  getMaxHp(): number;

  /**
   * 回血(M3 维修技能用,与 takeHit 扣血反向)。
   * clamp 到 maxHp;不影响脱战回血计时(lastHitTime)。被击毁无效。
   */
  heal(amount: number): void;

  /**
   * 调试用:复活被毁坦克(DebugConsole.revive 调用)。
   * state→intact、hp→maxHp、清冒烟;焦黑视觉残留(不影响驾驶)。
   * 仅 destroyed 状态生效,intact 调用无副作用。
   */
  revive(): void;

  /** 调试用:直接设置 HP(下限 0,不限制正常 maxHp,不触发被毁/冒烟逻辑,DebugConsole.hp 用) */
  setDebugHp(value: number): void;

  muzzleWorldPosition(): { x: number; y: number; z: number };
  muzzleWorldDirection(): { x: number; y: number; z: number };

  /** 炮管基座 z（回缩动画叠加于此） */
  readonly barrelBaseZ: number;

  /** 更新履带纹理滚动 */
  updateTracks(leftVel: number, rightVel: number, dt: number): void;

  /** 受击（由 DestructionSystem 调用） */
  takeHit(epicenter: { x: number; y: number; z: number }, damage: number): Fragment[];

  /** 每帧更新（烟、爆炸粒子等） */
  update(dt: number): void;

  /** 被玩家附身时调用（StaticTank 需要 fixed→dynamic） */
  possess(): void;

  /** 取消附身时调用（StaticTank 恢复 fixed） */
  release(): void;

  /** 彻底销毁 */
  dispose(): void;
}
