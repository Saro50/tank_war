import type RAPIER from '@dimforge/rapier3d-compat';
import type { Group, Object3D } from 'three';
import type { Fragment } from './Destructible';

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

  /** 显示名称(型号名)，如 "T-14 03" / "Tiger 231" / "Abrams A11" */
  readonly name: string;

  /** 实例唯一 ID(自增,从 1 开始)。区分同型号多辆,displayName 组合用 */
  readonly id: number;

  /** 展示名 = 型号名 + #id,如 "Tiger 231 #2"。HUD/日志统一用此避免重名 */
  readonly displayName: string;

  state: 'intact' | 'destroyed';

  /** 当前运行参数（手感、履带尺寸、相机偏移等） */
  readonly driveConfig: DriveConfig;

  /** 当前血量（调试用） */
  getHp(): number;

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
