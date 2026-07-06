import RAPIER from '@dimforge/rapier3d-compat';
import {
  BufferGeometry,
  CanvasTexture,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Texture,
  Vector3,
} from 'three';
import { CONFIG, type NpcTier } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import { SyncBridge } from '../../core/SyncBridge';
import { Explosion } from '../../effects/Explosion';
import { Smoke } from '../../effects/Smoke';
import type { IControllableTank, DriveConfig } from '../IControllableTank';
import type { Fragment } from '../Destructible';
import { TankStatus, type TankPart } from '../TankStatus';
import { nextTankId } from '../TankId';
import { Logger } from '../../utils/Logger';

const log = Logger.create('TankBase');

/** 坦克物理规格 */
export interface TankSpec {
  name: string;
  bodyHalf: { x: number; y: number; z: number };
  mass?: number;
  initialBodyType: RAPIER.RigidBodyType;
  colliderOffset?: { x: number; y: number; z: number };
  colliderDensity?: number;
  lockRotations?: boolean;
  damage: {
    maxHp: number;
    smokeThreshold: number;
    destroyExplosionScale: number;
    destroySmokeScale: number;
    /** 脱战回血:最后一次受击后多少秒开始回血(可选,不设=不回血)。1VN 续战力 */
    regenDelay?: number;
    /** 回血速率(HP/秒) */
    regenRate?: number;
  };
  smokeOffset: { x: number; y: number; z: number };
}

/** 子类 buildVisuals 返回的视觉对象 */
export interface TankVisuals {
  group: Group;
  hullSway?: Group;
  turret: Group;
  barrel: Group;
  muzzle: Object3D;
  leftTrackTex: CanvasTexture;
  rightTrackTex: CanvasTexture;
  barrelBaseZ: number;
}

/**
 * 坦克抽象基类
 * ============================================================
 * 所有车型的公共逻辑：物理创建、HP、履带纹理、炮口计算、受伤、冒烟/爆炸、
 * 附身/释放、资源释放。子类只需实现外形构造、驾驶参数、击毁表现。
 */
export abstract class TankBase implements IControllableTank {
  readonly body: RAPIER.RigidBody;
  readonly colliderHandle: number;
  readonly group: Group;
  readonly turret: Group;
  readonly barrel: Group;
  readonly muzzle: Object3D;
  readonly hullSway?: Group;
  /** 实例唯一 ID(自增,从 1 开始),区分同型号多辆 */
  readonly id = nextTankId();

  state: 'intact' | 'destroyed' = 'intact';

  /**
   * 运行时状态聚合层(履带 debuff / 引擎过载 / 装甲倾斜 等临时状态统一聚合)。
   * 所有车型共享,字段初始化器构造即建。TankController/DestructionSystem 只读其系数。
   */
  readonly status = new TankStatus();

  /**
   * 弱点部位 sensor collider 列表(M2):构造时填充(炮塔 + 左右履带)。
   * sensor 不参与物理碰撞(不挡坦克/炮弹),只报碰撞事件供 AP 直击判定部位。
   * DestructionSystem 据此构建 partByCollider 反查表。
   */
  readonly partColliders: ReadonlyArray<{ handle: number; part: TankPart }>;

  /** NPC 难度档位(仅 NPC 有;undefined=玩家/中立,走原配色)。构造注入,director 决定。 */
  readonly tier?: NpcTier;

  protected readonly spec: TankSpec;
  protected readonly physics: PhysicsWorld;
  protected readonly render: RenderScene;
  protected readonly leftTrackTex: CanvasTexture;
  protected readonly rightTrackTex: CanvasTexture;

  private hp: number;
  private readonly startHp: number;
  /** 最后受击时刻(performance.now 毫秒),脱战回血计时基准 */
  private lastHitTime = 0;
  private smoke?: Smoke;
  private readonly explosions: Explosion[] = [];
  protected turretBody?: RAPIER.RigidBody;
  private readonly _barrelBaseZ: number;
  /** 调试命令 tw.hp 的安全上限:允许远超正常 maxHp,但拦截 Infinity/NaN/过大值避免日志 toFixed 异常 */
  private static readonly DEBUG_HP_CEILING = 1_000_000;

  // 复用临时对象
  private readonly _muzzleWorld = new Vector3();
  private static readonly _mDirA = new Vector3();
  private static readonly _mDirB = new Vector3();

  abstract get driveConfig(): DriveConfig;
  protected abstract getSpec(): TankSpec;
  protected abstract buildVisuals(): TankVisuals;
  protected abstract onDestroy(epicenter: { x: number; y: number; z: number }): Fragment[];

  get name(): string {
    return this.spec.name;
  }

  /** 展示名 = 型号 + #id,HUD/日志统一用此避免重名 */
  get displayName(): string {
    return `${this.name} #${this.id}`;
  }

