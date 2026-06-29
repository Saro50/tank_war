import RAPIER from '@dimforge/rapier3d-compat';
import {
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CylinderGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RepeatWrapping,
  Vector3,
} from 'three';
import { CONFIG } from '../config';
import type { PhysicsWorld } from '../core/PhysicsWorld';
import type { RenderScene } from '../core/RenderScene';
import { SyncBridge } from '../core/SyncBridge';
import { Logger } from '../utils/Logger';

const log = Logger.create('Tank');

/**
 * 坦克实体
 * ============================================================
 * 结构（Three 父子层级，物理只有车身一个刚体）：
 *
 *   group ──(跟随车身刚体, SyncBridge 每帧写入位姿)
 *   ├─ trackGroup        履带轮组(接地不动，不参与悬挂摇晃)
 *   │  ├─ 左/右履带直段box(链节纹理滚动) + 两端主动轮(金属)
 *   │  ├─ roadWheel×7/侧 T-14 负重轮(橡胶外圈 + 轮毂盘)
 *   │  └─ fender         挡泥板(履带上方薄板)
 *   └─ hullSway          车体摇晃 pivot(C阶段：controller 写 pitch/roll)
 *      ├─ hullMesh       楔形车身(X 顶窄底宽 + Z 顶短底长，前后斜下)
 *      ├─ driverHatch    驾驶员舱盖(车前顶凸起)
 *      ├─ engineGrille×N 发动机舱格栅(车尾散热条)
 *      └─ turret(组)     T-14 无人炮塔，绕 Y 水平旋转(键盘 U/I，带惯性)
 *         ├─ turretBody      楔形主体(顶窄底宽，参考实物图，T-14 灵魂)
 *         ├─ sightCmdr/Gunner 车长/炮长瞄准镜(传感器柱)
 *         ├─ rcws            遥控机枪(底座 + 枪管)
 *         ├─ afghanit×N      阿富汗石主动防御发射管(两侧水平小柱)
 *         ├─ antenna         通讯天线(炮塔后部, 随炮塔转规避穿模)
 *         ├─ numberDecal×2   战术编号贴花(两侧, alphaTest 抠圆)
 *         └─ barrel(组)      绕 X 俯仰(键盘 O/P)
 *            ├─ mantlet       炮盾(根部加厚)
 *            ├─ barrelMesh    炮管
 *            ├─ fumeExtractor 炮管中段抽烟器(2A82)
 *            ├─ muzzleDevice  炮口消焰器(小粗段)
 *            └─ muzzle        炮口标记点(M3 用)
 *
 * 材质：colors 配色板 + 分材质 PBR(漆面/金属/橡胶)。
 *       车身/炮塔用程序俄军绿系迷彩(makeCamouflageCanvas) + 做旧噪点；
 *       梯形车身为非共享顶点几何(每面独立 UV)，迷彩在侧面不拉伸。
 *       炮塔两侧贴战术编号贴花(alphaTest 抠圆外透明)。
 *
 * 履带胶囊形：直段 box 长度 = 2*(halfZ-halfY)，两端圆柱半径=halfY，
 *             拼合后侧面轮廓为胶囊(两端圆弧)。
 * 履带滚动：链节纹理沿长度方向(u 轴)分布，offset.x 累加 → 链节逐个滚过。
 */
export class Tank {
  readonly body: RAPIER.RigidBody;
  readonly group: Group;
  /** C阶段：车身视觉摇晃 pivot(车体部件挂此，履带轮组不动)；controller 写 rotation */
  readonly hullSway: Group;
  readonly turret: Group;
  readonly barrel: Group;
  readonly muzzle: Object3D;

  private readonly leftTrackTex: CanvasTexture;
  private readonly rightTrackTex: CanvasTexture;
  private readonly _muzzleWorld = new Vector3();
  private static readonly _mDirA = new Vector3(); // 炮口方向计算复用
  private static readonly _mDirB = new Vector3();

