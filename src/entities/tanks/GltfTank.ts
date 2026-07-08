/**
 * GltfTank.ts — 使用外部 glb 美术资产的精细化坦克
 * ============================================================
 * 与 T14Tank 平级,extends TankBase。视觉来源是 GltfTankAsset(加载 glb),
 * 物理规格/驾驶手感/破坏逻辑复用 T14 基准(玩家型 dynamic 可驾驶)。
 *
 * 与 T14Tank 的差异:
 *  - buildVisuals:走 GltfTankAsset.build(而非 TankVisualBuilder.buildCustom)
 *  - updateTracks:override 为空(glb 履带烘焙死,不可滚动)
 *  - 物理碰撞体:用 CONFIG.tank.bodyHalf(和 T14 一致),视觉 glb 归一化对齐
 *
 * 接入路径:registry.ts 加 case 'gltf' → CONFIG.tanks 加一条 variant:'gltf' 条目。
 * 不影响现有 T14/虎式/M1(零回归)。
 */
import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import type { DriveConfig } from '../IControllableTank';
import type { Fragment } from '../Destructible';
import { TankBase, type TankSpec, type TankVisuals } from './TankBase';
import { GltfTankAsset } from '../GltfTankAsset';
import { Logger } from '../../utils/Logger';

const log = Logger.create('GltfTank');

export class GltfTank extends TankBase {
  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    spawn: { x: number; y: number; z: number },
    yaw = 0,
  ) {
    // 物理 dynamic,collider 在 body 中心(无 offset)。spawn.y 是地面,抬高到车身中心
    const bh = CONFIG.tank.bodyHalf;
    super(physics, render, { x: spawn.x, y: spawn.y + bh.y + 0.1, z: spawn.z });
    // 初始朝向(锁 X/Z 旋转,仅 Y,初始 yaw 不被物理推翻)
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    log.info('glb tank spawned', { at: `${spawn.x},${spawn.z}`, yaw });
  }

  protected getSpec(): TankSpec {
    const d = CONFIG.tank.damage;
    return {
      name: `GltfTank`, // 编辑器/日志显示名(可按需改)
      bodyHalf: CONFIG.tank.bodyHalf, // 复用 T14 物理尺寸(视觉 glb 归一化对齐)
      mass: CONFIG.tank.mass,
      initialBodyType: RAPIER.RigidBodyType.Dynamic,
      damage: {
        maxHp: d.maxHp,
        smokeThreshold: d.smokeThreshold,
        destroyExplosionScale: d.destroyExplosionScale,
        destroySmokeScale: d.destroySmokeScale,
        regenDelay: d.regenDelay, // 玩家型也带脱战回血
        regenRate: d.regenRate,
      },
      smokeOffset: { x: 0, y: 1.2, z: 0 },
    };
  }

  get driveConfig(): DriveConfig {
    // 复用 T14 驾驶手感(物理参数一致,手感一致)
    const c = CONFIG.tank;
    return {
      moveSpeed: c.moveSpeed,
      turnSpeed: c.turnSpeed,
      accelLerp: c.accelLerp,
      reverseScale: c.reverseScale,
      turret: { turnSpeed: c.turret.turnSpeed, omegaLerp: c.turret.omegaLerp },
      barrel: { pitchRange: c.barrel.pitchRange, pitchSpeed: c.barrel.pitchSpeed },
      track: { offsetX: c.track.offsetX, halfZ: c.track.halfZ, rollScale: c.track.rollScale },
      camera: { offset: c.camera.offset, lookOffset: c.camera.lookOffset, lerp: c.camera.lerp },
      dust: { minSpeed: c.dust.minSpeed, spawnPerMeter: c.dust.spawnPerMeter },
      sway: { pitchScale: c.sway.pitchScale, rollScale: c.sway.rollScale, lerp: c.sway.lerp },
    };
  }

  /**
   * 视觉构建:从 GltfTankAsset 缓存 clone 一份,按命名约定解析炮塔/炮管/炮口。
   * glb 必须已通过 GltfTankAsset.load() 预加载(main.ts 启动时)。
   * 缺失语义节点会抛错(明确告知缺哪个命名),由构造向上冒泡。
   */
  protected buildVisuals(): TankVisuals {
    // 按 T14 物理车长归一化 glb 视觉尺寸(视觉与物理碰撞体对齐)
    const targetZ = CONFIG.tank.bodyHalf.z * 2;
    const built = GltfTankAsset.build(targetZ);
    return {
      group: built.group,
      hullSway: undefined, // glb 无车身摇晃
      turret: built.turret,
      barrel: built.barrel,
      muzzle: built.muzzle,
      leftTrackTex: built.leftTrackTex,
      rightTrackTex: built.rightTrackTex,
      barrelBaseZ: built.barrelBaseZ,
    };
  }

  /** glb 履带烘焙死,不可滚动 → override 为空操作(避免改 TankBase 类型签名) */
  updateTracks(_leftVel: number, _rightVel: number, _dt: number): void {
    // 空操作:glb 履带是贴图烘焙,无独立纹理可 offset
  }

  protected onDestroy(): Fragment[] {
    // 玩家坦克保留完整焦黑车体,不翻倒、不产生碎片(同 T14)
    return [];
  }
}
