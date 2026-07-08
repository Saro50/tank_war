import RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  CanvasTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import { CONFIG, type NpcTier } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import { SyncBridge } from '../../core/SyncBridge';
import { Fragment } from '../Destructible';
import type { DriveConfig } from '../IControllableTank';
import { makeRankDecalCanvas, type CamoParams, darken } from '../TankGeometryFactories';
import { TankBase, type TankSpec, type TankVisuals } from './TankBase';
import { TankDataStore } from '../../data/TankDataStore';
import { TankVisualBuilder, type BuiltVisuals } from '../TankVisualBuilder';
import { convertTigerToModel, convertAbramsToModel } from '../../data/convertLegacy';

/**
 * NPC 难度外观配置(对应 CONFIG.combat.tierVisuals 的结构)。
 * ------------------------------------------------------------
 * 所有字段可选(rookie 全空)。用统一接口 + as 断言访问,避免 as const 联合类型
 * 的 'in' 操作符收窄问题(TS 会收窄成 Record<key,unknown> 而非具体成员)。
 */
interface TierVisual {
  /** 原色整体变暗系数(regular) */
  darken?: number;
  /** 磨损叠加(regular) */
  wearBoost?: number;
  /** 配色绝对覆盖(veteran 黑灰) */
  camoOverride?: Partial<CamoParams>;
  /** 军衔标识类型(regular chevron / veteran skull) */
  rank?: 'chevron' | 'skull';
  /** 标识颜色 */
  rankColor?: number;
}

/**
 * 静态展示坦克基类(虎式 / M1)
 * ------------------------------------------------------------
 * 承载静态坦克的共同逻辑:fixed 刚体、tier 外观(NPC 难度)、击毁翻倒/炮塔炸飞/碎片。
 *
 * 视觉构建委托 TankVisualBuilder(唯一几何构建源,游戏+编辑器共用);
 * 本类只负责 Builder 不管的【运行时装饰】:tier 配色覆盖 + 军衔贴花。
 *
 * 数据从 TankDataStore 取(运行时 JSON);maxHp/debugDrive 等非视觉参数仍从 CONFIG。
 */
export abstract class StaticTankBase extends TankBase {
  /**
   * 型号标识。必须用 getter 而非字段——TankBase 构造在 super() 内调 getSpec()
   * 读 variant,而子类字段初始化在 super() 之后,字段方案会读到 undefined。
   * getter 是原型方法,构造期即可用。
   */
  protected abstract get variant(): 'tiger' | 'abrams';

  constructor(physics: PhysicsWorld, render: RenderScene, spawn: { x: number; y: number; z: number }, yaw: number, tier?: NpcTier) {
    super(physics, render, spawn, tier);
    // 静态坦克出生带朝向
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  }

  /** 取本车型的视觉数据(从 TankDataStore) */
  private get visualData() {
    return this.variant === 'tiger' ? TankDataStore.getTiger() : TankDataStore.getAbrams();
  }

  protected getSpec(): TankSpec {
    const data = this.visualData;
    const cfg = CONFIG.staticTank[this.variant];
    return {
      name: `${this.variant === 'tiger' ? 'Tiger' : 'Abrams'} ${data.number}`,
      bodyHalf: {
        x: data.hull.topHalfX + data.track.halfX,
        y: data.hull.height,
        z: data.hull.bottomHalfZ,
      },
      initialBodyType: RAPIER.RigidBodyType.Fixed,
      colliderOffset: { x: 0, y: data.hull.height, z: 0 },
      colliderDensity: 2,
      damage: {
        maxHp: cfg.maxHp,
        smokeThreshold: CONFIG.staticTank.smokeThreshold,
        destroyExplosionScale: CONFIG.staticTank.destroyExplosionScale,
        destroySmokeScale: CONFIG.staticTank.destroySmokeScale,
      },
      smokeOffset: { x: 0, y: 1.0, z: 0 },
    };
  }

  get driveConfig(): DriveConfig {
    const c = CONFIG.tank;
    const d = CONFIG.staticTank[this.variant].debugDrive;
    return {
      moveSpeed: c.moveSpeed,
      turnSpeed: c.turnSpeed,
      accelLerp: c.accelLerp,
      reverseScale: c.reverseScale,
      turret: { turnSpeed: c.turret.turnSpeed, omegaLerp: c.turret.omegaLerp },
      barrel: { pitchRange: c.barrel.pitchRange, pitchSpeed: c.barrel.pitchSpeed },
      track: { offsetX: d.trackOffsetX, halfZ: d.trackHalfZ, rollScale: c.track.rollScale },
      camera: { offset: d.cameraOffset, lookOffset: d.cameraLookOffset, lerp: c.camera.lerp },
      dust: { minSpeed: c.dust.minSpeed, spawnPerMeter: c.dust.spawnPerMeter },
      sway: { pitchScale: c.sway.pitchScale, rollScale: c.sway.rollScale, lerp: c.sway.lerp },
    };
  }

