import { BoxGeometry, CircleGeometry, CylinderGeometry, Mesh, MeshStandardMaterial } from 'three';
import { CONFIG } from '../config';
import type { RenderScene } from '../core/RenderScene';
import { Logger } from '../utils/Logger';

const log = Logger.create('CaptureZone');

/** 占领点当前归属状态(由 CaptureSystem 每帧根据区域内坦克集合判定后传入) */
export type CaptureOwner = 'neutral' | 'player' | 'enemy' | 'contested';

/** 进度环分段数:每段代表 1/SEGMENTS 的进度。48 段 → 粒度 ≈2%,60s 关卡每秒≈1.25 段 */
const SEGMENTS = 48;

/** 状态→圆盘/光柱配色(用视觉而非文字:蓝=我方、红=敌方、灰=中立、白=争夺中) */
const OWNER_COLOR: Record<CaptureOwner, number> = {
  neutral: 0x6a6a6a, // 中立灰
  player: 0x4a8aff, // 玩家蓝
  enemy: 0xff4a4a, // 敌方红
  contested: 0xffffff, // 争夺白
};

/**
 * 占领点 —— 中央据点的视觉与区域定义(仅占领军关卡创建)
 * ============================================================
 * 职责(纯实体,不含胜负逻辑):
 *  - 提供"占领区域"(地面圆盘半径内):CaptureSystem 用 contains() 判定坦克是否在内。
 *  - 视觉呈现:地面发光圆盘 + 顶部阵营色光柱(远距离可见) + 地面进度环(直观显示双方进度)。
 *  - 状态色随归属切换(neutral/player/enemy/contested),玩家一眼读懂当前谁在占。
 *
 * 与 ResupplyPoint 的区别:
 *  - 无物理碰撞体:坦克必须能开进据点中心(占领机制要求),补给点则是 fixed 实心需绕行。
 *  - 不可摧毁:不实现 Damageable,不接入伤害链。首版聚焦"占住"本身。
 *  - 双向进度:同时显示玩家进度环(外圈蓝)+ 敌方进度环(内圈红)。
 *
 * 进度环实现:每个环预创建 SEGMENTS 个小段围成圆,按进度比例显隐前 N 段。
 *  零运行时分配(只切 visible),性能稳定。比每帧重建 TorusGeometry 的 arc 更省 GC。
 *
 * 数据来源:CaptureSystem 每帧算出 (owner, playerProgress, enemyProgress) 后
 *           调 updateVisual() 推送到本实体,本实体不自己计时——职责单一。
 */
export class CaptureZone {
  /** 据点水平中心(地面 y=0) */
  readonly position: { x: number; z: number };
  /** 占领半径(m):坦克水平距离 ≤ 此值即在区域内 */
  readonly radius: number;

  // 视觉
  private readonly disk: Mesh; // 地面发光圆盘(标识区域 + 状态色)
  private readonly diskMat: MeshStandardMaterial;
  private readonly beam: Mesh; // 顶部阵营色光柱(远距离可见)
  private readonly beamMat: MeshStandardMaterial;
  /** 玩家进度环段(外圈,蓝);按进度显隐前 N 段 */
  private readonly playerSegments: Mesh[] = [];
  /** 敌方进度环段(内圈,红);按进度显隐前 N 段 */
  private readonly enemySegments: Mesh[] = [];

  /** 共享段几何(所有段同一形状,只位置/旋转不同)。
   *  尺寸 (X=0.9 切线长, Y=0.5 高, Z=0.16 径向厚):绕 Y 旋转 angle 后,
   *  局部 X 轴(0.9 长边)对齐圆周切线方向 → 段沿圆周排列成连续环(非径向辐条)。 */
  private static readonly segGeo = new BoxGeometry(0.9, 0.5, 0.16);
  /** 共享单位圆几何(所有占领点共用;首版仅一个实例,仍按 ResupplyPoint 规范 static 化) */
  private static readonly diskGeo = new CircleGeometry(1, 48);

  constructor(render: RenderScene, pos: { x: number; z: number }) {
    const cfg = CONFIG.capturePoint;
    this.position = { x: pos.x, z: pos.z };
    this.radius = cfg.radius;

    // —— 地面发光圆盘(标识占领区域,半径=radius) ——
    this.diskMat = new MeshStandardMaterial({
      color: OWNER_COLOR.neutral,
      emissive: OWNER_COLOR.neutral,
      emissiveIntensity: 0.5,
      roughness: 0.6,
      metalness: 0,
      transparent: true,
      opacity: 0.45,
    });
    this.disk = new Mesh(CaptureZone.diskGeo, this.diskMat);
    this.disk.rotation.x = -Math.PI / 2; // 平铺地面
    this.disk.position.set(pos.x, 0.05, pos.z); // 略离地面防 z-fighting
    this.disk.scale.setScalar(cfg.radius);
    render.scene.add(this.disk);

    // —— 顶部阵营色光柱(高圆柱,半透明,远距离可见据点位置) ——
    this.beamMat = new MeshStandardMaterial({
      color: OWNER_COLOR.neutral,
      emissive: OWNER_COLOR.neutral,
      emissiveIntensity: 0.8,
      transparent: true,
      opacity: 0.25,
      roughness: 0.4,
      depthWrite: false, // 不写深度,避免半透明光柱遮挡其后场景的渲染排序问题
    });
    this.beam = new Mesh(new CylinderGeometry(1.2, 1.6, 28, 16, 1, true), this.beamMat);
    this.beam.position.set(pos.x, 14, pos.z); // 柱高 28m,中心抬高 14m
    render.scene.add(this.beam);

    // —— 玩家进度环(外圈,蓝):SEGMENTS 段围成圆 ——
    this.playerSegments = this.buildRing(render, cfg.radius * 1.02, 0x4a8aff);
    // —— 敌方进度环(内圈,红):SEGMENTS 段围成圆 ——
    this.enemySegments = this.buildRing(render, cfg.radius * 0.88, 0xff4a4a);

    log.info('capture zone built', { at: `${pos.x},${pos.z}`, radius: cfg.radius });
  }

