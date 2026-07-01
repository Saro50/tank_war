import { Vector3 } from 'three';
import type { PerspectiveCamera } from 'three';
import type { RenderScene } from '../core/RenderScene';
import { Dust } from '../effects/Dust';
import type { InputState } from './InputSystem';
import type { IControllableTank } from '../entities/IControllableTank';
import { Logger } from '../utils/Logger';

const log = Logger.create('TankCtl');

/**
 * 坦克控制器
 * ============================================================
 * 纯逻辑层：读 InputState → 操作车身刚体 + 炮塔/炮管 + 履带 + 相机。
 * 现在绑定 IControllableTank 接口，玩家 T-14 与静态坦克（虎式/M1）可共用。
 *
 * 调用时序（main 保证）：
 *   applyDrive(input)         → step 前，设车身速度
 *   physics.step()            → 物理推进
 *   SyncBridge.sync()         → group 跟上车身位姿
 *   aimAndCamera(input, dt)   → 炮塔(惯性)/炮管 + 履带差速 + 车体摇晃 + 扬尘 + 相机
 *
 * 履带差速原理（务必正确）：
 *   leftVel  = curLin + curTurn * r
 *   rightVel = curLin - curTurn * r   (r = 履带间距/2)
 *   直行同向；原地左转 left<0 right>0；行进间转弯两侧差速。
 */
export class TankController {
  private tank: IControllableTank;
  private readonly camera: PerspectiveCamera;
  private readonly render: RenderScene;
  private dusts: Dust[] = []; // 非 readonly：updateDust 用 filter 重新赋值
  private distAcc = 0; // 行驶距离累积(按距生成扬尘)

  // 平滑/积分状态
  private curLin = 0; // 当前沿车身方向线速度
  private curTurn = 0; // 当前绕 Y 角速度
  private prevLin = 0; // 上帧线速度(算加速度做俯仰摇晃)
  private swayPitch = 0; // 当前摇晃俯仰(rad, 平滑后)
  private swayRoll = 0; // 当前摇晃侧倾(rad, 平滑后)
  private turretAngle = 0; // 炮塔累积偏航(rad)
  private turretOmega = 0; // 炮塔当前角速度(rad/s, 惯性)
  private barrelPitch = 0; // 炮管俯仰(rad)

  constructor(tank: IControllableTank, render: RenderScene) {
    this.tank = tank;
    this.render = render;
    this.camera = render.camera;
    this.reset();
    log.info('controller ready', { tank: tank.name });
  }

  /** 重新绑定到另一辆坦克（切换附身时用） */
  setTank(tank: IControllableTank): void {
    this.tank = tank;
    this.reset();
    log.info('controller bound', { tank: tank.name });
  }

  /** 重置内部积分状态，并同步到当前坦克的视觉角度 */
  reset(): void {
    this.curLin = 0;
    this.curTurn = 0;
    this.prevLin = 0;
    this.swayPitch = 0;
    this.swayRoll = 0;
    this.turretOmega = 0;
    this.distAcc = 0;
    this.turretAngle = this.tank.turret.rotation.y;
    this.barrelPitch = this.tank.barrel.rotation.x;
  }

  /** 相机立刻跳到目标位置（切换坦克时避免长途飞行） */
  snapCamera(): void {
    this.computeCamera(camPos);
    this.camera.position.copy(camPos);
    this.camera.lookAt(camLook);
  }