  constructor(
    physics: PhysicsWorld,
    render: RenderScene,
    spawn: { x: number; y: number; z: number },
  ) {
    const cfg = CONFIG.tank;
    const bh = cfg.bodyHalf;

    // ---- 1. 物理车身(整体外框 cuboid) ----
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setLinearDamping(0.6)
      .setAngularDamping(2.5)
      .enabledRotations(false, true, false)
      .setCcdEnabled(true);
    this.body = physics.world.createRigidBody(bodyDesc);
    physics.world.createCollider(
      RAPIER.ColliderDesc.cuboid(bh.x, bh.y, bh.z)
        .setMass(cfg.mass)
        .setFriction(0.8)
        .setRestitution(0.0),
      this.body,
    );

    // ---- 2. 渲染层级(写实军事风：分材质 PBR + 多部件细节) ----
    this.group = new Group();
    // C阶段：hullSway(车体摇晃) + trackGroup(履带轮组固定接地)，物理刚体仍锁死保稳定
    this.hullSway = new Group();
    const trackGroup = new Group();
    this.group.add(this.hullSway, trackGroup);
    const c = cfg.colors;

    // 程序迷彩(同一 canvas 生成两个独立纹理 → 车身/炮塔各自调密度)
    // 写实 NATO 三色：绿底 + 深褐/中绿硬边斑块 + 做旧噪点
    const camoCanvas = makeCamouflageCanvas(c.camo);
    const hullCamoTex = new CanvasTexture(camoCanvas);
    hullCamoTex.wrapS = hullCamoTex.wrapT = RepeatWrapping;
    hullCamoTex.repeat.set(3, 2); // 车身各面 0~1 UV，repeat 控斑块密度
    hullCamoTex.anisotropy = 4;
    const turretCamoTex = new CanvasTexture(camoCanvas);
    turretCamoTex.wrapS = turretCamoTex.wrapT = RepeatWrapping;
    turretCamoTex.repeat.set(4, 1); // 炮塔圆柱 UV 沿圆周密、高度疏
    turretCamoTex.anisotropy = 4;

    // 共享材质组(分材质 PBR：漆面哑光 / 金属高反射 / 橡胶全哑光)
    // 车身/炮塔用迷彩 map(color 留白避免染色)，其余部件纯色
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

    // ===== 车体 =====
    // 车体(楔形：X 顶窄底宽 + Z 顶短底长 → 前后均斜下，规避炮管下俯穿模)
    const hullMesh = new Mesh(makeWedgeGeometry(cfg.hull), mat.hull);
    hullMesh.castShadow = true;
    hullMesh.receiveShadow = true;
    this.hullSway.add(hullMesh);

    // 驾驶员舱盖(车体前顶凸起，写实坦克标志)
    const dh = cfg.stowage.driverHatch;
    const hatch = new Mesh(
      new CylinderGeometry(dh.radius, dh.radius, dh.height, 16),
      mat.hull,
    );
    hatch.position.set(dh.x, dh.y, dh.z);
    hatch.castShadow = true;
    this.hullSway.add(hatch);

    // 发动机舱格栅(车尾一排横向散热条)
    const eg = cfg.stowage.engineGrille;
    const barH = (eg.halfY * 2 * 0.7) / eg.count; // 每条高(留间隙)
    const grilleGeo = new BoxGeometry(eg.halfX * 2, barH, eg.halfThick * 2);
    const yStep = (eg.halfY * 2) / (eg.count - 1);
    for (let i = 0; i < eg.count; i++) {
      const bar = new Mesh(grilleGeo, mat.detail);
      bar.position.set(0, eg.y - eg.halfY + i * yStep, eg.z);
      bar.castShadow = true;
      this.hullSway.add(bar);
    }

    // ===== 行走部分：履带 + 主动轮 + 负重轮排 + 挡泥板 =====
    const tcfg = cfg.track;
    const trackBoxGeo = new BoxGeometry(
      tcfg.halfX * 2,
      tcfg.halfY * 2,
      (tcfg.halfZ - tcfg.halfY) * 2, // 直段去掉两端半径长度
    );
    const sprocketGeo = new CylinderGeometry(tcfg.halfY, tcfg.halfY, tcfg.halfX * 2, 24);
    const wheelZ = tcfg.halfZ - tcfg.halfY; // 主动轮中心 z

    this.leftTrackTex = makeTrackTexture(tcfg.texRepeat);
    this.rightTrackTex = makeTrackTexture(tcfg.texRepeat);

    // 负重轮几何(橡胶外圈 + 金属轮毂盘)：写实坦克最显著特征
    const wcfg = cfg.roadWheel;
    const roadRubberGeo = new CylinderGeometry(wcfg.radius, wcfg.radius, wcfg.halfWidth * 2, 20);
    const roadHubGeo = new CylinderGeometry(
      wcfg.radius * 0.6,
      wcfg.radius * 0.6,
      wcfg.halfWidth * 1.2,
      16,
    );
    // 负重轮 z 均匀分布
    const wheelZs: number[] = [];
    for (let i = 0; i < wcfg.count; i++) {
      wheelZs.push(-wcfg.zSpan + (2 * wcfg.zSpan * i) / (wcfg.count - 1));
    }

    const addTrack = (side: number, tex: CanvasTexture): void => {
      const x = side * tcfg.offsetX;
      // 直段(链节纹理滚动)
      const box = new Mesh(
        trackBoxGeo,
        new MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.05 }),
      );
      box.position.set(x, tcfg.centerY, 0);
      box.castShadow = true;
      box.receiveShadow = true;
      trackGroup.add(box);
      // 两端主动轮/诱导轮(金属，比负重轮大)
      for (const z of [-wheelZ, wheelZ]) {
        const w = new Mesh(sprocketGeo, mat.trackMetal);
        w.rotation.z = Math.PI / 2; // 圆柱轴从 Y 转 X
        w.position.set(x, tcfg.centerY, z);
        w.castShadow = true;
        w.receiveShadow = true;
        trackGroup.add(w);
      }
      // 负重轮排(每侧 count 个，露在履带内侧)：橡胶外圈 + 外侧轮毂盘
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
      // 挡泥板(履带上方薄板)
      const f = cfg.fender;
      const fender = new Mesh(
        new BoxGeometry(f.halfX * 2, f.halfY * 2, f.halfZ * 2),
        mat.fender,
      );
      fender.position.set(side * f.offsetX, f.centerY, 0);
      fender.castShadow = true;
      fender.receiveShadow = true;
      trackGroup.add(fender);
    };
    addTrack(-1, this.leftTrackTex);
    addTrack(1, this.rightTrackTex);

    // ===== 炮塔组(水平旋转) =====
    this.turret = new Group();
    this.turret.position.set(cfg.turret.offset.x, cfg.turret.offset.y, cfg.turret.offset.z);
    // T-14 无人炮塔主体(楔形：顶窄底宽，正面装甲内倾，参考实物图)
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
    this.turret.add(turretBody);

    // 方块部件工厂(传感器柱/机枪底座，统一创建逻辑避免重复)
    const addBox = (
      half: { x: number; y: number; z: number },
      offset: { x: number; y: number; z: number },
      m: MeshStandardMaterial,
    ): Mesh => {
      const mesh = new Mesh(new BoxGeometry(half.x * 2, half.y * 2, half.z * 2), m);
      mesh.position.set(offset.x, offset.y, offset.z);
      mesh.castShadow = true;
      this.turret.add(mesh);
      return mesh;
    };

    // 车长全景瞄准镜(后部较大柱状) + 炮长瞄准镜(前部偏右小柱状)
    addBox(ar.sightCmdr.half, ar.sightCmdr.offset, mat.turret);
    addBox(ar.sightGunner.half, ar.sightGunner.offset, mat.turret);

    // 遥控机枪 RCWS(底座 + 枪管，T-14 标志)
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
    this.turret.add(rcwsBarrel);

    // "阿富汗石"主动防御发射管(炮塔两侧水平小柱，T-14 标志)
    const af = cfg.turret.afghanit;
    const afghanitGeo = new CylinderGeometry(af.radius, af.radius, af.height, 10);
    for (let i = 0; i < af.count; i++) {
      const z = -af.zSpan + (2 * af.zSpan * i) / (af.count - 1);
      for (const side of [-1, 1]) {
        const tube = new Mesh(afghanitGeo, mat.detail);
        tube.rotation.z = Math.PI / 2; // 圆柱轴 → x 方向(水平朝外)
        tube.position.set(side * af.offsetX, af.offsetY, z);
        this.turret.add(tube);
      }
    }

    // 通讯天线(炮塔后部，随炮塔转规避炮管穿模)
    const acfg = cfg.turret.antenna;
    const antennaPivot = new Object3D();
    antennaPivot.position.set(acfg.baseX, acfg.baseY, acfg.baseZ);
    antennaPivot.rotation.x = -acfg.tilt; // 后倾
    const antenna = new Mesh(
      new CylinderGeometry(acfg.radius, acfg.radius, acfg.length, 8),
      mat.detail,
    );
    antenna.position.y = acfg.length / 2;
    antennaPivot.add(antenna);
    this.turret.add(antennaPivot);

    // 战术编号贴花(炮塔两侧，贴方形炮塔外侧面)
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
      decal.rotation.y = side * Math.PI * 0.5; // 法线朝外 ±x
      this.turret.add(decal);
    }

    this.hullSway.add(this.turret);

    // ===== 炮管组(俯仰) =====
    this.barrel = new Group();
    this.barrel.position.set(cfg.barrel.offset.x, cfg.barrel.offset.y, cfg.barrel.offset.z);
    const barrelMesh = new Mesh(
      new CylinderGeometry(0.11, 0.11, cfg.barrel.length, 16),
      mat.barrel,
    );
    barrelMesh.rotation.x = Math.PI / 2;
    barrelMesh.position.z = cfg.barrel.length / 2;
    barrelMesh.castShadow = true;
    this.barrel.add(barrelMesh);

    // 炮盾(炮管根部加厚圆柱，随炮管俯仰)
    const mn = cfg.barrel.mantlet;
    const mantlet = new Mesh(
      new CylinderGeometry(mn.radius, mn.radius, mn.halfZ * 2, 20),
      mat.mantlet,
    );
    mantlet.rotation.x = Math.PI / 2;
    mantlet.position.z = mn.halfZ;
    mantlet.castShadow = true;
    this.barrel.add(mantlet);

    // 炮管中段抽烟器(T-14 的 2A82，取代炮口制退器)
    const fe = cfg.barrel.fumeExtractor;
    const fumeExtractor = new Mesh(
      new CylinderGeometry(fe.radius, fe.radius, fe.length, 18),
      mat.barrel,
    );
    fumeExtractor.rotation.x = Math.PI / 2;
    fumeExtractor.position.z = cfg.barrel.length * fe.posRatio;
    fumeExtractor.castShadow = true;
    this.barrel.add(fumeExtractor);

    // 炮口装置(消焰器，炮口端小粗段)
    const md = cfg.barrel.muzzleDevice;
    const muzzleDevice = new Mesh(
      new CylinderGeometry(md.radius, md.radius, md.length, 16),
      mat.barrel,
    );
    muzzleDevice.rotation.x = Math.PI / 2;
    muzzleDevice.position.z = cfg.barrel.length - md.length / 2;
    muzzleDevice.castShadow = true;
    this.barrel.add(muzzleDevice);

    this.muzzle = new Object3D();
    this.muzzle.position.set(0, 0, cfg.barrel.length);
    this.barrel.add(this.muzzle);
    this.turret.add(this.barrel);

    // ---- 3. 挂场景 + 绑定同步 ----
    render.scene.add(this.group);
    SyncBridge.bind(this.body, this.group);

    log.info('tank spawned', { spawn, mass: cfg.mass });
  }

  get bodyYaw(): number {
    const q = this.body.rotation();
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  muzzleWorldPosition(): { x: number; y: number; z: number } {
    this.group.updateMatrixWorld(true);
    this.muzzle.getWorldPosition(this._muzzleWorld);
    return { x: this._muzzleWorld.x, y: this._muzzleWorld.y, z: this._muzzleWorld.z };
  }

  /** 炮口当前世界朝向(炮管轴向，指向炮口前方)。M3 开火用。 */
  muzzleWorldDirection(): { x: number; y: number; z: number } {
    // 用 炮口位置 - 炮管根部位置 算炮管轴向。
    // 不用 getWorldDirection(它返回 -z 轴，炮管朝 +z，语义相反会算反方向)
    this.group.updateMatrixWorld(true);
    this.muzzle.getWorldPosition(Tank._mDirA);
    this.barrel.getWorldPosition(Tank._mDirB);
    Tank._mDirA.sub(Tank._mDirB).normalize();
    return { x: Tank._mDirA.x, y: Tank._mDirA.y, z: Tank._mDirA.z };
  }

  /** 炮管基座 z(回缩动画叠加于此) */
  get barrelBaseZ(): number {
    return CONFIG.tank.barrel.offset.z;
  }

  /**
   * 更新履带滚动(每帧由 controller 调用)
   * @param leftVel  左履带线速度(m/s, 正=前)
   * @param rightVel 右履带线速度(m/s, 正=前)
   * @param dt       帧间隔(s)
   *
   * 差速：直行左右同号；转向两侧反向或差速。
   * 链节沿 u(长度)方向分布，offset.x 累加 → 可见滚动。
   */
  updateTracks(leftVel: number, rightVel: number, dt: number): void {
    const f = CONFIG.tank.track.rollScale;
    this.leftTrackTex.offset.x += leftVel * dt * f;
    this.rightTrackTex.offset.x += rightVel * dt * f;
  }
}

