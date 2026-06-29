import { Color, Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { CONFIG } from '../config';
import type { RenderScene } from '../core/RenderScene';

// 单位球，scale 控制大小
const partGeo = new SphereGeometry(1, 8, 6);

interface Smoke {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  s0: number;
}

/**
 * 炮口焰 + 烟雾
 * ------------------------------------------------------------
 * 开火瞬间在炮口生成：
 *  - 闪光：白黄亮球(MeshBasic 自发光感)，flashLife(≈0.06s) 内快速缩小淡出
 *  - 烟雾：灰色粒子沿炮口方向前喷 + 四周扩散 + 上飘，smokeLife(≈0.5s) 慢淡出
 * 纯视觉，复用 Explosion 粒子模式(速度+上飘+缩放+淡出)，不参与物理。
 */
export class MuzzleFlash {
  readonly group: Group;
  private readonly flash: Mesh;
  private readonly flashMat: MeshBasicMaterial;
  private readonly smoke: Smoke[] = [];
  private readonly flashLife: number;
  private readonly smokeLife: number;
  private readonly flashScale: number;
  private life = 0;

  constructor(
    render: RenderScene,
    pos: { x: number; y: number; z: number },
    dir: { x: number; y: number; z: number },
  ) {
    const cfg = CONFIG.weapon.muzzleFlash;
    this.flashLife = cfg.flashLife;
    this.smokeLife = cfg.smokeLife;
    this.flashScale = cfg.flashScale;

    this.group = new Group();
    this.group.position.set(pos.x, pos.y, pos.z);

    // 闪光：白黄亮球，Basic 材质不受光、自带发光感
    this.flashMat = new MeshBasicMaterial({
      color: 0xfff0a8,
      transparent: true,
      opacity: 1,
    });
    this.flash = new Mesh(partGeo, this.flashMat);
    this.flash.scale.setScalar(this.flashScale);
    this.group.add(this.flash);

    // 烟雾：灰粒子，沿炮口方向前喷 + 球面扩散 + 上飘
    const tmp = new Color();
    for (let i = 0; i < cfg.smokeCount; i++) {
      const sp = cfg.smokeSpeed * (0.4 + Math.random() * 0.7);
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      // 扩散分量(球面随机，幅度 0.5)
      const dx = Math.sin(phi) * Math.cos(theta) * sp * 0.5;
      const dy = Math.sin(phi) * Math.sin(theta) * sp * 0.5 + 0.8; // 上飘
      const dz = Math.cos(phi) * sp * 0.5;
      // 沿炮口方向前喷分量(主方向)
      const vx = dir.x * sp + dx;
      const vy = dir.y * sp * 0.5 + dy;
      const vz = dir.z * sp + dz;

      tmp.setRGB(0.42 + Math.random() * 0.18, 0.42 + Math.random() * 0.18, 0.42 + Math.random() * 0.18);
      const mat = new MeshBasicMaterial({
        color: tmp.clone(),
        transparent: true,
        opacity: 0.85,
      });
      const m = new Mesh(partGeo, mat);
      const s0 = cfg.smokeRadius * (0.7 + Math.random() * 0.8);
      m.scale.setScalar(s0);
      this.group.add(m);
      this.smoke.push({ mesh: m, mat, vx, vy, vz, s0 });
    }

    render.scene.add(this.group);
  }

  /** @returns 是否仍存活(闪光与烟雾都结束才销毁) */
  update(dt: number): boolean {
    this.life += dt;
    if (this.life >= this.smokeLife) return false; // 烟雾寿命最长，主导销毁时机

    // 闪光：按 flashLife 进度快速缩小淡出(进度>1 已消失)
    const tf = Math.min(1, this.life / this.flashLife);
    this.flash.scale.setScalar(Math.max(0.01, this.flashScale * (1 - tf)));
    this.flashMat.opacity = 1 - tf;

    // 烟雾：按 smokeLife 进度慢扩散 + 淡出
    const ts = this.life / this.smokeLife;
    for (const p of this.smoke) {
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy += 0.6 * dt; // 轻微上飘(烟自然升腾)
      p.vx *= 0.96;
      p.vz *= 0.96;
      p.mesh.scale.setScalar(p.s0 * (1 + ts * 0.8)); // 烟雾膨胀
      p.mat.opacity = 0.85 * (1 - ts);
    }
    return true;
  }

  dispose(render: RenderScene): void {
    this.flashMat.dispose();
    for (const p of this.smoke) p.mat.dispose();
    render.scene.remove(this.group);
  }
}