  /** step 前调用：方向键控制车身移动/转向（坦克式）。被击毁后停止响应输入。 */
  applyDrive(input: InputState): void {
    if (this.tank.state !== 'intact') return; // 被击毁:停止驾驶
    const cfg = this.tank.driveConfig;
    const reverseMul = input.forward < 0 ? cfg.reverseScale : 1;
    const targetLin = input.forward * cfg.moveSpeed * reverseMul;
    const targetTurn = input.turn * cfg.turnSpeed;

    this.curLin = lerp(this.curLin, targetLin, cfg.accelLerp);
    this.curTurn = lerp(this.curTurn, targetTurn, cfg.accelLerp);

    const yaw = this.bodyYaw;
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    // 覆盖水平速度，保留 y(重力分量)
    const v = this.tank.body.linvel();
    this.tank.body.setLinvel(
      { x: dirX * this.curLin, y: v.y, z: dirZ * this.curLin },
      true,
    );
    this.tank.body.setAngvel({ x: 0, y: this.curTurn, z: 0 }, true);
  }

  /**
   * step 后、sync 后调用：炮塔/炮管键盘积分 + 履带 + 摇晃 + 扬尘。
   * 不含相机——拆出 updateCamera(),供 AI 复用操控层但不碰玩家相机。
   * 被击毁后炮塔/炮管/履带停转,仅回收残留扬尘淡出。
   */
  applyAim(input: InputState, dt: number): void {
    const cfg = this.tank.driveConfig;

    // 被击毁:跳过操控相关更新,仅回收残留扬尘淡出(相机由 updateCamera 独立跟随残骸)
    if (this.tank.state !== 'intact') {
      this.curLin = 0;
      this.curTurn = 0;
      this.updateDust(dt);
      return;
    }

    // 炮塔水平旋转（Q/W）：角速度 lerp 实现惯性
    const omegaTarget = input.turretDir * cfg.turret.turnSpeed;
    this.turretOmega = lerp(this.turretOmega, omegaTarget, cfg.turret.omegaLerp);
    this.turretAngle = wrapAngle(this.turretAngle + this.turretOmega * dt);
    this.tank.turret.rotation.y = this.turretAngle;

    // 炮管俯仰（A/S，按住持续抬/放，限位）
    this.barrelPitch = clamp(
      this.barrelPitch + input.barrelDir * cfg.barrel.pitchSpeed * dt,
      cfg.barrel.pitchRange.min,
      cfg.barrel.pitchRange.max,
    );
    this.tank.barrel.rotation.x = this.barrelPitch;

    // 履带差速滚动
    const r = cfg.track.offsetX; // 履带间距/2
    const leftVel = this.curLin + this.curTurn * r;
    const rightVel = this.curLin - this.curTurn * r;
    this.tank.updateTracks(leftVel, rightVel, dt);

    // 车身悬挂视觉摇晃(C阶段)：加减速俯仰 + 转向侧倾，写 hullSway.rotation
    this.updateSway(dt);

    // 移动扬尘(C阶段)：按行驶距离在履带接地点生成尘雾
    this.updateDust(dt);
    // 不含相机:玩家侧由 main 调 updateCamera(),AI 侧不调
  }

  /**
   * 车身悬挂视觉摇晃(C阶段)
   * ------------------------------------------------------------
   * - pitch(俯仰)：由线加速度驱动(加速抬头 / 减速点头)
   * - roll(侧倾)：由转向角速度驱动(离心力让车身向外侧倾)
   * 幅度极小(几度)、lerp 平滑，写入 tank.hullSway.rotation。
   * 物理刚体仍锁 pitch/roll，纯视觉，不影响行驶稳定性。
   * 静态坦克没有 hullSway，直接跳过。
   */
  private updateSway(dt: number): void {
    if (!this.tank.hullSway) return;
    const cfg = this.tank.driveConfig.sway;
    const accel = (this.curLin - this.prevLin) / Math.max(dt, 1e-4);
    this.prevLin = this.curLin;
    const targetPitch = -accel * cfg.pitchScale;
    const targetRoll = -this.curTurn * cfg.rollScale;
    this.swayPitch = lerp(this.swayPitch, targetPitch, cfg.lerp);
    this.swayRoll = lerp(this.swayRoll, targetRoll, cfg.lerp);
    this.tank.hullSway.rotation.set(this.swayPitch, 0, this.swayRoll);
  }