// ---- 几何/纹理工厂 ----

/**
 * 程序生成履带链节纹理
 * 关键：链节块沿 canvas x(u=长度方向)分布，offset.x 才能让链节逐个滚过。
 * (此前画成横条纹 → 沿 u 无变化 → 滚动不可见，已修正)
 */
function makeTrackTexture(repeat: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 32;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  // 深底
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, 64, 32);
  // 链节凸块(沿 x 分布，每 16px 一组)
  for (let x = 0; x < 64; x += 16) {
    ctx.fillStyle = '#3a3d42';
    ctx.fillRect(x + 2, 3, 12, 26); // 凸块
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fillRect(x + 2, 4, 12, 3); // 上沿高光
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x, 0, 2, 32); // 凹槽分隔
  }
  const tex = new CanvasTexture(c);
  tex.wrapS = RepeatWrapping; // 沿 u 重复
  tex.repeat.set(repeat, 1); // 长度方向重复 repeat 组链节
  tex.anisotropy = 4;
  return tex;
}

/**
 * 程序生成 NATO 风三色迷彩 canvas(硬边块状 + 做旧噪点)
 * ------------------------------------------------------------
 * 算法：底色 → 随机不规则多边形斑块(中绿先铺、深褐叠上破坏规整)
 *       → 全图像素级亮度噪点(模拟灰尘/磨损/掉漆)。
 * 返回 canvas，调用方包成 CanvasTexture 并按需设 repeat 控密度。
 */
