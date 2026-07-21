/**
 * modelOps.ts — TankModel 加载层 + 几何推算(契约层,游戏/编辑器共用)
 * ============================================================
 * 职责:把"可能缺字段的 TankModel JSON"合并缺省,产出"游戏就绪的 ResolvedTankModel"。
 *
 * 缺省三源(优先级从高到低):
 *   1. JSON 显式值(车型差异,用户/转换器填的)
 *   2. CONFIG 兜底(全局通用值,DRY:不重复维护数值)
 *   3. 几何推算(从 parts 派生,自定义坦克的物理包络)
 *
 * 设计原则:
 *   - JSON 存"差异",CONFIG 存"通用",推算填"几何" → 三层正交,各司其职
 *   - resolve 后永不缺值(防御:游戏实体读取时不因缺字段崩溃)
 *   - 推算函数纯函数(无副作用),便于编辑器"自动推算"按钮复用
 *
 * 调用方:
 *   - 编辑器:加载自定义坦克时 resolve(显示完整值);保存时存 resolve 后全量(自包含)
 *   - 未来游戏:TankDataStore 加载 JSON 后 resolve,交实体类(拿到完整运行数据)
 */
import { CONFIG } from '../config';
import type { TankModel, TankPart, ResolvedTankModel, Physics, Drive } from './TankSchema';

// ============================================================
// 几何推算(从 parts 派生物理包络)
// ============================================================

/** 单 part 的物理包络半尺寸(用于 AABB/炮塔物理体推算)。
 *  按形状取"底面/最大截面"作包络(物理碰撞用包络近似,非精确视觉 AABB):
 *   - box: half
 *   - cylinder: {radius, height/2, radius}(圆柱侧放,x/z 用半径)
 *   - wedge symmetric/asymmetric: 底面 {bottomHalfX, height/2, bottomHalfZ}(楔形底大顶小,用底面包络)
 *   - wedge glacis: {halfX, halfHeight, halfDepth} */
export function partHalfExtents(part: TankPart): { x: number; y: number; z: number } {
  switch (part.shape) {
    case 'box':
      return part.half ?? { x: 0.1, y: 0.1, z: 0.1 };
    case 'cylinder':
      return { x: part.radius ?? 0.1, y: (part.height ?? 0.2) / 2, z: part.radius ?? 0.1 };
    case 'wedge': {
      const w = part.wedge;
      if (!w) return { x: 0.1, y: 0.1, z: 0.1 };
      if (w.mode === 'glacis') return { x: w.halfX, y: w.halfHeight, z: w.halfDepth };
      // symmetric / asymmetric:用底面包络(楔形底大顶小,底面是最大截面)
      return { x: w.bottomHalfX, y: w.height / 2, z: w.bottomHalfZ };
    }
  }
}

/** wedge 的 y 几何中心偏移(symmetric/asymmetric 有 centerY;glacis/其他为 0)。
 *  AABB 推算时加到 position.y 上(楔形几何中心不在 position.y,而在 position.y + centerY)。 */
function wedgeCenterY(part: TankPart): number {
  if (part.shape === 'wedge' && part.wedge && part.wedge.mode !== 'glacis') {
    return part.wedge.centerY;
  }
  return 0;
}

/**
 * 整车轴对齐包围盒(AABB)半尺寸 —— 自定义坦克 physics.bodyHalf 的缺省推算。
 * 遍历所有 part(含 instances 展开),求合并 AABB 的半尺寸。
 *
 * 精度说明:物理碰撞体本就是"包络近似"(自定义坦克形状不规则,精确碰撞体不现实)。
 * 多数游戏的自定义载具都用 AABB 包络,这是合理且可接受的近似。
 * 用户若需精确值,可在编辑器 physics.bodyHalf 手填覆盖。
 */
export function computeAABB(parts: TankPart[]): { x: number; y: number; z: number } {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const defaultInst = [{ dx: 0, dy: 0, dz: 0 }];
  for (const part of parts) {
    const h = partHalfExtents(part);
    const cyOff = wedgeCenterY(part);
    const insts = part.instances ?? defaultInst;
    for (const off of insts) {
      const cx = part.position.x + off.dx;
      const cy = part.position.y + off.dy + cyOff;
      const cz = part.position.z + off.dz;
      if (cx - h.x < minX) minX = cx - h.x;
      if (cx + h.x > maxX) maxX = cx + h.x;
      if (cy - h.y < minY) minY = cy - h.y;
      if (cy + h.y > maxY) maxY = cy + h.y;
      if (cz - h.z < minZ) minZ = cz - h.z;
      if (cz + h.z > maxZ) maxZ = cz + h.z;
    }
  }
  // 无部件的退化情形(refine 已防,但兜底防 NaN)
  if (!Number.isFinite(minX)) return { x: 1, y: 0.5, z: 1 };
  return { x: (maxX - minX) / 2, y: (maxY - minY) / 2, z: (maxZ - minZ) / 2 };
}