  /**
   * 移动扬尘(C阶段)
   * ------------------------------------------------------------
   * 按行驶距离调制(spawnPerMeter)：每 gap 米生成一团尘雾于履带接地点。
   * 速度 < minSpeed 不扬尘(静止/慢速不飞溅)。尘雾寿命由 Dust 自管。
   */
  private updateDust(dt: number): void {
    const cfg = this.tank.driveConfig.dust;
    this.dusts = this.dusts.filter((d) => {
      if (d.update(dt)) return true;
      d.dispose(this.render);
      return false;
    });
    const speed = Math.abs(this.curLin);
    if (speed < cfg.minSpeed) return;
    this.distAcc += speed * dt;
    const gap = 1 / cfg.spawnPerMeter;
    if (this.distAcc >= gap) {
      this.distAcc -= gap;
      this.spawnDust();
    }
  }

  /** 在两侧履带接地点各生成一团尘雾(局部→车身 yaw 世界坐标) */
  private spawnDust(): void {
    const tcfg = this.tank.driveConfig.track;
    const t = this.tank.body.translation();
    const yaw = this.bodyYaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    for (const side of [-1, 1]) {
      const lx = side * tcfg.offsetX;
      const lz = (Math.random() * 2 - 1) * tcfg.halfZ * 0.8; // 履带长度内随机
      const wx = t.x + lx * cos + lz * sin;
      const wz = t.z - lx * sin + lz * cos;
      this.dusts.push(new Dust(this.render, { x: wx, y: 0.05, z: wz }));
    }
  }

  /**
   * 第三人称相机：偏移随【炮塔世界偏航】旋转(= 车身 yaw + 炮塔相对角),
   * 始终在炮塔后方(炮管反方向)看炮管前方——视角跟随炮塔,不跟随车身。
   * 体验:玩家转炮塔(Q/W)= 转视角;转车身(←/→)时画面不跟随,车归车瞄归瞄。
   * 拆为 public:玩家侧 main 显式调用(每帧);AI 侧不调用(不抢玩家相机)。
   * 被击毁也调用——跟随残骸。
   */
  updateCamera(): void {
    this.computeCamera(camPos);
    const cfg = this.tank.driveConfig.camera;
    this.camera.position.lerp(camPos, cfg.lerp);
    this.camera.lookAt(camLook);
  }

  private computeCamera(out: Vector3): void {
    const cfg = this.tank.driveConfig.camera;
    const yaw = this.turretWorldYaw; // 视角基准=炮塔世界偏航(非车身 yaw)
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const t = this.tank.body.translation();
    const off = cfg.offset;
    const look = cfg.lookOffset;

    out.set(
      t.x + off.x * cos + off.z * sin,
      t.y + off.y,
      t.z - off.x * sin + off.z * cos,
    );
    camLook.set(
      t.x + look.x * cos + look.z * sin,
      t.y + look.y,
      t.z - look.x * sin + look.z * cos,
    );
  }

  /** 车身当前偏航角（从刚体四元数计算） */
  private get bodyYaw(): number {
    const q = this.tank.body.rotation();
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  /** 炮塔世界偏航(rad)= 车身 yaw + 炮塔相对旋转角。相机视角跟随此值。 */
  private get turretWorldYaw(): number {
    return this.bodyYaw + this.tank.turret.rotation.y;
  }

  /** 诊断用：当前炮塔角/炮管俯仰(度) */
  get aimInfo(): { turretDeg: number; barrelDeg: number } {
    return {
      turretDeg: (this.turretAngle * 180) / Math.PI,
      barrelDeg: (this.barrelPitch * 180) / Math.PI,
    };
  }
}

// 复用临时对象
const camPos = new Vector3();
const camLook = new Vector3();

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function wrapAngle(a: number): number {
  let r = a % (Math.PI * 2);
  if (r > Math.PI) r -= Math.PI * 2;
  else if (r < -Math.PI) r += Math.PI * 2;
  return r;
}
