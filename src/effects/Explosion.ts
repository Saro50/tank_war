import { Color, Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { CONFIG } from '../config';
import type { RenderScene } from '../core/RenderScene';

// 单位球，靠 scale 控制每个粒子大小
const partGeo = new SphereGeometry(1, 8, 6);

interface Particle {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  s0: number; // 初始缩放
}

/**
 * 爆炸粒子特效
 * ------------------------------------------------------------
 * 在命中点生成一组小球向外扩散 + 重力下落 + 缩小淡出，寿命到销毁。
 * 纯视觉，不参与物理（M4 破坏冲量另行处理）。
 */
export class Explosion {
  readonly group: Group;
  private readonly particles: Particle[] = [];
  private readonly maxLife: number;
  private readonly baseRadius: number;
  private life = 0;

  constructor(
    render: RenderScene,
    pos: { x: number; y: number; z: number },
    /** 尺寸缩放(1=普通炮弹爆炸;>1=放大,如坦克击毁大爆炸用 2.5)。放大粒子数/大小/寿命 */
    scale = 1,
  ) {
    const cfg = CONFIG.weapon.explosion;
    this.maxLife = cfg.lifetime * scale;
    this.baseRadius = cfg.particleRadius * scale;

    this.group = new Group();
    this.group.position.set(pos.x, pos.y, pos.z);

    const tmpColor = new Color();
    const count = Math.round(cfg.particleCount * scale);
    for (let i = 0; i < count; i++) {
      // 球面均匀随机方向
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const sp = cfg.speed * (0.5 + Math.random() * 0.7);
      const vx = Math.sin(phi) * Math.cos(theta) * sp;
      const vy = Math.sin(phi) * Math.sin(theta) * sp + 2.5; // 略向上(火球升腾)
      const vz = Math.cos(phi) * sp;

      // 橙黄→红 的暖色
      tmpColor.setHSL(0.05 + Math.random() * 0.08, 1, 0.5 + Math.random() * 0.2);
      const mat = new MeshBasicMaterial({
        color: tmpColor.clone(),
        transparent: true,
        opacity: 1,
      });
      const m = new Mesh(partGeo, mat);
      const s0 = this.baseRadius * (0.6 + Math.random() * 0.7);
      m.scale.setScalar(s0);
      this.group.add(m);
      this.particles.push({ mesh: m, mat, vx, vy, vz, s0 });
    }
    render.scene.add(this.group);
  }

  /** @returns 是否仍存活 */
  update(dt: number): boolean {
    this.life += dt;
    const t = this.life / this.maxLife;
    if (t >= 1) return false;
    for (const p of this.particles) {
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy -= 9.81 * dt; // 重力
      p.vx *= 0.95;
      p.vy *= 0.95;
      p.vz *= 0.95;
      p.mesh.scale.setScalar(Math.max(0.01, p.s0 * (1 - t)));
      p.mat.opacity = 1 - t;
    }
    return true;
  }

  dispose(render: RenderScene): void {
    for (const p of this.particles) p.mat.dispose();
    render.scene.remove(this.group);
  }
}