function makeCamouflageCanvas(
  p: { base: number; blobDark: number; blobMid: number },
  size = 256,
): HTMLCanvasElement {
  const cnv = document.createElement('canvas');
  cnv.width = size;
  cnv.height = size;
  const ctx = cnv.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');

  // 底色
  ctx.fillStyle = hex(p.base);
  ctx.fillRect(0, 0, size, size);

  // 不规则硬边斑块(6~9 顶点多边形，半径扰动 → 不规则块状)
  const drawBlob = (color: string, count: number, minR: number, maxR: number): void => {
    ctx.fillStyle = color;
    for (let i = 0; i < count; i++) {
      const cx = Math.random() * size;
      const cy = Math.random() * size;
      const n = 6 + Math.floor(Math.random() * 4);
      const baseR = minR + Math.random() * (maxR - minR);
      ctx.beginPath();
      for (let j = 0; j < n; j++) {
        const ang = (j / n) * Math.PI * 2;
        const r = baseR * (0.6 + Math.random() * 0.7);
        const x = cx + Math.cos(ang) * r;
        const y = cy + Math.sin(ang) * r;
        if (j === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
    }
  };
  drawBlob(hex(p.blobMid), 7, 30, 56); // 中绿大斑块(先铺)
  drawBlob(hex(p.blobDark), 6, 18, 40); // 深黑褐斑块(叠上)

  // 做旧噪点(全图像素级亮度扰动 ±15)
  const img = ctx.getImageData(0, 0, size, size);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() - 0.5) * 30;
    d[i] = Math.max(0, Math.min(255, d[i] + n));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + n));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + n));
  }
  ctx.putImageData(img, 0, 0);

  return cnv;
}

