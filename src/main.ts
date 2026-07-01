import RAPIER from '@dimforge/rapier3d-compat';
import { BoxGeometry, ConeGeometry, Mesh, MeshStandardMaterial } from 'three';
import { CONFIG } from './config';
import { PhysicsWorld } from './core/PhysicsWorld';
import { RenderScene } from './core/RenderScene';
import { SyncBridge } from './core/SyncBridge';
import { createTank } from './entities/tanks/registry';
import { StaticTankBase } from './entities/tanks/StaticTankBase';
import type { IControllableTank } from './entities/IControllableTank';
import { InputSystem } from './systems/InputSystem';
import { TankController } from './systems/TankController';
import { TankSwitcher } from './systems/TankSwitcher';
import { WeaponSystem } from './systems/WeaponSystem';
import { DestructionSystem } from './systems/DestructionSystem';
import { DirectorSystem } from './systems/DirectorSystem';
import { ResupplySystem } from './systems/ResupplySystem';
import { ResupplyPoint } from './entities/ResupplyPoint';
import { CameraShake } from './effects/CameraShake';
import { TuningPanel } from './ui/TuningPanel';
import { HUD } from './ui/HUD';
import { Logger } from './utils/Logger';
import { initDebugFlag, isDebug } from './utils/debug';

const log = Logger.create('main');

/**
 * 主入口
 * ------------------------------------------------------------
 * 主循环时序：
 *   applyDrive → physics.step → SyncBridge.sync
 *   → aimAndCamera → weapon.update → shake.update → destruction.update → render
 *
 * 调试模式支持按 Tab 在玩家 T-14 与静态坦克（虎式/M1）之间切换控制。
 */