  get barrelBaseZ(): number {
    return this._barrelBaseZ;
  }

  constructor(physics: PhysicsWorld, render: RenderScene, spawn: { x: number; y: number; z: number }, tier?: NpcTier) {
    this.physics = physics;
    this.render = render;
    this.spec = this.getSpec();
    this.startHp = this.spec.damage.maxHp;
    this.hp = this.startHp;
    this.tier = tier;

    // ---- 物理车身 ----
    const bodyDesc =
      this.spec.initialBodyType === RAPIER.RigidBodyType.Dynamic
        ? RAPIER.RigidBodyDesc.dynamic()
            .setLinearDamping(0.6)
            .setAngularDamping(2.5)
            .enabledRotations(false, true, false)
            .setCcdEnabled(true)
        : RAPIER.RigidBodyDesc.fixed();
    bodyDesc.setTranslation(spawn.x, spawn.y, spawn.z);
    this.body = physics.world.createRigidBody(bodyDesc);

    const colDesc = RAPIER.ColliderDesc.cuboid(
      this.spec.bodyHalf.x,
      this.spec.bodyHalf.y,
      this.spec.bodyHalf.z,
    )
      .setFriction(0.8)
      .setRestitution(0.0)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    if (this.spec.mass !== undefined) colDesc.setMass(this.spec.mass);
    if (this.spec.colliderDensity !== undefined) colDesc.setDensity(this.spec.colliderDensity);
    if (this.spec.colliderOffset) {
      colDesc.setTranslation(this.spec.colliderOffset.x, this.spec.colliderOffset.y, this.spec.colliderOffset.z);
    }
    const col = physics.world.createCollider(colDesc, this.body);
    this.colliderHandle = col.handle;

    // ---- 部位 sensor collider(M2 弱点部位)----
    // 挂在 body 上,sensor=true 不参与物理推挤(不改变坦克碰撞体/不挡炮弹),
    // 只开启碰撞事件供 AP 直击管线按命中部位注入 debuff。
    // 位置基于主 collider 中心(spec.colliderOffset)推导,适配各车型(T-14 无 offset,
    // 静态坦克 colliderOffset.y=bodyHalf.y 上移到车体)。
    this.partColliders = this.buildPartColliders(physics);

    // ---- 视觉构造 ----
    const visuals = this.buildVisuals();
    this.group = visuals.group;
    this.hullSway = visuals.hullSway;
    this.turret = visuals.turret;
    this.barrel = visuals.barrel;
    this.muzzle = visuals.muzzle;
    this.leftTrackTex = visuals.leftTrackTex;
    this.rightTrackTex = visuals.rightTrackTex;
    this._barrelBaseZ = visuals.barrelBaseZ;

    render.scene.add(this.group);
    SyncBridge.bind(this.body, this.group);

    log.info('tank spawned', { name: this.name, spawn });
  }

  getHp(): number {
    return this.hp;
  }

  /** 回血(M3 维修技能):clamp 到 maxHp;不影响脱战回血计时。被击毁无效。
   * 若已通过调试命令将 HP 设到超过 maxHp,维修不会把 HP 降回来。 */
  heal(amount: number): void {
    if (this.state !== 'intact') return;
    if (this.hp < this.startHp) {
      this.hp = Math.min(this.startHp, this.hp + amount);
    }
    log.debug('tank heal', { name: this.name, hp: this.hp.toFixed(1), amount: amount.toFixed(1) });
  }

  /**
   * 调试用:复活被毁坦克(DebugConsole.revive)。
   * T-14 被毁后保留焦黑车体(不翻倒),复活仅需重置状态+清冒烟,焦黑视觉残留不影响驾驶。
   * StaticTankBase 被毁后翻倒转 dynamic,复活不逆转翻倒(调试用,够开炮测试即可)。
   */
  revive(): void {
    if (this.state !== 'destroyed') return;
    this.state = 'intact';
    this.hp = this.startHp;
    this.lastHitTime = performance.now();
    if (this.smoke) {
      this.smoke.dispose();
      this.smoke = undefined;
    }
    log.info('tank REVIVE', { name: this.name });
  }

