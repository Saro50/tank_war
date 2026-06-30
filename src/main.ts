import RAPIER from '@dimforge/rapier3d-compat';
import { BoxGeometry, ConeGeometry, Mesh, MeshStandardMaterial } from 'three';
import { CONFIG } from './config';
import { PhysicsWorld } from './core/PhysicsWorld';
import { RenderScene } from './core/RenderScene';
import { SyncBridge } from './core/SyncBridge';
import { Tank } from './entities/Tank';
import { StaticTank } from './entities/StaticTank';
import { InputSystem } from './systems/InputSystem';
import { TankController } from './systems/TankController';
import { WeaponSystem } from './systems/WeaponSystem';
import { DestructionSystem } from './systems/DestructionSystem';
import { CameraShake } from './effects/CameraShake';
import { TuningPanel } from './ui/TuningPanel';
import { Logger } from './utils/Logger';

const log = Logger.create('main');

/**
 * 主入口
 * ------------------------------------------------------------
 * 主循环时序：
 *   applyDrive → physics.step → SyncBridge.sync
 *   → aimAndCamera → weapon.update → shake.update → destruction.update → render
 */
async function main(): Promise<void> {
  const container = document.getElementById('app');
  if (!container) throw new Error('mount container #app not found');

  // 调参面板(最早创建：restore 先覆盖 CONFIG 默认值，之后所有模块读到调参后的值)
  new TuningPanel();

  const physics = await PhysicsWorld.create();
  const render = new RenderScene(container);

  buildGround(physics, render);
  buildMountains(physics, render);

  // 村庄情景(在坦克之前创建，便于坦克出生在前方空地)
  const destruction = new DestructionSystem(physics, render);
  buildVillage(destruction);
  buildStaticTanks(physics, render, destruction);

  const bh = CONFIG.tank.bodyHalf;
  const tank = new Tank(physics, render, { x: 0, y: bh.y + 0.1, z: -8 });
  destruction.setTankCollider(tank.colliderHandle);

  const input = new InputSystem();
  input.attach();

  const controller = new TankController(tank, render);
  const shake = new CameraShake(render.camera);
  const weapon = new WeaponSystem(tank, physics, render, shake, destruction);

  startLoop(physics, render, input, tank, controller, weapon, shake, destruction);
  log.info('boot complete', {
    hint: '↑↓←→ 移动 / Q W 炮塔 / A S 炮管 / Space 开火',
  });
}

/** 地面 */
function buildGround(physics: PhysicsWorld, render: RenderScene): void {
  const gh = CONFIG.ground.halfSize;
  const body = physics.world.createRigidBody(
    RAPIER.RigidBodyDesc.fixed().setTranslation(0, -gh.y, 0),
  );
  physics.world.createCollider(
    RAPIER.ColliderDesc.cuboid(gh.x, gh.y, gh.z).setActiveEvents(
      RAPIER.ActiveEvents.COLLISION_EVENTS,
    ),
    body,
  );
  const mesh = new Mesh(
    new BoxGeometry(gh.x * 2, gh.y * 2, gh.z * 2),
    new MeshStandardMaterial({ color: 0x4a5d3a }),
  );
  mesh.position.set(0, -gh.y, 0);
  mesh.receiveShadow = true;
  render.scene.add(mesh);
  log.info('ground created', { topY: 0 });
}

