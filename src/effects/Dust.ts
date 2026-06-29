import { Color, Group, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';
import { CONFIG } from '../config';
import type { RenderScene } from '../core/RenderScene';

// 单位球，scale 控制大小
const partGeo = new SphereGeometry(1, 8, 6);

interface DustParticle {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  s0: number;
}

/**
 * 履带扬尘
 * ------------------------------------------------------------
 * 在履带接地点生成一团土黄尘雾：上半球扩散为主 + 微上飘，
 * 慢速膨胀 + 淡出。复用 Explosion 粒子模式，纯视觉不参与物理。
 */
export class Dust {
  readonly group: Group;
  private readonly particles: DustParticle[] = [];
  private readonly maxLife: number;
  private life = 0;

  constructor(render: RenderScene, pos: { x: number; y: number; z: number }) {
    const cfg = CONFIG.tank.dust;
    this.maxLife = cfg.lifetime;

    this.group = new Group();
    this.group.position.set(pos.x, pos.y, pos.z);

    const base = new Color(cfg.color);
    for (let i = 0; i < cfg.particles; i++) {
      const sp = cfg.speed * (0.3 + Math.random() * 0.7);
      const theta = Math.random() * Math.PI * 2;
      // 上半球(接地尘雾主要向上扩散)：phi ∈ [0, π/2]
      const phi = Math.acos(Math.random());
      const vx = Math.sin(phi) * Math.cos(theta) * sp;
      const vy = Math.cos(phi) * sp * 0.8 + sp * 0.4; // 偏上
      const vz = Math.sin(phi) * Math.sin(theta) * sp;

      // 颜色亮度随机扰动，避免一团死板
      const cc = base.clone();
      cc.offsetHSL(0, 0, (Math.random() - 0.5) * 0.1);
      const mat = new MeshBasicMaterial({ color: cc, transparent: true, opacity: 0.55 });
      const m = new Mesh(partGeo, mat);
      const s0 = cfg.particleRadius * (0.7 + Math.random() * 0.8);
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
      p.vy += 0.4 * dt; // 微上飘(尘自然升腾)
      p.vx *= 0.94;
      p.vz *= 0.94;
      p.mesh.scale.setScalar(p.s0 * (1 + t * 1.2)); // 尘雾膨胀
      p.mat.opacity = 0.55 * (1 - t);
    }
    return true;
  }

  dispose(render: RenderScene): void {
    for (const p of this.particles) p.mat.dispose();
    render.scene.remove(this.group);
  }
}