  /** 调试用:直接设置 HP(下限 0,不限制正常 maxHp,不触发被毁/冒烟逻辑)。
   * 为安全起见,拦截非有限值并用 DEBUG_HP_CEILING 做硬上限,避免 Infinity 导致 toFixed 异常。 */
  setDebugHp(value: number): void {
    if (!Number.isFinite(value)) {
      log.warn('debug setHp rejected: non-finite value', { name: this.name, value });
      console.warn(`[tw] HP 必须是有限数值,收到 ${value}`);
      return;
    }
    const clamped = Math.max(0, Math.min(TankBase.DEBUG_HP_CEILING, value));
    if (clamped !== value) {
      log.warn('debug setHp ceiling clamped', { name: this.name, requested: value, clamped });
      console.warn(`[tw] HP ${value} 超过安全上限 ${TankBase.DEBUG_HP_CEILING},已限制为 ${clamped}`);
    }
    if (this.state !== 'intact') {
      log.warn('debug setHp on destroyed tank', { name: this.name });
      console.warn('[tw] 坦克已击毁,HP 修改不会复活;如需复活请先执行 tw.revive()');
    }
    this.hp = clamped;
    log.debug('debug setHp', { name: this.name, hp: this.hp.toFixed(0), maxHp: this.startHp });
  }

