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
  RepeatWrapping,
} from 'three';
import { CONFIG } from '../../config';
import type { PhysicsWorld } from '../../core/PhysicsWorld';
import type { RenderScene } from '../../core/RenderScene';
import type { DriveConfig } from '../IControllableTank';
import type { Fragment } from '../Destructible';
import { TankBase, type TankSpec, type TankVisuals } from './TankBase';
import {
  makeCamouflageCanvas,
  makeNumberDecalCanvas,
  makeTrackTexture,
  makeWedgeGeometry,
} from '../TankGeometryFactories';

/**
 * 玩家 T-14 坦克
 * ------------------------------------------------------------
 * 俄罗斯 T-14 Armata 造型：7 对负重轮、无人炮塔、阿富汗石主动防御、
 * 车体悬挂摇晃、战术编号贴花。
 */
export class T14Tank extends TankBase {
  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    spawn: { x: number; y: number; z: number },
    /** 朝向角(弧度,绕 y)。0=面向 +z。与 StaticTankBase 对齐,支持配置朝向 */
    yaw = 0,
  ) {
    // T-14 是 dynamic,collider 在 body 中心(无 offset);配置 spawn.y 是地面,抬高到车身中心
    const bh = CONFIG.tank.bodyHalf;
    super(physics, render, { x: spawn.x, y: spawn.y + bh.y + 0.1, z: spawn.z });
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
        regenDelay: d.regenDelay, // 脱战回血(玩家续战力,躲掩体脱战恢复)
        regenRate: d.regenRate,
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
    // 玩家坦克保留完整焦黑车体，不翻倒、不炸飞炮塔、不产生碎片
    return [];
  }

  protected buildVisuals(): TankVisuals {
    const cfg = CONFIG.tank;
    const c = cfg.colors;

    // 程序迷彩
    const camoCanvas = makeCamouflageCanvas(c.camo);
    const hullCamoTex = new CanvasTexture(camoCanvas);
    hullCamoTex.wrapS = hullCamoTex.wrapT = RepeatWrapping;
    hullCamoTex.repeat.set(3, 2);
    hullCamoTex.anisotropy = 4;

    const turretCamoTex = new CanvasTexture(camoCanvas);
    turretCamoTex.wrapS = turretCamoTex.wrapT = RepeatWrapping;
    turretCamoTex.repeat.set(4, 1);
    turretCamoTex.anisotropy = 4;

    const mat = {
      hull: new MeshStandardMaterial({ map: hullCamoTex, color: 0xffffff, roughness: 0.88, metalness: 0.1 }),
      turret: new MeshStandardMaterial({ map: turretCamoTex, color: 0xffffff, roughness: 0.82, metalness: 0.1 }),
      trackMetal: new MeshStandardMaterial({ color: c.trackMetal, roughness: 0.55, metalness: 0.5 }),
      wheelRubber: new MeshStandardMaterial({ color: c.wheelRubber, roughness: 0.95, metalness: 0.0 }),
      wheelHub: new MeshStandardMaterial({ color: c.wheelHub, roughness: 0.5, metalness: 0.6 }),
      barrel: new MeshStandardMaterial({ color: c.barrel, roughness: 0.5, metalness: 0.6 }),
      mantlet: new MeshStandardMaterial({ color: c.mantlet, roughness: 0.55, metalness: 0.5 }),
      detail: new MeshStandardMaterial({ color: c.detail, roughness: 0.6, metalness: 0.4 }),
      fender: new MeshStandardMaterial({ color: c.fender, roughness: 0.86, metalness: 0.1 }),
    };

    const group = new Group();
    const hullSway = new Group();
    const trackGroup = new Group();
    group.add(hullSway, trackGroup);

    // 车体
    const hullMesh = new Mesh(makeWedgeGeometry(cfg.hull), mat.hull);
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    hullSway.add(hullMesh);

    // 驾驶员舱盖
    const dh = cfg.stowage.driverHatch;
    const hatch = new Mesh(new CylinderGeometry(dh.radius, dh.radius, dh.height, 16), mat.hull);
    hatch.position.set(dh.x, dh.y, dh.z);
    hatch.castShadow = true;
    hullSway.add(hatch);

    // 发动机舱格栅
    const eg = cfg.stowage.engineGrille;
    const barH = (eg.halfY * 2 * 0.7) / eg.count;
    const yStep = (eg.halfY * 2) / (eg.count - 1);
    const grilleGeo = new BoxGeometry(eg.halfX * 2, barH, eg.halfThick * 2);
    for (let i = 0; i < eg.count; i++) {
      const bar = new Mesh(grilleGeo, mat.detail);
      bar.position.set(0, eg.y - eg.halfY + i * yStep, eg.z);
      bar.castShadow = true;
      hullSway.add(bar);
    }

    // 履带
    const tcfg = cfg.track;
    const trackBoxGeo = new BoxGeometry(tcfg.halfX * 2, tcfg.halfY * 2, (tcfg.halfZ - tcfg.halfY) * 2);
    const sprocketGeo = new CylinderGeometry(tcfg.halfY, tcfg.halfY, tcfg.halfX * 2, 24);
    const wheelZ = tcfg.halfZ - tcfg.halfY;

    const leftTrackTex = makeTrackTexture(tcfg.texRepeat);
    const rightTrackTex = makeTrackTexture(tcfg.texRepeat);

    const wcfg = cfg.roadWheel;
    const roadRubberGeo = new CylinderGeometry(wcfg.radius, wcfg.radius, wcfg.halfWidth * 2, 20);
    const roadHubGeo = new CylinderGeometry(wcfg.radius * 0.6, wcfg.radius * 0.6, wcfg.halfWidth * 1.2, 16);
    const wheelZs: number[] = [];
    for (let i = 0; i < wcfg.count; i++) {
      wheelZs.push(-wcfg.zSpan + (2 * wcfg.zSpan * i) / (wcfg.count - 1));
    }

    const addTrack = (side: number, tex: CanvasTexture): void => {
      const x = side * tcfg.offsetX;
      const box = new Mesh(
        trackBoxGeo,
        new MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.05 }),
      );
      box.position.set(x, tcfg.centerY, 0);
      box.castShadow = true;
      box.receiveShadow = true;
      trackGroup.add(box);

      for (const z of [-wheelZ, wheelZ]) {
        const w = new Mesh(sprocketGeo, mat.trackMetal);
        w.rotation.z = Math.PI / 2;
        w.position.set(x, tcfg.centerY, z);
        w.castShadow = true;
        w.receiveShadow = true;
        trackGroup.add(w);
      }

      for (const wz of wheelZs) {
        const rubber = new Mesh(roadRubberGeo, mat.wheelRubber);
        rubber.rotation.z = Math.PI / 2;
        rubber.position.set(side * wcfg.offsetX, wcfg.centerY, wz);
        rubber.castShadow = true;
        trackGroup.add(rubber);
        const hub = new Mesh(roadHubGeo, mat.wheelHub);
        hub.rotation.z = Math.PI / 2;
        hub.position.set(side * (wcfg.offsetX + wcfg.halfWidth), wcfg.centerY, wz);
        trackGroup.add(hub);
      }

      const f = cfg.fender;
      const fender = new Mesh(new BoxGeometry(f.halfX * 2, f.halfY * 2, f.halfZ * 2), mat.fender);
      fender.position.set(side * f.offsetX, f.centerY, 0);
      fender.castShadow = true;
      fender.receiveShadow = true;
      trackGroup.add(fender);
    };
    addTrack(-1, leftTrackTex);
    addTrack(1, rightTrackTex);

    // 炮塔
    const turret = new Group();
    turret.position.set(cfg.turret.offset.x, cfg.turret.offset.y, cfg.turret.offset.z);
    const ar = cfg.turret.armata;
    const turretBody = new Mesh(
      makeWedgeGeometry({
        bottomHalfX: ar.bottomHalfX, topHalfX: ar.topHalfX,
        bottomHalfZ: ar.bottomHalfZ, topHalfZ: ar.topHalfZ,
        height: ar.halfY * 2, centerY: ar.offsetY,
      }),
      mat.turret,
    );
    turretBody.castShadow = true;
    turretBody.receiveShadow = true;
    turret.add(turretBody);

    const addBox = (
      half: { x: number; y: number; z: number },
      offset: { x: number; y: number; z: number },
      m: MeshStandardMaterial,
    ): Mesh => {
      const mesh = new Mesh(new BoxGeometry(half.x * 2, half.y * 2, half.z * 2), m);
      mesh.position.set(offset.x, offset.y, offset.z);
      mesh.castShadow = true;
      turret.add(mesh);
      return mesh;
    };

    addBox(ar.sightCmdr.half, ar.sightCmdr.offset, mat.turret);
    addBox(ar.sightGunner.half, ar.sightGunner.offset, mat.turret);
    addBox(ar.rcws.half, ar.rcws.offset, mat.detail);

    const rcwsBarrel = new Mesh(
      new CylinderGeometry(ar.rcws.barrelRadius, ar.rcws.barrelRadius, ar.rcws.barrelLen, 10),
      mat.barrel,
    );
    rcwsBarrel.rotation.x = Math.PI / 2;
    rcwsBarrel.position.set(
      ar.rcws.offset.x,
      ar.rcws.offset.y,
      ar.rcws.offset.z + ar.rcws.half.z + ar.rcws.barrelLen / 2,
    );
    turret.add(rcwsBarrel);

    const af = cfg.turret.afghanit;
    const afghanitGeo = new CylinderGeometry(af.radius, af.radius, af.height, 10);
    for (let i = 0; i < af.count; i++) {
      const z = -af.zSpan + (2 * af.zSpan * i) / (af.count - 1);
      for (const side of [-1, 1]) {
        const tube = new Mesh(afghanitGeo, mat.detail);
        tube.rotation.z = Math.PI / 2;
        tube.position.set(side * af.offsetX, af.offsetY, z);
        turret.add(tube);
      }
    }

    const acfg = cfg.turret.antenna;
    const antennaPivot = new Object3D();
    antennaPivot.position.set(acfg.baseX, acfg.baseY, acfg.baseZ);
    antennaPivot.rotation.x = -acfg.tilt;
    const antenna = new Mesh(new CylinderGeometry(acfg.radius, acfg.radius, acfg.length, 8), mat.detail);
    antenna.position.y = acfg.length / 2;
    antennaPivot.add(antenna);
    turret.add(antennaPivot);

    const numTex = new CanvasTexture(makeNumberDecalCanvas(c.number));
    numTex.anisotropy = 4;
    const numDecalMat = new MeshStandardMaterial({
      map: numTex,
      transparent: true,
      alphaTest: 0.5,
      depthWrite: false,
      roughness: 0.8,
    });
    const decalGeo = new PlaneGeometry(0.34, 0.34);
    for (const side of [-1, 1]) {
      const decal = new Mesh(decalGeo, numDecalMat);
      decal.position.set(side * (ar.bottomHalfX + 0.02), ar.offsetY, 0.2);
      decal.rotation.y = side * Math.PI * 0.5;
      turret.add(decal);
    }

    hullSway.add(turret);

    // 炮管
    const barrel = new Group();
    barrel.position.set(cfg.barrel.offset.x, cfg.barrel.offset.y, cfg.barrel.offset.z);
    const barrelMesh = new Mesh(new CylinderGeometry(0.11, 0.11, cfg.barrel.length, 16), mat.barrel);
    barrelMesh.rotation.x = Math.PI / 2;
    barrelMesh.position.z = cfg.barrel.length / 2;
    barrelMesh.castShadow = true;
    barrel.add(barrelMesh);

    const mn = cfg.barrel.mantlet;
    const mantlet = new Mesh(new CylinderGeometry(mn.radius, mn.radius, mn.halfZ * 2, 20), mat.mantlet);
    mantlet.rotation.x = Math.PI / 2;
    mantlet.position.z = mn.halfZ;
    mantlet.castShadow = true;
    barrel.add(mantlet);

    const fe = cfg.barrel.fumeExtractor;
    const fumeExtractor = new Mesh(new CylinderGeometry(fe.radius, fe.radius, fe.length, 18), mat.barrel);
    fumeExtractor.rotation.x = Math.PI / 2;
    fumeExtractor.position.z = cfg.barrel.length * fe.posRatio;
    fumeExtractor.castShadow = true;
    barrel.add(fumeExtractor);

    const md = cfg.barrel.muzzleDevice;
    const muzzleDevice = new Mesh(new CylinderGeometry(md.radius, md.radius, md.length, 16), mat.barrel);
    muzzleDevice.rotation.x = Math.PI / 2;
    muzzleDevice.position.z = cfg.barrel.length - md.length / 2;
    muzzleDevice.castShadow = true;
    barrel.add(muzzleDevice);

    const muzzle = new Object3D();
    muzzle.position.set(0, 0, cfg.barrel.length);
    barrel.add(muzzle);
    turret.add(barrel);

    return {
      group,
      hullSway,
      turret,
      barrel,
      muzzle,
      leftTrackTex,
      rightTrackTex,
      barrelBaseZ: cfg.barrel.offset.z,
    };
  }
}
