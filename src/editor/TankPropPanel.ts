/**
 * TankPropPanel.ts — 右侧整车属性编辑(与 PartPropPanel 切换显示)
 * ============================================================
 * 分区:基础 → 物理(physics) → 损坏(damage) → 驾驶(drive,折叠) → 外观(camo/decal/materials)
 *
 * 字段缺失时(resolve 前)用兜底值显示,编辑后写回(显式落盘)。
 * drive 块字段多,用 <details> 折叠(默认收起,高级调参)。
 */
import type { TankModel } from '../data/TankSchema';
import { numberRow, vec3Row, colorRow, textRow, boolRow, selectRow, groupTitle } from './uiWidgets';

const VEC3_RANGE: [number, number, number] = [-5, 5, 0.01];
const CAMO_STYLES = ['nato-blotch', 'stripe', 'splatter', 'two-tone', 'legacy'] as const;

export function renderTankPropPanel(
  container: HTMLElement,
  model: TankModel,
  onChange: (patch: Partial<TankModel>) => void,
): void {
  container.innerHTML = '';

  // —— 基础 ——
  container.appendChild(groupTitle('基础'));
  container.appendChild(textRow('名称', model.name, (v) => onChange({ name: v })));
  container.appendChild(numberRow('质量(kg)', model.mass, [10, 10000, 10], false, (v) => onChange({ mass: v })));
  container.appendChild(numberRow('最大HP', model.maxHp, [1, 500, 1], true, (v) => onChange({ maxHp: v })));
  container.appendChild(boolRow('静态展示', model.isStatic ?? false, (v) => onChange({ isStatic: v })));

  // —— 物理(physics)——
  container.appendChild(groupTitle('物理(碰撞体)'));
  const ph = model.physics;
  if (ph) {
    const cur = { ...ph };  // 跟踪当前,避免多字段顺序编辑闭包旧值覆盖(同 vec3Row bug)
    container.appendChild(vec3Row('整车半尺寸', cur.bodyHalf, [0.1, 5, 0.01], (v) => { cur.bodyHalf = v; onChange({ physics: { ...cur } }); }));
    if (cur.colliderOffset) {
      container.appendChild(vec3Row('碰撞体偏移', cur.colliderOffset, VEC3_RANGE, (v) => { cur.colliderOffset = v; onChange({ physics: { ...cur } }); }));
    }
    if (cur.turretHalf) {
      container.appendChild(vec3Row('炮塔物理体', cur.turretHalf, [0.05, 3, 0.01], (v) => { cur.turretHalf = v; onChange({ physics: { ...cur } }); }));
    }
  } else {
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:10px;color:#555;padding:2px 0 2px 60px;';
    hint.textContent = 'physics 缺省(resolveTankModel 从部件自动推算)';
    container.appendChild(hint);
  }

  // —— 损坏(damage)——
  container.appendChild(groupTitle('损坏'));
  const d = model.damage;
  if (d) {
    const cur = { ...d };
    container.appendChild(numberRow('冒烟阈值', cur.smokeThreshold ?? 0.6, [0, 1, 0.05], false, (v) => { cur.smokeThreshold = v; onChange({ damage: { ...cur } }); }));
    container.appendChild(numberRow('爆炸缩放', cur.destroyExplosionScale ?? 4, [0.5, 10, 0.1], false, (v) => { cur.destroyExplosionScale = v; onChange({ damage: { ...cur } }); }));
    container.appendChild(numberRow('浓烟缩放', cur.destroySmokeScale ?? 1.6, [0.5, 5, 0.1], false, (v) => { cur.destroySmokeScale = v; onChange({ damage: { ...cur } }); }));
    if (cur.smokeOffset) {
      container.appendChild(vec3Row('冒烟位置', cur.smokeOffset, VEC3_RANGE, (v) => { cur.smokeOffset = v; onChange({ damage: { ...cur } }); }));
    }
    container.appendChild(numberRow('回血延迟(s)', cur.regenDelay ?? 8, [0, 30, 1], false, (v) => { cur.regenDelay = v; onChange({ damage: { ...cur } }); }));
    container.appendChild(numberRow('回血速率', cur.regenRate ?? 5, [0, 30, 1], false, (v) => { cur.regenRate = v; onChange({ damage: { ...cur } }); }));
  }

  // —— 驾驶(drive,折叠)——
  const driveDetails = document.createElement('details');
  driveDetails.style.margin = '6px 0';
  const driveSummary = document.createElement('summary');
  driveSummary.textContent = '驾驶手感(高级)';
  driveSummary.style.cssText = 'color:#ffcc33;font-size:12px;cursor:pointer;margin:10px 0 4px;border-bottom:1px solid #2a2c32;padding-bottom:2px;';
  driveDetails.appendChild(driveSummary);
  const dv = model.drive;
  if (dv) {
    // 深拷贝含嵌套 turret/barrel,跟踪当前值(避免顺序编辑闭包旧值覆盖)
    const cur = { ...dv, turret: { ...dv.turret }, barrel: { ...dv.barrel } };
    driveDetails.appendChild(numberRow('移动速度', cur.moveSpeed, [0, 30, 0.1], false, (v) => { cur.moveSpeed = v; onChange({ drive: { ...cur } }); }));
    driveDetails.appendChild(numberRow('转向速度', cur.turnSpeed, [0, 5, 0.1], false, (v) => { cur.turnSpeed = v; onChange({ drive: { ...cur } }); }));
    driveDetails.appendChild(numberRow('加速平滑', cur.accelLerp, [0, 1, 0.01], false, (v) => { cur.accelLerp = v; onChange({ drive: { ...cur } }); }));
    driveDetails.appendChild(numberRow('倒车比例', cur.reverseScale, [0, 1, 0.05], false, (v) => { cur.reverseScale = v; onChange({ drive: { ...cur } }); }));
    driveDetails.appendChild(numberRow('炮塔转速', cur.turret.turnSpeed, [0, 5, 0.1], false, (v) => { cur.turret.turnSpeed = v; onChange({ drive: { ...cur } }); }));
    driveDetails.appendChild(numberRow('炮管俯仰速', cur.barrel.pitchSpeed, [0, 5, 0.1], false, (v) => { cur.barrel.pitchSpeed = v; onChange({ drive: { ...cur } }); }));
  }
  container.appendChild(driveDetails);

  // —— 外观(camo + materials)——
  container.appendChild(groupTitle('外观(迷彩)'));
  const camo = model.camo;
  const cur = { ...camo };  // 跟踪当前
  container.appendChild(colorRow('底色', cur.base, (v) => { cur.base = v; onChange({ camo: { ...cur } }); }));
  container.appendChild(colorRow('深色斑块', cur.blobDark, (v) => { cur.blobDark = v; onChange({ camo: { ...cur } }); }));
  container.appendChild(colorRow('中间斑块', cur.blobMid, (v) => { cur.blobMid = v; onChange({ camo: { ...cur } }); }));
  container.appendChild(selectRow('迷彩样式', cur.style, CAMO_STYLES, (v) => { cur.style = v as typeof camo.style; onChange({ camo: { ...cur } }); }));
  container.appendChild(numberRow('磨损度', cur.wear, [0, 1, 0.05], false, (v) => { cur.wear = v; onChange({ camo: { ...cur } }); }));

  // —— 贴花 ——
  if (model.decal) {
    container.appendChild(groupTitle('贴花'));
    const dc = model.decal;
    const cur = { ...dc };  // 跟踪当前
    container.appendChild(textRow('编号', cur.number, (v) => { cur.number = v; onChange({ decal: { ...cur } }); }));
    container.appendChild(boolRow('黑十字', cur.cross ?? false, (v) => { cur.cross = v; onChange({ decal: { ...cur } }); }));
  }
}
