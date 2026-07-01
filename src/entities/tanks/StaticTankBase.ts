import RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  CanvasTexture,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  Quaternion,
  RepeatWrapping,
  Vector3,
} from 'three';
import { CONFIG } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import { SyncBridge } from '../../core/SyncBridge';
import { Fragment } from '../Destructible';
import type { DriveConfig } from '../IControllableTank';
import {
  makeCamouflageCanvas,
  makeCrossDecalCanvas,
  makeGlacisGeometry,
  makeNumberDecalCanvas,
  makeTrackTexture,
  makeWedgeGeometry,
  makeWedgeTurretGeometry,
} from '../TankGeometryFactories';
import { TankBase, type TankSpec, type TankVisuals } from './TankBase';

/**
 * 静态展示坦克基类（虎式 / M1）
 * ------------------------------------------------------------
 * 承载静态坦克的共同逻辑：fixed 刚体、复用玩家坦克的几何工厂、
 * 击毁后翻倒/炮塔炸飞/碎片飞溅。
 */
export abstract class StaticTankBase extends TankBase {
  protected abstract readonly variant: 'tiger' | 'abrams';

  constructor(physics: PhysicsWorld, render: RenderScene, spawn: { x: number; y: number; z: number }, yaw: number) {
    super(physics, render, spawn);
    // 静态坦克出生带朝向
    this.body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  }

