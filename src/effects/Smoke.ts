import { Color, Group, Mesh, MeshBasicMaterial, SphereGeometry, Vector3 } from 'three';

// 单位球,靠 scale 控制每个烟粒大小
const partGeo = new SphereGeometry(1, 8, 6);

interface SmokeParticle {
  mesh: Mesh;
  mat: MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  s0: number;
  age: number; // 已存活时间
  life: number; // 总寿命
}

/**
 * 持续冒烟源(坦克受伤状态)。
 * ------------------------------------------------------------
 * 仿 Explosion 粒子模式,但寿命更长、持续发射、可调密度:
 *  - 由 caller(StaticTank)持有一份,挂在冒烟点(如炮塔顶)
 *  - setIntensity(0~1) 控制冒烟浓度(HP 越低越浓);0 时停止发射
 *  - 每帧 update(dt) 推进粒子:上升 + 横向飘散 + 膨胀 + 淡出,寿命到回收
 *  - 纯视觉,不参与物理
 *
 * 与 Explosion 区别:Explosion 是一次性火球(短寿命);Smoke 是持续源(长寿命、循环)。
 */
export class Smoke {
  readonly group: Group;
  private readonly particles: SmokeParticle[] = [];
  /** 冒烟强度 0~1(0=停,1=最浓) */
  private intensity = 0;
  /** 发射累积器(按 intensity 累积,达阈值吐一个粒子) */
  private emitAcc = 0;
  private readonly baseColor = new Color(0x222222);
  /** 烟雾尺寸/密度/寿命缩放(1=受伤烟;1.6=击毁浓烟,放大挡视线) */
  private readonly scale: number;

  constructor(
    /** 冒烟发射点(局部,相对挂载的 group;通常在炮塔顶) */
    private readonly emitOffset = new Vector3(0, 0.5, 0),
    scale = 1,
  ) {
    this.scale = scale;
    this.group = new Group();
    // 不自行 add 到场景:由 owner 挂到合适父节点(如炮塔),冒烟随坦克移动
  }

  /** 设置冒烟强度(0~1),由坦克按 HP 比例控制 */
  setIntensity(v: number): void {
    this.intensity = Math.max(0, Math.min(1, v));
  }

  /** 更新粒子 + 按强度发射新粒子。@returns 始终 true(持续源,由 owner 决定何时 dispose) */
  update(dt: number): boolean {
    // 按强度发射:intensity 越高,每秒发射越多(scale 放大击毁浓烟密度)
    const emitRate = this.intensity * 18 * this.scale; // 满强度 18×scale 粒/秒
    this.emitAcc += emitRate * dt;
    while (this.emitAcc >= 1) {
      this.emitAcc -= 1;
      this.spawn();
    }

    // 推进现有粒子
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      const t = p.age / p.life;
      if (t >= 1) {
        // 回收:dispose 材质 + 移除 mesh
        p.mat.dispose();
        this.group.remove(p.mesh);
        this.particles.splice(i, 1);
        continue;
      }
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.y += p.vy * dt;
      p.mesh.position.z += p.vz * dt;
      p.vy += 0.5 * dt; // 持续上飘(烟自然升腾)
      p.vx *= 0.97;
      p.vz *= 0.97;
      p.mesh.scale.setScalar(p.s0 * (1 + t * 2.2)); // 烟雾膨胀(比尘雾更明显)
      p.mat.opacity = 0.6 * (1 - t); // 慢淡出
    }
    return true;
  }

  /** 发射一个烟粒(从发射点附近随机扰动) */
  private spawn(): void {
    const sp = 0.6 + Math.random() * 0.5; // 初速度
    const theta = Math.random() * Math.PI * 2;
    const vx = Math.cos(theta) * sp * 0.4; // 横向小扰动
    const vy = sp * 0.9 + 0.4; // 主向上
    const vz = Math.sin(theta) * sp * 0.4;

    // 颜色亮度随机扰动(灰黑烟,略带褐)
    const cc = this.baseColor.clone();
    cc.offsetHSL(0, 0, (Math.random() - 0.5) * 0.08);
    const mat = new MeshBasicMaterial({ color: cc, transparent: true, opacity: 0.6 });
    const m = new Mesh(partGeo, mat);
    const s0 = (0.22 + Math.random() * 0.18) * this.scale;
    m.scale.setScalar(s0);
    // 发射点 + 小随机偏移
    m.position.set(
      this.emitOffset.x + (Math.random() - 0.5) * 0.2,
      this.emitOffset.y + (Math.random() - 0.5) * 0.1,
      this.emitOffset.z + (Math.random() - 0.5) * 0.2,
    );
    this.group.add(m);
    this.particles.push({
      mesh: m, mat, vx, vy, vz, s0,
      age: 0, life: (1.6 + Math.random() * 0.8) * this.scale, // 寿命随 scale 放大(烟比火球久)
    });
  }

  /** 销毁:清所有粒子并从父节点移除 group */
  dispose(): void {
    for (const p of this.particles) {
      p.mat.dispose();
      this.group.remove(p.mesh);
    }
    this.particles.length = 0;
    if (this.group.parent) {
      this.group.parent.remove(this.group);
    }
  }
}