  /**
   * 构建一个进度环:SEGMENTS 段小立方体均匀分布在半径 r 的圆周上。
   * 每段初始 visible=false(进度为 0);由 updateVisual 按进度显隐。
   * 段沿圆周切线方向放置(绕 Y 旋转 angle,Z 轴对齐切线)。
   */
  private buildRing(render: RenderScene, r: number, color: number): Mesh[] {
    const segs: Mesh[] = [];
    const mat = new MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.0,
      roughness: 0.4,
      metalness: 0,
    });
    for (let i = 0; i < SEGMENTS; i++) {
      const angle = (i / SEGMENTS) * Math.PI * 2;
      const m = new Mesh(CaptureZone.segGeo, mat);
      // 圆周位置:y=0.25 让段半埋地面、半凸起,视觉上像"地面镶的灯带"
      m.position.set(this.position.x + Math.sin(angle) * r, 0.25, this.position.z + Math.cos(angle) * r);
      m.rotation.y = angle; // X 轴(段长边 0.9)对齐圆周切线方向 → 段沿环排列
      m.visible = false; // 初始进度 0:全隐藏
      render.scene.add(m);
      segs.push(m);
    }
    return segs;
  }

  /** 坦克是否在占领区域内(水平距离)。供 CaptureSystem 每帧对每辆坦克判定 */
  contains(pos: { x: number; z: number }): boolean {
    const dx = pos.x - this.position.x;
    const dz = pos.z - this.position.z;
    return dx * dx + dz * dz <= this.radius * this.radius;
  }

  /**
   * 由 CaptureSystem 每帧调用:推送当前归属与进度,更新视觉。
   * @param owner            当前归属(决定圆盘/光柱配色)
   * @param playerProgress   玩家累计占领秒数
   * @param playerTarget     玩家获胜所需秒数(算显隐段比例)
   * @param enemyProgress    敌方累计占领秒数
   * @param enemyTarget      敌方致玩家失败所需秒数
   */
  updateVisual(
    owner: CaptureOwner,
    playerProgress: number,
    playerTarget: number,
    enemyProgress: number,
    enemyTarget: number,
  ): void {
    // 状态色:圆盘 + 光柱同步切换(用视觉一眼读懂归属)
    const c = OWNER_COLOR[owner];
    this.diskMat.color.setHex(c);
    this.diskMat.emissive.setHex(c);
    this.beamMat.color.setHex(c);
    this.beamMat.emissive.setHex(c);
    // 争夺态圆盘闪烁(更强的视觉反馈:有人正在抢)
    this.diskMat.emissiveIntensity = owner === 'contested' ? 0.5 + Math.sin(performance.now() * 0.012) * 0.4 : 0.5;

    // 进度环显隐:按进度比例显示前 N 段(零分配,只切 visible)
    const playerN = playerTarget > 0 ? Math.round((playerProgress / playerTarget) * SEGMENTS) : 0;
    const enemyN = enemyTarget > 0 ? Math.round((enemyProgress / enemyTarget) * SEGMENTS) : 0;
    for (let i = 0; i < SEGMENTS; i++) {
      this.playerSegments[i].visible = i < playerN;
      this.enemySegments[i].visible = i < enemyN;
    }
  }

  /** 每帧动画:光柱缓慢自转(引导视线)。由 CaptureSystem.update 调用 */
  update(dt: number): void {
    this.beam.rotation.y += dt * 0.3;
  }

  dispose(render: RenderScene): void {
    render.scene.remove(this.disk, this.beam);
    // 进度环段(共享一个 material,只 dispose 一次)
    const ringMats = new Set<MeshStandardMaterial>();
    for (const m of [...this.playerSegments, ...this.enemySegments]) {
      render.scene.remove(m);
      if (m.material instanceof MeshStandardMaterial) ringMats.add(m.material);
    }
    ringMats.forEach((mt) => mt.dispose());
    this.diskMat.dispose();
    this.beamMat.dispose();
    this.beam.geometry.dispose();
    // diskGeo / segGeo 是 static 共享,不在此释放
  }
}
