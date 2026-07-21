import RAPIER from '@dimforge/rapier3d-compat';
import { CONFIG, type Team } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import type { DriveConfig } from '../IControllableTank';
import type { Fragment } from '../Destructible';
import { TankBase, type TankSpec, type TankVisuals } from './TankBase';
import { TankDataStore } from '../../data/TankDataStore';
import { TankVisualBuilder } from '../TankVisualBuilder';
import { convertT14ToModel } from '../../data/convertLegacy';

/**
 * 玩家 T-14 坦克
 * ------------------------------------------------------------
 * 俄罗斯 T-14 Armata 造型:7 对负重轮、无人炮塔、阿富汗石主动防御、
 * 车体悬挂摇晃、战术编号贴花。
 *
 * 视觉构建委托 TankVisualBuilder(游戏+编辑器共用的唯一几何构建源),
 * 数据从 TankDataStore 取(运行时加载 JSON)。
 */
export class T14Tank extends TankBase {
  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    spawn: { x: number; y: number; z: number },
    team: Team,
    /** 朝向角(弧度,绕 y)。0=面向 +z。与 StaticTankBase 对齐,支持配置朝向 */
    yaw = 0,
  ) {
    // T-14 是 dynamic,collider 在 body 中心(无 offset);配置 spawn.y 是地面,抬高到车身中心
    const bh = CONFIG.tank.bodyHalf;
    super(physics, render, { x: spawn.x, y: spawn.y + bh.y + 0.1, z: spawn.z }, team);
    // setRotation 设初始朝向;enabledRotations 锁 X/Z 只留 Y,初始 yaw 不被物理推翻
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  }

  protected getSpec(): TankSpec {
    const d = CONFIG.tank.damage;
    return {
      name: `T-14 ${CONFIG.tank.colors.number}`,
      bodyHalf: CONFIG.tank.bodyHalf,
      mass: CONFIG.tank.mass,
      initialBodyType: RAPIER.RigidBodyType.Dynamic,
      damage: {
        maxHp: d.maxHp,
        smokeThreshold: d.smokeThreshold,
        destroyExplosionScale: d.destroyExplosionScale,
        destroySmokeScale: d.destroySmokeScale,
        // 不传 regenDelay/regenRate → 玩家坦克无脱战回血
      },
      smokeOffset: { x: 0, y: 1.2, z: 0 },
    };
  }

  get driveConfig(): DriveConfig {
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

  protected onDestroy(): Fragment[] {
    // 玩家坦克保留完整焦黑车体,不翻倒、不炸飞炮塔、不产生碎片
    return [];
  }

  /**
   * 视觉构建:Phase C 起改用 buildCustom(数据驱动部件组合式)。
   * 流程:TankDataStore 取 T14Data → convertT14ToModel 转 TankModel → buildCustom 构建。
   * 与原 buildT14 等价(零回归):convertT14FromConfig 验证 mesh 数对齐,buildCustom 分配逻辑核对通过。
   */
  protected buildVisuals(): TankVisuals {
    const data = TankDataStore.getT14();
    const model = convertT14ToModel(data, {
      mass: CONFIG.tank.mass,
      maxHp: CONFIG.tank.damage.maxHp,
      damage: {
        smokeThreshold: CONFIG.tank.damage.smokeThreshold,
        destroyExplosionScale: CONFIG.tank.damage.destroyExplosionScale,
        destroySmokeScale: CONFIG.tank.damage.destroySmokeScale,
      },
    });
    const built = TankVisualBuilder.buildCustom(model, { camoSeed: this.id });
    return {
      group: built.group,
      hullSway: built.hullSway,
      turret: built.turret,
      barrel: built.barrel,
      muzzle: built.muzzle,
      leftTrackTex: built.leftTrackTex,
      rightTrackTex: built.rightTrackTex,
      barrelBaseZ: built.barrelBaseZ,
    };
  }
}