async function main(): Promise<void> {
  // 调试开关最早解析:URL ?debug 覆盖 CONFIG.debug.enabled。
  // 必须早于 TuningPanel(门控其创建)及所有受调试影响的模块。
  initDebugFlag();

  const container = document.getElementById('app');
  if (!container) throw new Error('mount container #app not found');

  // destruction/tank 在下方创建,但调试回调需引用它们;
  // 用 let 占位 + 闭包捕获,按钮点击时(模块均已建好)才读取。
  let destructionRef: DestructionSystem | undefined;
  let switcherRef: TankSwitcher | undefined;

  // 调参面板仅调试模式创建:slider 调手感 + 模拟受击/切换坦克按钮均属调试功能。
  // 非调试时整体不创建 → 用 config 默认值、无面板、无调试按钮。
  const tuningPanel = isDebug()
    ? new TuningPanel({
        switchTank: (): void => {
          switcherRef?.next();
        },
        simulatePlayerHit: (): void => {
          const d = destructionRef;
          const tank = switcherRef?.activeTank;
          if (!d || !tank) return;
          // 爆心设在当前活性坦克刚体前方 0.8m(车身内) → falloff 接近满伤。
          // applyDamage 会自动跳过 activeTank,这里故意偏移爆心让它落在判定半径内。
          const t = tank.body.translation();
          d.applyDamage({ x: t.x, y: t.y + 0.5, z: t.z + 0.8 }, CONFIG.destruction.explosionRadius, CONFIG.destruction.hitDamage);
        },
        simulateStaticHit: (): void => {
          const d = destructionRef;
          if (!d) return;
          d.simulateStaticHit();
        },
      })
    : undefined;

  const physics = await PhysicsWorld.create();
  const render = new RenderScene(container);
  const hud = new HUD(container);

  buildGround(physics, render);
  buildMountains(physics, render);

  // 村庄情景(在坦克之前创建，便于坦克出生在前方空地)
  const destruction = new DestructionSystem(physics, render);
  destructionRef = destruction;
  buildVillage(destruction);

  // 按配置列表生成全部坦克(t14→Tank, tiger/abrams→StaticTank),统一进可附身列表
  const { tanks: controllableTanks, switchable: switchableTanks, playerIndex } = buildTanks(physics, render, destruction);

  // switcher 只接收非 NPC 坦克(玩家 Tab 不可附身敌方,避免双重控制);destruction/director 用全部
  const switcher = new TankSwitcher(switchableTanks, playerIndex);
  switcherRef = switcher;
  destruction.setControllableTanks(controllableTanks);
  destruction.setActiveTank(switcher.activeTank);
  tuningPanel?.setTankName(switcher.activeTank.displayName);

  // 补给系统(M5):先创建,再构建补给点(注册到 destruction 伤害链 + resupply 装填判定),
  // 之后 director 创建 NPC 时把 resupply 传入(NPC 弹药耗尽自主补给 + 注册装填)。
  const resupply = new ResupplySystem();
  buildResupplyPoints(physics, render, destruction, resupply);

  // 导演系统:接管 npc:true 的敌坦(possess+巡逻+每帧驱动)。传入 resupply:NPC 弹药机制。未来 LLM 接入点
  const director = new DirectorSystem(physics, render, destruction, controllableTanks, resupply);

  const input = new InputSystem();
  input.attach();

  const controller = new TankController(switcher.activeTank, render);
  const shake = new CameraShake(render.camera);
  const weapon = new WeaponSystem(() => switcher.activeTank, physics, render, shake, destruction);

  // 注册玩家坦克到补给系统(用 getter:Tab 切换附身坦克后,装填自动跟随新的 activeTank)
  resupply.register(() => switcher.activeTank, weapon);

  // 切换坦克回调：释放旧单位、附身新单位、重置控制器、更新各子系统
  switcher.onSwitch = (newTank, oldTank): void => {
    oldTank.release();
    newTank.possess();
    controller.setTank(newTank);
    controller.snapCamera();
    destruction.setActiveTank(newTank);
    tuningPanel?.setTankName(newTank.displayName);
  };

  const loop = startLoop(physics, render, input, switcher, controller, weapon, shake, destruction, hud, director, resupply);

  // 注册清理回调：HMR/页面卸载时停止循环、解绑输入、释放资源，防止内存泄漏与重复监听
  const cleanup = (): void => {
    loop.stop();
    tuningPanel?.dispose();
    for (const tank of controllableTanks) tank.dispose();
    render.dispose();
  };
  (window as unknown as { __tankWarCleanup__?: () => void }).__tankWarCleanup__?.();
  (window as unknown as { __tankWarCleanup__?: () => void }).__tankWarCleanup__ = cleanup;

  log.info('boot complete', {
    hint: '↑↓←→ 移动 / Q W 炮塔 / A S 炮管 / Space 开火 / Tab 切换坦克',
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
  // 房屋(4 栋，地图扩大一倍后位置 ×2；房屋自身尺寸不变)
  const houses = [
    { x: -32, z: 24, size: { x: 6, y: 5, z: 6 } },
    { x: 28, z: 20, size: { x: 5, y: 4, z: 5 } },
    { x: -20, z: -28, size: { x: 5, y: 4, z: 5 } },
    { x: 40, z: -24, size: { x: 6, y: 5, z: 5 } },
  ];
  for (const h of houses) {
    destruction.addHouse({ x: h.x, y: 0, z: h.z }, h.size);
  }

  // 水泥塔(2 座，弹坑式渐进破坏，村庄两侧；位置 ×2)
  destruction.addTower({ x: -60, y: 4, z: -4 }, { x: 2, y: 7, z: 2 }, { x: 3.2, y: 1, z: 3.2 });
  destruction.addTower({ x: 64, y: 4, z: 8 }, { x: 2, y: 7, z: 2 }, { x: 3.2, y: 1, z: 3.2 });

  // 栅栏(几排，可被坦克推倒；位置 ×2)
  destruction.addFenceRow({ x: -12, z: 44 }, { x: 16, z: 44 }, 8);
  destruction.addFenceRow({ x: -12, z: 52 }, { x: 16, z: 52 }, 8);
  destruction.addFenceRow({ x: 52, z: -44 }, { x: 76, z: -44 }, 7);

  // 树(随机散布，避开楼房/塔/栅栏/坦克出生点)
  const occupied: { x: number; z: number; r: number }[] = [
    ...houses.map((h) => ({ x: h.x, z: h.z, r: Math.max(h.size.x, h.size.z) })),
    { x: -60, z: -4, r: 3.5 },
    { x: 64, z: 8, r: 3.5 },
    // 坦克避让从 CONFIG.tanks 派生(而非硬编码):加坦克自动避让,无需同步两处(DRY)
    ...CONFIG.tanks.map((t) => ({ x: t.spawn.x, z: t.spawn.z, r: 4 })),
  ];
  let placed = 0;
  let tries = 0;
  // 地图扩大一倍,树木数量增至 40 棵,散布范围 ±120m
  while (placed < 40 && tries < 600) {
    tries++;
    const x = (Math.random() * 2 - 1) * 120;
    const z = (Math.random() * 2 - 1) * 120;
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

/**
 * 构建补给点(M5)
 * ------------------------------------------------------------
 * 遍历 CONFIG.resupplyPoint.points 创建补给点,双重注册:
 *  - destruction.addResupplyPoint : 接入伤害链(可被炮弹/撞击摧毁)
 *  - resupply.addPoint            : 接入装填判定(坦克驶入自动装填)+ NPC 导航查询
 */
function buildResupplyPoints(
  physics: PhysicsWorld,
  render: RenderScene,
  destruction: DestructionSystem,
  resupply: ResupplySystem,
): void {
  for (const p of CONFIG.resupplyPoint.points) {
    const rp = new ResupplyPoint(physics, render, { x: p.x, z: p.z });
    destruction.addResupplyPoint(rp);
    resupply.addPoint(rp);
  }
  log.info('resupply points built', { count: CONFIG.resupplyPoint.points.length });
}

/**
 * 按配置列表生成全部坦克
 * ------------------------------------------------------------
 * 遍历 CONFIG.tanks,用 createTank(variant) 工厂分发创建具体子类:
 *  - 't14'            → T14Tank(玩家型 dynamic 可驾驶)
 *  - 'tiger'/'abrams' → TigerTank/AbramsTank(静态型 fixed 可附身)
 * StaticTankBase 子类注册到 destruction 作可破坏目标。
 * 返回:
 *  - tanks:       全部坦克(含NPC) → 给 destruction(受击)/director(接管NPC)
 *  - switchable:  非NPC坦克      → 给 switcher(玩家 Tab 只切到这些,避免附身敌方双重控制)
 *  - playerIndex: 玩家初始在 switchable 中的索引
 *
 * 配置 spawn.y 统一为【地面高度】,各子类构造内部按需抬高(createTank/buildTanks 不关心)。
 */
function buildTanks(
  physics: PhysicsWorld,
  render: RenderScene,
  destruction: DestructionSystem,
): { tanks: IControllableTank[]; switchable: IControllableTank[]; playerIndex: number } {
  const tanks: IControllableTank[] = [];
  const switchable: IControllableTank[] = [];
  let playerIndex = -1;
  let playerCount = 0;

  for (let i = 0; i < CONFIG.tanks.length; i++) {
    const cfg = CONFIG.tanks[i];
    let tank: IControllableTank;
    try {
      tank = createTank(cfg.variant, physics, render, cfg.spawn, cfg.yaw);
    } catch (e) {
      // 未知 variant:as const 下编译期不可达,运行期兜底(永不静默失败)
      log.error('unknown tank variant, skipped', { variant: cfg.variant, index: i, err: String(e) });
      continue;
    }
    // 静态型号(tiger/abrams,StaticTankBase 子类)注册为可破坏目标
    if (tank instanceof StaticTankBase) destruction.addStaticTank(tank);
    tanks.push(tank);
    // npc:true 不进 switchable:玩家 Tab 不可附身敌方,避免与 NpcController 双重控制冲突
    const isNpc = (cfg as { npc?: boolean }).npc === true;
    if (isNpc) {
      if (cfg.player) log.warn('npc tank marked player, ignored for switch', { index: i });
      continue;
    }
    if (cfg.player) {
      if (playerIndex === -1) playerIndex = switchable.length;
      playerCount++;
    }
    switchable.push(tank);
  }

  // player 标记异常防御(永不静默失败):缺失取首辆并警告;多辆取首辆标记的并警告
  if (playerIndex === -1) {
    log.warn('no player:true tank in switchable, default to first', { count: switchable.length });
    playerIndex = 0;
  } else if (playerCount > 1) {
    log.warn('multiple player:true tanks, using first marked', { count: playerCount, playerIndex });
  }

  log.info('tanks built', { count: tanks.length, switchable: switchable.length, playerIndex });
  return { tanks, switchable, playerIndex };
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
  switcher: TankSwitcher,
  controller: TankController,
  weapon: WeaponSystem,
  shake: CameraShake,
  destruction: DestructionSystem,
  hud: HUD,
  director: DirectorSystem,
  resupply: ResupplySystem,
): { stop: () => void } {
  const dt = CONFIG.loop.fixedTimeStep;
  const maxSub = CONFIG.loop.maxSubSteps;

  let last = performance.now();
  let acc = 0;
  let frame = 0;
  let prevSwitchNext = false;
  let rafId = 0;
  let running = true;

  const loop = (): void => {
    if (!running) return;
    const now = performance.now();
    let frameTime = (now - last) / 1000;
    last = now;
    if (frameTime > 0.25) frameTime = 0.25;

    const state = input.state;

    // Tab 切换仅在调试模式生效;关闭时仅初始玩家坦克可操控
    if (isDebug() && state.switchNext && !prevSwitchNext) {
      switcher.next();
    }
    prevSwitchNext = state.switchNext;

    const activeTank = switcher.activeTank;
    hud.setCrosshair(input.state.mouseX, input.state.mouseY);
    hud.update(activeTank, {
      current: weapon.getAmmo(),
      max: weapon.getMaxAmmo(),
      resupplying: weapon.isResupplying(),
    });

    controller.applyDrive(state);
    director.updateDrive(frameTime); // NPC step 前:决策 + drive
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
      director.handleCollision(h1, h2); // NPC 炮弹命中分发
      destruction.handleCollision(h1, h2);
    });

    controller.applyAim(state, frameTime);
    controller.updateCamera();
    weapon.update(state, frameTime);
    director.update(frameTime); // NPC step 后:aim + weapon
    shake.update(frameTime);
    destruction.update(frameTime);
    resupply.update(frameTime); // 补给点再生 + 装填判定(M5)

    frame++;
    // 周期诊断日志仅在调试模式输出(关闭时连计算都省)
    if (isDebug() && frame % 30 === 0) {
      const t = activeTank.body.translation();
      const v = activeTank.body.linvel();
      const aim = controller.aimInfo;
      const w = weapon.stats;
      const d = destruction.stats;
      log.debug('diag', {
        tank: activeTank.displayName,
        pos: `${t.x.toFixed(1)},${t.y.toFixed(2)},${t.z.toFixed(1)}`,
        spd: Math.hypot(v.x, v.z).toFixed(2),
        turret: `${aim.turretDeg.toFixed(0)}°`,
        barrel: `${aim.barrelDeg.toFixed(0)}°`,
        proj: w.projectiles,
        expl: w.explosions,
        ammo: `${weapon.getAmmo()}/${weapon.getMaxAmmo()}`,
        supply: `${resupply.stats.activePoints}/${resupply.stats.points}`,
        intact: d.intact,
        frags: d.fragments,
        bricks: d.bricks,
      });
    }

    render.render();
    rafId = requestAnimationFrame(loop);
  };

  rafId = requestAnimationFrame(loop);

  return {
    stop: (): void => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      input.detach();
    },
  };
}

main().catch((e) => {
  log.error('boot failed', e);
  console.error('[tank-war] boot failed:', e);
});