/**
 * 炮塔物理体半尺寸 —— 自定义坦克 physics.turretHalf 的缺省推算。
 * 从 role='turret-body' 部件取包络半尺寸(击毁炸飞炮塔的 dynamic cuboid 用)。
 * 找不到时回退经验值(refine 已保证必备 role,此处兜底防崩)。
 */
export function computeTurretHalf(parts: TankPart[]): { x: number; y: number; z: number } {
  const turret = parts.find((p) => p.role === 'turret-body');
  if (!turret) return { x: 0.6, y: 0.3, z: 0.6 };
  return partHalfExtents(turret);
}

// ============================================================
// CONFIG 提取(驾驶手感缺省)
// ============================================================

/**
 * 从 CONFIG.tank 提取驾驶手感(动态坦克基准手感)。
 * 自定义坦克 drive 缺省时用此值 —— 即"玩家基准手感"。
 * 与 T14Tank.driveConfig getter 的映射一致(DRY:单一映射源)。
 */
export function extractDriveFromTankConfig(): Drive {
  const c = CONFIG.tank;
  return {
    moveSpeed: c.moveSpeed,
    turnSpeed: c.turnSpeed,
    accelLerp: c.accelLerp,
    reverseScale: c.reverseScale,
    turret: { turnSpeed: c.turret.turnSpeed, omegaLerp: c.turret.omegaLerp },
    barrel: { pitchRange: c.barrel.pitchRange, pitchSpeed: c.barrel.pitchSpeed },
    track: { offsetX: c.track.offsetX, halfZ: c.track.halfZ, rollScale: c.track.rollScale },
    camera: { offset: c.camera.offset, lookOffset: c.camera.lookOffset, lerp: c.camera.lerp },
    dust: { minSpeed: c.dust.minSpeed, spawnPerMeter: c.dust.spawnPerMeter },
    sway: { pitchScale: c.sway.pitchScale, rollScale: c.sway.rollScale, lerp: c.sway.lerp },
  };
}

// ============================================================
// resolve:合并缺省 → 游戏就绪的 ResolvedTankModel
// ============================================================

/**
 * 合并缺省:JSON 差异字段 + CONFIG/几何兜底 → 游戏就绪的 ResolvedTankModel。
 * ------------------------------------------------------------
 * 优先级:JSON 显式值 > CONFIG 兜底(数值类) > 几何推算(物理包络)。
 * 返回的 ResolvedTankModel 全字段填充,游戏实体读取时永不缺值(防御)。
 *
 * 缺省映射(详见方案"字段缺省映射表"):
 *   physics.bodyHalf       ← JSON ?? computeAABB(parts)
 *   physics.colliderOffset ← JSON ?? undefined(实体层按需兜底)
 *   physics.turretHalf     ← JSON ?? computeTurretHalf(parts)
 *   damage.smokeThreshold  ← JSON ?? CONFIG.staticTank(0.6)
 *   damage.destroy*        ← JSON ?? CONFIG.staticTank(4 / 1.6)
 *   damage.smokeOffset     ← JSON ?? {0,1,0}
 *   damage.regen*          ← JSON ?? CONFIG.tank.damage(8 / 5)
 *   drive                  ← JSON ?? extractDriveFromTankConfig()
 */
export function resolveTankModel(raw: TankModel): ResolvedTankModel {
  const bodyHalf = raw.physics?.bodyHalf ?? computeAABB(raw.parts);
  const physics: Physics = {
    bodyHalf,
    colliderOffset: raw.physics?.colliderOffset,
    turretHalf: raw.physics?.turretHalf ?? computeTurretHalf(raw.parts),
  };

  // damage 缺省:tank 与 staticTank 顶层同值(0.6/4/1.6),统一用 staticTank 顶层(语义更通用)
  const sd = CONFIG.staticTank;
  const damage = {
    smokeThreshold: raw.damage?.smokeThreshold ?? sd.smokeThreshold,
    destroyExplosionScale: raw.damage?.destroyExplosionScale ?? sd.destroyExplosionScale,
    destroySmokeScale: raw.damage?.destroySmokeScale ?? sd.destroySmokeScale,
    smokeOffset: raw.damage?.smokeOffset ?? { x: 0, y: 1.0, z: 0 },
    // 回血已移至补给点,不再需要脱战回血配置
  };

  const drive = raw.drive ?? extractDriveFromTankConfig();

  return { ...raw, physics, damage, drive };
}