/**
 * 战术编号贴花 canvas(深底圆 + 浅色编号文字，圆外透明)
 * 配合材质 alphaTest 抠掉圆外区域，贴炮塔侧面。
 */
function makeNumberDecalCanvas(text: string, size = 128): HTMLCanvasElement {
  const cnv = document.createElement('canvas');
  cnv.width = size;
  cnv.height = size;
  const ctx = cnv.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.clearRect(0, 0, size, size); // 圆外透明
  ctx.fillStyle = '#1a1d12'; // 深底圆
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#d8d2b8'; // 浅色编号
  ctx.font = 'bold 62px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, size / 2, size / 2 + 4);
  return cnv;
}

/**
 * 楔形炮塔几何(顶窄底宽 + 顶短底长，四面斜面 → 正面楔形轮廓)
 * ------------------------------------------------------------
 * 用于 T-14 无人炮塔：顶面整体收窄，正面/侧面均呈倾斜楔形装甲。
 * 非共享顶点 + 每面独立 UV(沿用 makeTrapezoidGeometry 方案)，
 * 法线 flat → 装甲棱角锐利；三角形绕向保证外法线。
 */
function makeWedgeGeometry(h: {
  bottomHalfX: number; topHalfX: number;
  bottomHalfZ: number; topHalfZ: number;
  height: number; centerY: number;
}): BufferGeometry {
  const { bottomHalfX: bx, topHalfX: tx, bottomHalfZ: bz, topHalfZ: tz, height, centerY: cy } = h;
  const yb = cy - height / 2;
  const yt = cy + height / 2;
  const P: number[][] = [
    [-bx, yb, -bz], [bx, yb, -bz], [bx, yb, bz], [-bx, yb, bz], // 0-3 底
    [-tx, yt, -tz], [tx, yt, -tz], [tx, yt, tz], [-tx, yt, tz], // 4-7 顶
  ];
  const faces: number[][] = [
    [0, 1, 2, 3], // 底 -y
    [4, 7, 6, 5], // 顶 +y
    [0, 4, 5, 1], // 前 -z
    [3, 2, 6, 7], // 后 +z
    [0, 3, 7, 4], // 左 -x
    [1, 5, 6, 2], // 右 +x
  ];
  const faceUV = [
    [0, 0], [1, 0], [1, 1], [0, 1],
  ];
  const positions: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (const f of faces) {
    const base = positions.length / 3;
    for (let i = 0; i < 4; i++) {
      const p = P[f[i]];
      positions.push(p[0], p[1], p[2]);
      uvs.push(faceUV[i][0], faceUV[i][1]);
    }
    index.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geo.setIndex(index);
  geo.computeVertexNormals();
  return geo;
}
