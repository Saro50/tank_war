import type { PerspectiveCamera } from 'three';
import { Vector3 } from 'three';
import { CONFIG } from '../config';

/**
 * 相机震动
 * ------------------------------------------------------------
 * 事件(开火/爆炸)调用 add()，每帧 update() 在控制器设好相机位置后
 * 叠加随机扰动。trauma 平方衰减，手感比线性更自然。
 *
 * 调用约定：必须在 TankController.updateCamera 之后调用 update，
 *           否则控制器会覆盖震动位移。
 * 基于基准位置叠加扰动(非累加):每帧保存控制器设好的位置,在此基础上加扰动,
 * 避免控制器某帧未运行时扰动累积漂移。
 */
export class CameraShake {
  private trauma = 0;
  private readonly basePos = new Vector3();

  constructor(private readonly camera: PerspectiveCamera) {}

  /** 触发震动，intensity 累加(0~1) */
  add(intensity: number): void {
    this.trauma = Math.min(1, this.trauma + intensity);
  }

  update(dt: number): void {
    if (this.trauma <= 0.001) {
      this.trauma = 0;
      return;
    }
    // 保存控制器设好的基准位置,基于此叠加扰动(防累积漂移)
    this.basePos.copy(this.camera.position);
    const cfg = CONFIG.weapon.recoil;
    const amp = this.trauma * this.trauma * cfg.cameraShake;
    this.camera.position.x = this.basePos.x + (Math.random() - 0.5) * 2 * amp;
    this.camera.position.y = this.basePos.y + (Math.random() - 0.5) * 2 * amp;
    this.camera.position.z = this.basePos.z + (Math.random() - 0.5) * 2 * amp;
    // 帧率无关衰减
    this.trauma *= Math.pow(cfg.cameraShakeDecay, dt * 60);
  }
}