  protected onDestroy(epicenter: { x: number; y: number; z: number }): Fragment[] {
    const cfg = CONFIG.staticTank;
    // fixed→dynamic + 爆心方向冲量翻倒
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.body.setAdditionalMass(cfg.destroyedMass, true);
    const t = this.body.translation();
    const dx = t.x - epicenter.x;
    const dz = t.z - epicenter.z;
    const d = Math.hypot(dx, dz) || 1;
    const imp = cfg.destroyImpulse;
    this.body.applyImpulse(
      { x: (dx / d) * imp, y: imp * 0.8, z: (dz / d) * imp },
      true,
    );
    this.body.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * 27, y: (Math.random() - 0.5) * 14, z: (Math.random() - 0.5) * 27 },
      true,
    );
    this.blowTurret(epicenter);
    const fragments = this.spawnFragments(t);
    return fragments;
  }

  /**
   * 视觉构建:委托 TankVisualBuilder + 追加 tier 军衔贴花。
   * ------------------------------------------------------------
   * Builder 负责纯几何(从数据);本类追加运行时 tier 装饰:
   *  - 配色覆盖:resolveTierCamo 算出 camoOverride 传 buildCustom(NPC 难度配色)
   *  - 军衔贴花:addRankDecal 在 buildCustom 产出后追加到炮塔
   *
   * Phase C:改用 buildCustom(数据驱动部件组合式),与原 buildTiger/buildAbrams 等价(零回归)。
   */
  protected buildVisuals(): TankVisuals {
    // 静态坦克物理参数(从 CONFIG.staticTank 取,mass=击毁后附加质量,isStatic=true)
    const st = CONFIG.staticTank;
    const phys = {
      mass: st.destroyedMass,
      isStatic: true as const,
      damage: {
        smokeThreshold: st.smokeThreshold,
        destroyExplosionScale: st.destroyExplosionScale,
        destroySmokeScale: st.destroySmokeScale,
      },
    };
    // 分支取精确类型数据 + 转 TankModel + buildCustom
    if (this.variant === 'tiger') {
      const data = TankDataStore.getTiger();
      const model = convertTigerToModel(data, { ...phys, maxHp: st.tiger.maxHp });
      const built = TankVisualBuilder.buildCustom(model, this.buildCtx(data.colors.camo));
      return this.toTankVisuals(built, data.turret.body);
    }
    const data = TankDataStore.getAbrams();
    const model = convertAbramsToModel(data, { ...phys, maxHp: st.abrams.maxHp });
    const built = TankVisualBuilder.buildCustom(model, this.buildCtx(data.colors.camo));
    return this.toTankVisuals(built, data.turret.body);
  }

  /** 构建上下文:迷彩种子 + 可选 tier 配色覆盖(NPC 难度外观) */
  private buildCtx(baseCamo: CamoParams): { camoSeed: number; camoOverride?: CamoParams } {
    return { camoSeed: this.id, camoOverride: this.tier ? this.resolveTierCamo(baseCamo) : undefined };
  }

  /** 把 Builder 产出转为 TankVisuals + 追加 tier 军衔贴花 */
  private toTankVisuals(built: BuiltVisuals, turretBody: { bottomHalfX: number; centerY: number }): TankVisuals {
    this.addRankDecal(built.turret, turretBody);
    return {
      group: built.group,
      turret: built.turret,
      barrel: built.barrel,
      muzzle: built.muzzle,
      leftTrackTex: built.leftTrackTex,
      rightTrackTex: built.rightTrackTex,
      barrelBaseZ: built.barrelBaseZ,
    };
  }

  /**
   * 按 tier 派生迷彩配色(M3+ NPC 难度外观)。
   * ------------------------------------------------------------
   *  rookie:  原配色不动
   *  regular: 原色 darken + wearBoost(暗沉老兵感)
   *  veteran: camoOverride 黑灰覆盖(两车型统一变黑,远距离黑色剪影)
   * darken/wearBoost 基于原色派生(tiger 灰绿/abrams 沙黄各自加深);
   * camoOverride 绝对值覆盖(veteran)。undefined(玩家/中立)→原配色(零回归)。
   */
  private resolveTierCamo(base: CamoParams): CamoParams {
    if (!this.tier) return base;
    // as TierVisual:统一接口访问,避免 as const 联合的 'in' 收窄问题
    const tierCfg = CONFIG.combat.tierVisuals[this.tier] as TierVisual;
    let params: CamoParams = { ...base };
    if (tierCfg.darken) {
      params.base = darken(base.base, tierCfg.darken);
      params.blobDark = darken(base.blobDark, tierCfg.darken);
      params.blobMid = darken(base.blobMid, tierCfg.darken);
    }
    if (tierCfg.wearBoost) {
      params.wear = Math.min(1, (base.wear ?? 0.25) + tierCfg.wearBoost);
    }
    if (tierCfg.camoOverride) {
      params = { ...params, ...tierCfg.camoOverride };
    }
    return params;
  }

  /**
   * 军衔标识贴花(M3+ NPC 难度区分):rookie 无,regular 双道杠,veteran 骷髅。
   * 贴炮塔后部两侧(z=-0.7,避开编号 z=-0.2 / 十字 z=0.4),玩家追击时可见难度。
   * 资源由 TankBase.dispose 遍历 group 统一回收(贴花 mesh 在 turret→group 树内)。
   */
  private addRankDecal(turret: Group, tb: { bottomHalfX: number; centerY: number }): void {
    const tierCfg = this.tier ? (CONFIG.combat.tierVisuals[this.tier] as TierVisual) : null;
    if (!tierCfg?.rank) return;
    const rankTex = new CanvasTexture(makeRankDecalCanvas(tierCfg.rank, tierCfg.rankColor ?? 0xffffff));
    rankTex.anisotropy = 4;
    const rankMat = new MeshStandardMaterial({
      map: rankTex,
      transparent: true,
      alphaTest: 0.5,
      depthWrite: false,
      roughness: 0.8,
    });
    const rankGeo = new PlaneGeometry(0.4, 0.4);
    for (const side of [-1, 1]) {
      const decal = new Mesh(rankGeo, rankMat);
      decal.position.set(side * (tb.bottomHalfX + 0.02), tb.centerY + 0.05, -0.7);
      decal.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      turret.add(decal);
    }
  }

  private blowTurret(epicenter: { x: number; y: number; z: number }): void {
    const cfg = CONFIG.staticTank[this.variant] as { turret: { body: { frontHalfZ?: number; backHalfZ?: number; bottomHalfZ: number; bottomHalfX: number; height: number } } };
    const tcfg = cfg.turret.body;
    const wpos = new Vector3();
    const wquat = new Quaternion();
    this.turret.getWorldPosition(wpos);
    this.turret.getWorldQuaternion(wquat);

    this.group.remove(this.turret);
    this.render.scene.add(this.turret);
    this.turret.position.copy(wpos);
    this.turret.quaternion.copy(wquat);

    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(wpos.x, wpos.y, wpos.z)
      .setRotation({ x: wquat.x, y: wquat.y, z: wquat.z, w: wquat.w })
      .setLinearDamping(0.2)
      .setAngularDamping(0.25);
    this.turretBody = this.physics.world.createRigidBody(bodyDesc);
    const halfZ = Math.max(tcfg.frontHalfZ ?? tcfg.bottomHalfZ, tcfg.backHalfZ ?? tcfg.bottomHalfZ);
    this.physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(tcfg.bottomHalfX, tcfg.height / 2, halfZ)
        .setDensity(1.5)
        .setFriction(0.6)
        .setRestitution(0.2),
      this.turretBody,
    );
    SyncBridge.bind(this.turretBody, this.turret);

    const dx = wpos.x - epicenter.x;
    const dz = wpos.z - epicenter.z;
    const d = Math.hypot(dx, dz) || 1;
    const lift = 18 + Math.random() * 8;
    const horiz = 10 + Math.random() * 6;
    this.turretBody.applyImpulse({ x: (dx / d) * horiz, y: lift, z: (dz / d) * horiz }, true);
    this.turretBody.applyTorqueImpulse(
      { x: (Math.random() - 0.5) * 15, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 15 },
      true,
    );
  }

  private spawnFragments(center: { x: number; y: number; z: number }): Fragment[] {
    const fragments: Fragment[] = [];
    const n = CONFIG.staticTank.fragmentCount;
    for (let i = 0; i < n; i++) {
      const hx = 0.15 + Math.random() * 0.2;
      const hy = 0.12 + Math.random() * 0.15;
      const hz = 0.15 + Math.random() * 0.2;
      const angle = Math.random() * Math.PI * 2;
      const rad = 1.7 + Math.random() * 0.4;
      const fx = center.x + Math.cos(angle) * rad;
      const fz = center.z + Math.sin(angle) * rad;
      const fy = 0.6 + Math.random() * 1.6;
      const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(fx, fy, fz)
        .setLinearDamping(0.1)
        .setAngularDamping(0.2);
      const fbody = this.physics.world.createRigidBody(bodyDesc);
      this.physics.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz).setDensity(6).setFriction(0.7).setRestitution(0.2),
        fbody,
      );
      const geo = new BoxGeometry(hx * 2, hy * 2, hz * 2);
      const mat = new MeshStandardMaterial({ color: 0x3a3a30, roughness: 0.95, metalness: 0.1, transparent: true });
      const fmesh = new Mesh(geo, mat);
      fmesh.castShadow = true;
      this.render.scene.add(fmesh);
      SyncBridge.bind(fbody, fmesh);
      const burst = 0.9 + Math.random() * 0.6;
      fbody.applyImpulse({ x: Math.cos(angle) * burst, y: 1.2 + Math.random() * 0.8, z: Math.sin(angle) * burst }, true);
      fbody.applyTorqueImpulse(
        { x: (Math.random() - 0.5) * 5, y: (Math.random() - 0.5) * 5, z: (Math.random() - 0.5) * 5 },
        true,
      );
      fragments.push(new Fragment(fbody, fmesh, geo, mat));
    }
    return fragments;
  }
}