  protected getSpec(): TankSpec {
    const cfg = CONFIG.staticTank[this.variant];
    const hh = cfg.hull;
    return {
      name: `${this.variant === 'tiger' ? 'Tiger' : 'Abrams'} ${cfg.number}`,
      bodyHalf: {
        x: hh.topHalfX + cfg.track.halfX,
        y: hh.height,
        z: hh.bottomHalfZ,
      },
      initialBodyType: RAPIER.RigidBodyType.Fixed,
      colliderOffset: { x: 0, y: hh.height, z: 0 },
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

  protected buildVisuals(): TankVisuals {
    const variant = this.variant;
    const cfg = CONFIG.staticTank[variant];
    const c = cfg.colors;

    const camoCanvas = makeCamouflageCanvas({ base: c.camo.base, blobDark: c.camo.blobDark, blobMid: c.camo.blobMid });
    const hullTex = new CanvasTexture(camoCanvas);
    hullTex.wrapS = hullTex.wrapT = RepeatWrapping;
    hullTex.repeat.set(3, 2);
    hullTex.anisotropy = 4;

    const turretTex = new CanvasTexture(camoCanvas);
    turretTex.wrapS = turretTex.wrapT = RepeatWrapping;
    turretTex.repeat.set(4, 1);
    turretTex.anisotropy = 4;

    const mat: Record<string, MeshStandardMaterial> = {
      hull: new MeshStandardMaterial({ map: hullTex, color: 0xffffff, roughness: 0.88, metalness: 0.1 }),
      turret: new MeshStandardMaterial({ map: turretTex, color: 0xffffff, roughness: 0.82, metalness: 0.1 }),
      trackMetal: new MeshStandardMaterial({ color: c.trackMetal, roughness: 0.55, metalness: 0.5 }),
      wheelRubber: new MeshStandardMaterial({ color: c.wheelRubber, roughness: 0.95, metalness: 0.0 }),
      wheelHub: new MeshStandardMaterial({ color: c.wheelHub, roughness: 0.5, metalness: 0.6 }),
      barrel: new MeshStandardMaterial({ color: c.barrel, roughness: 0.5, metalness: 0.6 }),
      detail: new MeshStandardMaterial({ color: c.detail, roughness: 0.6, metalness: 0.4 }),
      fender: new MeshStandardMaterial({ color: c.fender, roughness: 0.86, metalness: 0.1 }),
    };

    const group = new Group();

    // 车体
    const hullGeo = makeWedgeGeometry({
      bottomHalfX: cfg.hull.bottomHalfX, topHalfX: cfg.hull.topHalfX,
      bottomHalfZ: cfg.hull.bottomHalfZ, topHalfZ: cfg.hull.topHalfZ,
      height: cfg.hull.height, centerY: cfg.hull.centerY,
    });
    const hullMesh = new Mesh(hullGeo, mat.hull);
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    group.add(hullMesh);

    const frontHatch = (cfg.hull as { frontHatch?: { halfX: number; halfY: number; halfZ: number; x: number; y: number; z: number } }).frontHatch;
    if (frontHatch) {
      const fh = frontHatch;
      const fmesh = new Mesh(new BoxGeometry(fh.halfX * 2, fh.halfY * 2, fh.halfZ * 2), mat.hull);
      fmesh.position.set(fh.x, fh.y, fh.z);
      fmesh.castShadow = true;
      group.add(fmesh);
    }

    if (cfg.hull.frontSlope) {
      const fs = cfg.hull.frontSlope;
      const fmesh = new Mesh(makeGlacisGeometry(fs.halfX, fs.halfDepth, fs.halfHeight), mat.hull);
      fmesh.position.set(fs.x, fs.y, fs.z);
      fmesh.castShadow = true;
      fmesh.receiveShadow = true;
      group.add(fmesh);
    }

    const { leftTrackTex, rightTrackTex } = this.buildTracks(group, cfg, mat);

    const turret = new Group();
    turret.position.set(cfg.turret.offset.x, cfg.turret.offset.y, cfg.turret.offset.z);
    const tb = cfg.turret.body;
    const turretGeo = tb.frontHalfZ != null && tb.backHalfZ != null
      ? makeWedgeTurretGeometry({
          bottomHalfX: tb.bottomHalfX, topHalfX: tb.topHalfX,
          bottomHalfZ: tb.bottomHalfZ, frontHalfZ: tb.frontHalfZ, backHalfZ: tb.backHalfZ,
          height: tb.height, centerY: tb.centerY,
        })
      : makeWedgeGeometry({
          bottomHalfX: tb.bottomHalfX, topHalfX: tb.topHalfX,
          bottomHalfZ: tb.bottomHalfZ, topHalfZ: tb.topHalfZ,
          height: tb.height, centerY: tb.centerY,
        });
    const turretMesh = new Mesh(turretGeo, mat.turret);
    turretMesh.castShadow = true;
    turretMesh.receiveShadow = true;
    turret.add(turretMesh);

    this.addBustle(turret, cfg.turret.bustle, mat.turret);
    this.addBustle(turret, cfg.turret.frontShield, mat.turret);
    this.addCupola(turret, cfg.turret.cupola, mat.turret);

    if (cfg.turret.sight) {
      const s = cfg.turret.sight;
      const sight = new Mesh(new BoxGeometry(s.halfX * 2, s.halfY * 2, s.halfZ * 2), mat.detail);
      sight.position.set(s.x, s.y, s.z);
      sight.castShadow = true;
      turret.add(sight);
    }

    if (cfg.turret.loaderHatch) {
      const lh = cfg.turret.loaderHatch;
      const hatch = new Mesh(new CylinderGeometry(lh.radius, lh.radius, lh.height, 14), mat.turret);
      hatch.position.set(lh.x, lh.y, lh.z);
      hatch.castShadow = true;
      turret.add(hatch);
    }

    this.addMgStation(turret, (cfg.turret as { mgStation?: any }).mgStation, mat);

    const barrel = new Group();
    barrel.position.set(cfg.barrel.offset.x, cfg.barrel.offset.y, cfg.barrel.offset.z);

    const barrelMesh = new Mesh(
      new CylinderGeometry(cfg.barrel.radius, cfg.barrel.radius, cfg.barrel.length, 16),
      mat.barrel,
    );
    barrelMesh.rotation.x = Math.PI / 2;
    barrelMesh.position.z = cfg.barrel.length / 2;
    barrelMesh.castShadow = true;
    barrel.add(barrelMesh);

    this.addMantlet(barrel, cfg.mantlet, mat.barrel);
    this.addBarrelDetail(barrel, cfg, mat.barrel);

    const muzzle = new Object3D();
    muzzle.position.set(0, 0, cfg.barrel.length);
    barrel.add(muzzle);
    turret.add(barrel);

    this.addDecals(turret, cfg, tb);

    group.add(turret);

    return {
      group,
      turret,
      barrel,
      muzzle,
      leftTrackTex,
      rightTrackTex,
      barrelBaseZ: cfg.barrel.offset.z,
    };
  }

  private buildTracks(
    group: Group,
    cfg: any,
    mat: Record<string, MeshStandardMaterial>,
  ): { leftTrackTex: CanvasTexture; rightTrackTex: CanvasTexture } {
    const tr = cfg.track;
    const rw = cfg.roadWheel;
    const straightLen = (tr.halfZ - tr.halfY) * 2;
    const straightGeo = new BoxGeometry(tr.halfX, tr.halfY * 2, straightLen);
    const returnGeo = new BoxGeometry(tr.halfX * 0.9, tr.halfY * 0.6, straightLen);
    const sprocketGeo = new CylinderGeometry(tr.halfY, tr.halfY, tr.halfX * 2, 24);
    const toothedSprocketGeo = new CylinderGeometry(tr.halfY * 1.12, tr.halfY * 1.12, tr.halfX * 2, 12);
    const wheelGeo = new CylinderGeometry(rw.radius, rw.radius, rw.halfWidth * 2, 20);
    const hubGeo = new CylinderGeometry(rw.radius * 0.6, rw.radius * 0.6, rw.halfWidth * 1.2, 16);

    const stagger = cfg.roadWheelStagger;
    let staggerGeo: CylinderGeometry | null = null;
    if (stagger) {
      staggerGeo = new CylinderGeometry(stagger.radius, stagger.radius, stagger.halfWidth * 2, 18);
    }

    const wheelZs: number[] = [];
    for (let i = 0; i < rw.count; i++) {
      wheelZs.push(-rw.zSpan + (2 * rw.zSpan * i) / (rw.count - 1));
    }

    let leftTrackTex!: CanvasTexture;
    let rightTrackTex!: CanvasTexture;

    for (const side of [-1, 1]) {
      const trackTex = makeTrackTexture(tr.texRepeat);
      trackTex.wrapS = trackTex.wrapT = RepeatWrapping;
      if (side === -1) leftTrackTex = trackTex;
      else rightTrackTex = trackTex;
      const trackMat = new MeshStandardMaterial({ color: cfg.colors.trackMetal, map: trackTex, roughness: 0.9, metalness: 0.3 });

      const track = new Mesh(straightGeo, trackMat);
      track.position.set(side * tr.offsetX, tr.centerY, 0);
      track.castShadow = true;
      track.receiveShadow = true;
      group.add(track);

      if (cfg.returnRoller) {
        const returnTrack = new Mesh(returnGeo, trackMat);
        returnTrack.position.set(side * tr.offsetX, tr.centerY + tr.halfY * 1.4, 0);
        returnTrack.castShadow = true;
        group.add(returnTrack);
      }

      for (const z of [-tr.halfZ + tr.halfY, tr.halfZ - tr.halfY]) {
        const isDrive = z > 0 && cfg.toothedSprocket;
        const sprocket = new Mesh(isDrive ? toothedSprocketGeo : sprocketGeo, mat.trackMetal);
        sprocket.rotation.z = Math.PI / 2;
        sprocket.position.set(side * tr.offsetX, tr.centerY, z);
        sprocket.castShadow = true;
        group.add(sprocket);
      }

      const rr = cfg.returnRoller;
      if (rr) {
        const rrGeo = new CylinderGeometry(rr.radius, rr.radius, rr.halfWidth * 2, 14);
        for (let i = 0; i < rr.count; i++) {
          const wz = rr.count === 1 ? 0 : -rr.zSpan + (2 * rr.zSpan * i) / (rr.count - 1);
          const rmesh = new Mesh(rrGeo, mat.wheelHub);
          rmesh.rotation.z = Math.PI / 2;
          rmesh.position.set(side * rr.offsetX, rr.centerY, wz);
          rmesh.castShadow = true;
          group.add(rmesh);
        }
      }

      for (const wz of wheelZs) {
        const wheel = new Mesh(wheelGeo, mat.wheelRubber);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(side * rw.offsetX, rw.centerY, wz);
        wheel.castShadow = true;
        group.add(wheel);
        const hub = new Mesh(hubGeo, mat.wheelHub);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(side * (rw.offsetX + rw.halfWidth), rw.centerY, wz);
        group.add(hub);
      }

      if (stagger && staggerGeo) {
        const sCount = rw.count - 1;
        for (let i = 0; i < sCount; i++) {
          const wz = -stagger.zSpan + (2 * stagger.zSpan * i) / Math.max(1, sCount - 1) + stagger.zSpan / (rw.count);
          const wheel = new Mesh(staggerGeo, mat.wheelRubber);
          wheel.rotation.z = Math.PI / 2;
          wheel.position.set(side * stagger.offsetX, stagger.centerY, wz);
          wheel.castShadow = true;
          group.add(wheel);
        }
      }

      const fg = cfg.fender;
      const fender = new Mesh(new BoxGeometry(fg.halfX * 2, fg.halfY * 2, fg.halfZ * 2), mat.fender);
      fender.position.set(side * fg.offsetX, fg.centerY, 0);
      fender.castShadow = true;
      fender.receiveShadow = true;
      group.add(fender);

      const sk = cfg.sideSkirt;
      if (sk) {
        const skirt = new Mesh(new BoxGeometry(sk.halfX * 2, sk.halfY * 2, sk.halfZ * 2), mat.fender);
        skirt.position.set(side * sk.offsetX, sk.centerY, 0);
        skirt.castShadow = true;
        skirt.receiveShadow = true;
        group.add(skirt);
      }
    }

    return { leftTrackTex, rightTrackTex };
  }

  private addBustle(turret: Group, b: any | undefined, m: MeshStandardMaterial): void {
    if (!b) return;
    const mesh = new Mesh(new BoxGeometry(b.halfX * 2, b.halfY * 2, b.halfZ * 2), m);
    mesh.position.set(b.x, b.y, b.z);
    mesh.castShadow = true;
    turret.add(mesh);
  }

  private addCupola(turret: Group, cp: any | undefined, m: MeshStandardMaterial): void {
    if (!cp) return;
    const cupola = new Mesh(new CylinderGeometry(cp.radius, cp.radius, cp.height, 14), m);
    cupola.position.set(cp.x, cp.y, cp.z);
    cupola.castShadow = true;
    turret.add(cupola);
  }

  private addMgStation(turret: Group, mg: any | undefined, mat: Record<string, MeshStandardMaterial>): void {
    if (!mg) return;
    const base = new Mesh(new BoxGeometry(mg.baseHalf.x * 2, mg.baseHalf.y * 2, mg.baseHalf.z * 2), mat.detail);
    base.position.set(mg.base.x, mg.base.y, mg.base.z);
    base.castShadow = true;
    turret.add(base);
    const barrel = new Mesh(
      new CylinderGeometry(mg.barrelRadius, mg.barrelRadius, mg.barrelLen, 10),
      mat.barrel,
    );
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(mg.barrel.x, mg.barrel.y, mg.barrel.z + mg.barrelLen / 2);
    barrel.castShadow = true;
    turret.add(barrel);
  }

  private addMantlet(barrel: Group, mn: any | undefined, m: MeshStandardMaterial): void {
    if (!mn) return;
    const mesh = new Mesh(new CylinderGeometry(mn.radius, mn.radius, mn.halfZ * 2, 20), m);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.z = mn.halfZ;
    mesh.castShadow = true;
    barrel.add(mesh);
  }

  private addBarrelDetail(barrel: Group, cfg: any, m: MeshStandardMaterial): void {
    if (cfg.muzzleBrake) {
      const mb = cfg.muzzleBrake;
      const mesh = new Mesh(new CylinderGeometry(mb.radius, mb.radius, mb.length, 16), m);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = cfg.barrel.length + mb.length / 2;
      mesh.castShadow = true;
      barrel.add(mesh);
    } else if (cfg.thermalSleeve) {
      const ts = cfg.thermalSleeve;
      const mesh = new Mesh(new CylinderGeometry(ts.radius, ts.radius, ts.length, 16), m);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.z = cfg.barrel.length * ts.posRatio;
      mesh.castShadow = true;
      barrel.add(mesh);
    }
  }

  private addDecals(turret: Group, cfg: any, tb: any): void {
    const numTex = new CanvasTexture(makeNumberDecalCanvas(cfg.number));
    numTex.anisotropy = 4;
    const numMat = new MeshStandardMaterial({ map: numTex, transparent: true, alphaTest: 0.5, depthWrite: false, roughness: 0.8 });
    const decalGeo = new PlaneGeometry(0.5, 0.5);
    for (const side of [-1, 1]) {
      const decal = new Mesh(decalGeo, numMat);
      decal.position.set(side * (tb.bottomHalfX + 0.02), tb.centerY + 0.05, -0.2);
      decal.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
      turret.add(decal);
    }

    if (cfg.decal.cross) {
      const crossTex = new CanvasTexture(makeCrossDecalCanvas());
      crossTex.anisotropy = 4;
      const crossMat = new MeshStandardMaterial({ map: crossTex, transparent: true, alphaTest: 0.5, depthWrite: false, roughness: 0.8 });
      const crossGeo = new PlaneGeometry(0.45, 0.45);
      for (const side of [-1, 1]) {
        const cross = new Mesh(crossGeo, crossMat);
        cross.position.set(side * (tb.bottomHalfX + 0.02), tb.centerY + 0.05, 0.4);
        cross.rotation.y = side > 0 ? Math.PI / 2 : -Math.PI / 2;
        turret.add(cross);
      }
    }
  }

  private blowTurret(epicenter: { x: number; y: number; z: number }): void {
    const cfg = CONFIG.staticTank[this.variant] as any;
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
