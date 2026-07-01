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
import { CONFIG } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import { SyncBridge } from '../../core/SyncBridge';
import { Explosion } from '../../effects/Explosion';
import { Smoke } from '../../effects/Smoke';
import type { IControllableTank, DriveConfig } from '../IControllableTank';
import type { Fragment } from '../Destructible';
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

  protected readonly spec: TankSpec;
  protected readonly physics: PhysicsWorld;
  protected readonly render: RenderScene;
  protected readonly leftTrackTex: CanvasTexture;
  protected readonly rightTrackTex: CanvasTexture;

  private hp: number;
  private readonly startHp: number;
  private smoke?: Smoke;
  private readonly explosions: Explosion[] = [];
  protected turretBody?: RAPIER.RigidBody;
  private readonly _barrelBaseZ: number;

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

  constructor(physics: PhysicsWorld, render: RenderScene, spawn: { x: number; y: number; z: number }) {
    this.physics = physics;
    this.render = render;
    this.spec = this.getSpec();
    this.startHp = this.spec.damage.maxHp;
    this.hp = this.startHp;

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

  /** 每帧更新：烟 + 击毁爆炸粒子 */
  update(dt: number): void {
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