  /**
   * 构建弱点部位 sensor collider(M2):炮塔 + 左右履带。
   * ------------------------------------------------------------
   * sensor=true 不参与物理碰撞(不改变坦克外形/撞击判定),仅上报碰撞事件。
   * AP 直击命中部位 sensor 时,DestructionSystem 据 handle 反查部位并注入 debuff。
   *
   * 位置/尺寸基于主 collider 中心(spec.colliderOffset)+ bodyHalf 推导:
   *  - 炮塔 sensor:主 collider 上方,包络炮塔区域(比车体小、矮、短)
   *  - 履带 sensor:车身左右两侧,覆盖履带(薄长)
   * 各车型(T-14/虎式/M1)统一逻辑,无需子类覆盖。
   */
  private buildPartColliders(physics: PhysicsWorld): { handle: number; part: TankPart }[] {
    const cx = this.spec.colliderOffset?.x ?? 0;
    const cy = this.spec.colliderOffset?.y ?? 0;
    const cz = this.spec.colliderOffset?.z ?? 0;
    const bh = this.spec.bodyHalf;
    const parts: { handle: number; part: TankPart }[] = [];

    // 炮塔 sensor:主 collider 上方 0.4m,包络炮塔
    const turretDesc = RAPIER.ColliderDesc.cuboid(bh.x * 0.7, bh.y * 0.6, bh.z * 0.4)
      .setTranslation(cx, cy + bh.y + 0.4, cz)
      .setSensor(true)
      .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
    const tc = physics.world.createCollider(turretDesc, this.body);
    parts.push({ handle: tc.handle, part: 'turret' });

    // 左右履带 sensor:车身两侧(±0.85×halfX),覆盖履带
    const trackOffX = bh.x * 0.85;
    for (const side of [-1, 1] as const) {
      const trackDesc = RAPIER.ColliderDesc.cuboid(bh.x * 0.25, bh.y * 0.8, bh.z * 0.9)
        .setTranslation(cx + side * trackOffX, cy, cz)
        .setSensor(true)
        .setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS);
      const trc = physics.world.createCollider(trackDesc, this.body);
      parts.push({ handle: trc.handle, part: 'track' });
    }
    return parts;
  }

  muzzleWorldPosition(): { x: number; y: number; z: number } {
    this.group.updateMatrixWorld(true);
    this.muzzle.getWorldPosition(this._muzzleWorld);
    return { x: this._muzzleWorld.x, y: this._muzzleWorld.y, z: this._muzzleWorld.z };
  }

  muzzleWorldDirection(): { x: number; y: number; z: number } {
    this.group.updateMatrixWorld(true);
    this.muzzle.getWorldPosition(TankBase._mDirA);
    this.barrel.getWorldPosition(TankBase._mDirB);
    TankBase._mDirA.sub(TankBase._mDirB).normalize();
    return { x: TankBase._mDirA.x, y: TankBase._mDirA.y, z: TankBase._mDirA.z };
  }

  updateTracks(leftVel: number, rightVel: number, dt: number): void {
    const f = CONFIG.tank.track.rollScale;
    this.leftTrackTex.offset.x += leftVel * dt * f;
    this.rightTrackTex.offset.x += rightVel * dt * f;
  }

  /** 玩家附身：静态坦克 fixed → dynamic，dynamic 车型无需操作 */
  possess(): void {
    if (this.state !== 'intact') return;
    if (this.spec.initialBodyType === RAPIER.RigidBodyType.Dynamic) return;
    this.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    this.body.setEnabledRotations(false, true, false, true);
    this.body.setLinearDamping(0.6);
    this.body.setAngularDamping(2.5);
    log.info('tank possessed', { name: this.name });
  }

  /** 取消附身：静态坦克恢复 fixed */
  release(): void {
    if (this.state !== 'intact') return;
    if (this.spec.initialBodyType === RAPIER.RigidBodyType.Dynamic) return;
    this.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    log.info('tank released', { name: this.name });
  }

  /**
   * 受击：扣 HP、冒烟阈值、击毁时调用子类 onDestroy。
   */
  takeHit(epicenter: { x: number; y: number; z: number }, damage: number): Fragment[] {
    if (this.state !== 'intact') return [];
    this.hp -= damage;
    this.lastHitTime = performance.now(); // 记录受击时刻,脱战回血计时基准
    const ratio = this.hp / this.startHp;
    if (ratio <= this.spec.damage.smokeThreshold) {
      this.ensureSmoke();
      const intensity = 0.3 + 0.7 * (1 - ratio / this.spec.damage.smokeThreshold);
      this.smoke!.setIntensity(intensity);
    }
    log.debug('tank hit', { name: this.name, hp: this.hp.toFixed(1), damage: damage.toFixed(1) });
    if (this.hp <= 0) {
      this.state = 'destroyed';
      this.scorch();
      const t = this.body.translation();
      this.explosions.push(new Explosion(this.render, t, this.spec.damage.destroyExplosionScale));
      if (this.smoke) this.smoke.dispose();
      this.smoke = new Smoke(
        new Vector3(this.spec.smokeOffset.x, this.spec.smokeOffset.y, this.spec.smokeOffset.z),
        this.spec.damage.destroySmokeScale,
      );
      this.group.add(this.smoke.group);
      this.smoke.setIntensity(1);
      log.info('tank DESTROYED', { name: this.name, at: t });
      return this.onDestroy(epicenter);
    }
    return [];
  }

  private ensureSmoke(): void {
    if (this.smoke) return;
    this.smoke = new Smoke(new Vector3(
      this.spec.smokeOffset.x,
      this.spec.smokeOffset.y,
      this.spec.smokeOffset.z,
    ));
    this.group.add(this.smoke.group);
  }

  /** 烧焦变黑：遍历 group 中所有 MeshStandardMaterial */
  protected scorch(): void {
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      const m = mesh.material;
      const scorchOne = (mm: Material): void => {
        const sm = mm as MeshStandardMaterial;
        if (!sm.isMaterial) return;
        if ((sm as unknown as { isMeshStandardMaterial?: boolean }).isMeshStandardMaterial) {
          sm.map = null;
          sm.color.setHex(0x141414);
          sm.roughness = 0.98;
          sm.metalness = 0.15;
          sm.transparent = false;
          sm.alphaTest = 0;
          sm.needsUpdate = true;
        }
      };
      if (Array.isArray(m)) for (const mm of m) scorchOne(mm);
      else if (m) scorchOne(m);
    });
  }

  /** 每帧更新：状态聚合层推进 + 脱战回血 + 烟 + 击毁爆炸粒子 */
  update(dt: number): void {
    // 状态层推进(无论 intact/destroyed:destroyed 后 effect 自然到期清空,无副作用且代码最简)
    this.status.update(dt);
    // 脱战回血:最后受击超 regenDelay 秒后,按 regenRate 缓慢回血(仅 intact 且未满血)
    const reg = this.spec.damage;
    if (
      reg.regenDelay !== undefined &&
      reg.regenRate !== undefined &&
      this.state === 'intact' &&
      this.hp < this.startHp &&
      performance.now() - this.lastHitTime > reg.regenDelay * 1000
    ) {
      this.hp = Math.min(this.startHp, this.hp + reg.regenRate * dt);
    }
    if (this.smoke) this.smoke.update(dt);
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      const e = this.explosions[i];
      if (e.update(dt)) continue;
      e.dispose(this.render);
      this.explosions.splice(i, 1);
    }
  }

  /** 彻底销毁：解绑刚体、移除场景、释放 GPU 资源 */
  dispose(): void {
    SyncBridge.unbind(this.body);
    this.physics.world.removeRigidBody(this.body);
    this.render.scene.remove(this.group);

    if (this.turretBody) {
      SyncBridge.unbind(this.turretBody);
      this.physics.world.removeRigidBody(this.turretBody);
      this.turretBody = undefined;
      this.render.scene.remove(this.turret);
    }

    for (const e of this.explosions) e.dispose(this.render);
    this.explosions.length = 0;
    if (this.smoke) {
      this.smoke.dispose();
      this.smoke = undefined;
    }

    const geos = new Set<BufferGeometry>();
    const mats = new Set<Material>();
    const texs = new Set<Texture>();
    this.group.traverse((obj) => {
      const mesh = obj as Mesh;
      if (!mesh.isMesh) return;
      if (mesh.geometry) geos.add(mesh.geometry);
      const m = mesh.material;
      const collect = (mm: Material): void => {
        mats.add(mm);
        const map = (mm as { map?: Texture }).map;
        if (map) texs.add(map);
      };
      if (Array.isArray(m)) for (const mm of m) collect(mm);
      else if (m) collect(m);
    });
    for (const t of texs) t.dispose();
    for (const m of mats) m.dispose();
    for (const g of geos) g.dispose();
  }
}