/** 布置村庄：房屋(砖墙+屋顶) + 水泥塔 + 栅栏 + 树 */
function buildVillage(destruction: DestructionSystem): void {
  // 房屋(4 栋，砖墙 + 人字屋顶可打破洞)
  const houses = [
    { x: -16, z: 12, size: { x: 6, y: 5, z: 6 } },
    { x: 14, z: 10, size: { x: 5, y: 4, z: 5 } },
    { x: -10, z: -14, size: { x: 5, y: 4, z: 5 } },
    { x: 20, z: -12, size: { x: 6, y: 5, z: 5 } },
  ];
  for (const h of houses) {
    destruction.addHouse({ x: h.x, y: 0, z: h.z }, h.size);
  }

  // 水泥塔(2 座，弹坑式渐进破坏，村庄两侧)
  destruction.addTower({ x: -30, y: 4, z: -2 }, { x: 2, y: 7, z: 2 }, { x: 3.2, y: 1, z: 3.2 });
  destruction.addTower({ x: 32, y: 4, z: 4 }, { x: 2, y: 7, z: 2 }, { x: 3.2, y: 1, z: 3.2 });

  // 栅栏(几排，可被坦克推倒)
  destruction.addFenceRow({ x: -6, z: 22 }, { x: 8, z: 22 }, 8);
  destruction.addFenceRow({ x: -6, z: 26 }, { x: 8, z: 26 }, 8);
  destruction.addFenceRow({ x: 26, z: -22 }, { x: 38, z: -22 }, 7);

  // 树(随机散布，避开楼房/塔/栅栏/坦克出生点)
  const occupied: { x: number; z: number; r: number }[] = [
    ...houses.map((h) => ({ x: h.x, z: h.z, r: Math.max(h.size.x, h.size.z) })),
    { x: -30, z: -2, r: 3.5 },
    { x: 32, z: 4, r: 3.5 },
    { x: 0, z: -8, r: 4 }, // 玩家坦克出生点
    { x: -8, z: -30, r: 4 }, // 静态虎式
    { x: 8, z: -30, r: 4 }, // 静态 M1
  ];
  let placed = 0;
  let tries = 0;
  while (placed < 22 && tries < 300) {
    tries++;
    const x = (Math.random() * 2 - 1) * 60;
    const z = (Math.random() * 2 - 1) * 60;
    let ok = true;
    for (const o of occupied) {
      if (Math.hypot(x - o.x, z - o.z) < o.r + 2) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    destruction.addTree({ x, y: 0, z });
    occupied.push({ x, z, r: 1.5 });
    placed++;
  }
  log.info('village built', { houses: houses.length, trees: placed });
}

/** 两辆静态展示坦克(可破坏目标)，远南侧并排陈列，朝北面向村庄/玩家 */
function buildStaticTanks(
  physics: PhysicsWorld,
  render: RenderScene,
  destruction: DestructionSystem,
): void {
  // 朝向 +z(炮管指 +z = 面向村庄)。yaw=0 即默认朝向
  const tiger = new StaticTank(physics, render, { x: -8, y: 0, z: -30 }, 0, 'tiger');
  const abrams = new StaticTank(physics, render, { x: 8, y: 0, z: -30 }, 0, 'abrams');
  destruction.addStaticTank(tiger);
  destruction.addStaticTank(abrams);
  log.info('static tanks placed', { tiger: { x: -8, z: -30 }, abrams: { x: 8, z: -30 } });
}

/** 四周环形山(静态背景，fixed collider 防坦克穿出地形) */
function buildMountains(physics: PhysicsWorld, render: RenderScene): void {
  const cfg = CONFIG.mountain;
  const geo = new ConeGeometry(1, 1, 14); // 单位锥，scale 控大小
  const mat = new MeshStandardMaterial({
    color: cfg.color,
    roughness: 1,
    metalness: 0,
    flatShading: true, // low-poly 山体质感
  });
  for (let i = 0; i < cfg.count; i++) {
    const ang = (i / cfg.count) * Math.PI * 2;
    const r = cfg.ringRadius + (Math.random() - 0.5) * 8;
    const x = Math.cos(ang) * r;
    const z = Math.sin(ang) * r;
    const rad = cfg.radiusMin + Math.random() * (cfg.radiusMax - cfg.radiusMin);
    const h = cfg.heightMin + Math.random() * (cfg.heightMax - cfg.heightMin);
    const m = new Mesh(geo, mat);
    m.position.set(x, h / 2 - 2, z); // 山底埋入地面 2m 防缝隙
    m.scale.set(rad, h, rad);
    m.castShadow = true;
    m.receiveShadow = true;
    render.scene.add(m);
    // 物理：fixed 底座 cuboid(防坦克穿过山体)
    const body = physics.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(x, h / 4, z),
    );
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(rad * 0.7, h / 4, rad * 0.7),
      body,
    );
  }
  log.info('mountains built', { count: cfg.count });
}

/** 主循环 */
function startLoop(
  physics: PhysicsWorld,
  render: RenderScene,
  input: InputSystem,
  tank: Tank,
  controller: TankController,
  weapon: WeaponSystem,
  shake: CameraShake,
  destruction: DestructionSystem,
): void {
  const dt = CONFIG.loop.fixedTimeStep;
  const maxSub = CONFIG.loop.maxSubSteps;

  let last = performance.now();
  let acc = 0;
  let frame = 0;

  const loop = (): void => {
    const now = performance.now();
    let frameTime = (now - last) / 1000;
    last = now;
    if (frameTime > 0.25) frameTime = 0.25;

    const state = input.state;

    controller.applyDrive(state);
    acc += frameTime;
    let steps = 0;
    while (acc >= dt && steps < maxSub) {
      physics.step();
      acc -= dt;
      steps++;
    }
    SyncBridge.sync();

    // 统一 drain 碰撞事件，分发给武器(炮弹命中) + 破坏(树/栅栏被撞倒)
    // 注意：drainCollisionEvents 是消耗式的，必须集中一次 drain 再分发，
    // 否则一个系统 drain 走所有事件，另一个系统拿不到。
    physics.eventQueue.drainCollisionEvents((h1, h2, started) => {
      if (!started) return;
      weapon.handleCollision(h1, h2);
      destruction.handleCollision(h1, h2);
    });

    controller.aimAndCamera(state, frameTime);
    weapon.update(state, frameTime);
    shake.update(frameTime);
    destruction.update(frameTime);

    frame++;
    if (frame % 30 === 0) {
      const t = tank.body.translation();
      const v = tank.body.linvel();
      const aim = controller.aimInfo;
      const w = weapon.stats;
      const d = destruction.stats;
      log.debug('diag', {
        pos: `${t.x.toFixed(1)},${t.y.toFixed(2)},${t.z.toFixed(1)}`,
        spd: Math.hypot(v.x, v.z).toFixed(2),
        turret: `${aim.turretDeg.toFixed(0)}°`,
        barrel: `${aim.barrelDeg.toFixed(0)}°`,
        proj: w.projectiles,
        expl: w.explosions,
        intact: d.intact,
        frags: d.fragments,
        bricks: d.bricks,
      });
    }

    render.render();
    requestAnimationFrame(loop);
  };

  requestAnimationFrame(loop);
}

main().catch((e) => {
  log.error('boot failed', e);
  console.error('[tank-war] boot failed:', e);
});
