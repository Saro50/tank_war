/**
 * PartPropPanel.ts — 右侧部件属性编辑(选中 part 后显示)
 * ============================================================
 * 分区:基础(名称/部位/角色) → 尺寸(按 shape 分化) → 变换(position/rotation) → 外观(color/materialKey)
 *
 * 设计:
 *   - shape 可切换(box↔cylinder↔wedge),切换重置尺寸字段;box/cylinder/wedge 完整尺寸编辑
 *   - role 下拉含"无"选项(普通装饰件无 role);选 role 时 modelOps 维护唯一性
 */
import type { TankPart, PartType, PartRole, MaterialKey, PartShape } from '../data/TankSchema';
import { PART_TYPES, PART_SHAPES, MATERIAL_KEYS } from '../data/TankSchema';
import { numberRow, vec3Row, colorRow, selectRow, textRow, boolRow, groupTitle } from './uiWidgets';

const VEC3_RANGE: [number, number, number] = [-3, 3, 0.01];
const SIZE_RANGE: [number, number, number] = [0.01, 3, 0.01];

/** partType → 允许的 role 选项(约束:role 必须匹配 partType,与 TankPartSchema refine 一致)。
 *  hull/wheel/decorative 无对应 role(无运行时锚点职责)。 */
const ROLE_FOR_TYPE: Record<string, PartRole[]> = {
  turret: ['turret-body'],
  barrel: ['main-barrel'],
  track: ['left-track', 'right-track'],
};

export function renderPartPropPanel(
  container: HTMLElement,
  part: TankPart,
  onChange: (patch: Partial<TankPart>) => void,
): void {
  container.innerHTML = '';

  // —— 基础 ——
  container.appendChild(groupTitle('基础'));
  container.appendChild(textRow('名称', part.name, (v) => onChange({ name: v })));
  // partType 改变时,若当前 role 不匹配新 partType 则清 role(保持 refine 约束)
  const onPartTypeChange = (newType: PartType): void => {
    const allowed = ROLE_FOR_TYPE[newType] ?? [];
    const patch: Partial<TankPart> = { partType: newType };
    if (part.role && !allowed.includes(part.role)) patch.role = undefined;
    onChange(patch);
  };
  container.appendChild(selectRow('部位类型', part.partType, PART_TYPES, (v) => onPartTypeChange(v as PartType)));
  // role 按 partType 过滤(只显示匹配项);无 role 资格的 partType 显示提示
  const allowedRoles = ROLE_FOR_TYPE[part.partType] ?? [];
  if (allowedRoles.length > 0) {
    const roleOpts = ['无', ...allowedRoles];
    container.appendChild(selectRow('运行角色', part.role ?? '无', roleOpts, (v) =>
      onChange({ role: v === '无' ? undefined : (v as PartRole) }),
    ));
  } else {
    const hint = document.createElement('div');
    hint.className = 'prop-row';
    hint.innerHTML = '<label>运行角色</label><span style="font-size:10px;color:#555;">此部位无锚点职责</span>';
    container.appendChild(hint);
  }
  // shape 可切换(box↔cylinder↔wedge):切换时重置尺寸字段,保留 position/color/partType/role
  // 这样用户加 box 车体能直接切 wedge 调楔形,无需删了重加(从模板搭预设坦克的关键能力)
  const onShapeChange = (newShape: PartShape): void => {
    const patch: Partial<TankPart> = {
      shape: newShape,
      half: undefined, radius: undefined, height: undefined, segments: undefined, wedge: undefined, arc: undefined,
    };
    if (newShape === 'box') {
      patch.half = { x: 0.2, y: 0.2, z: 0.2 };
    } else if (newShape === 'cylinder') {
      patch.radius = 0.1; patch.height = 0.3; patch.segments = 16;
    } else {
      patch.wedge = { mode: 'symmetric' as const, bottomHalfX: 0.3, topHalfX: 0.25, bottomHalfZ: 0.4, topHalfZ: 0.3, height: 0.3, centerY: 0 };
    }
    onChange(patch);
  };
  container.appendChild(selectRow('形状', part.shape, PART_SHAPES, (v) => onShapeChange(v as PartShape)));

  // —— 尺寸(按 shape 分化)——
  container.appendChild(groupTitle('尺寸'));
  if (part.shape === 'box') {
    if (part.half) {
      container.appendChild(vec3Row('半尺寸', part.half, SIZE_RANGE, (v) => onChange({ half: v })));
    }
  } else if (part.shape === 'cylinder') {
    container.appendChild(numberRow('半径', part.radius ?? 0.1, [0.005, 1, 0.005], false, (v) => onChange({ radius: v })));
    container.appendChild(numberRow('高度', part.height ?? 0.2, [0.01, 5, 0.01], false, (v) => onChange({ height: v })));
    container.appendChild(numberRow('分段', part.segments ?? 16, [3, 32, 1], true, (v) => onChange({ segments: v })));
    // 弧面截取(弧形曲面装甲):bool 开关 + 起始角/弧长(度)。开 → 弧形曲面;关 → 完整圆柱
    container.appendChild(boolRow('弧面截取', !!part.arc, (v) => onChange({ arc: v ? { start: 0, length: Math.PI } : undefined })));
    if (part.arc) {
      const cur = { ...part.arc };  // 跟踪当前,避免起始角/弧长顺序编辑时闭包旧值覆盖
      container.appendChild(numberRow('起始角(°)', (cur.start * 180) / Math.PI, [0, 360, 1], false, (v) => { cur.start = (v * Math.PI) / 180; onChange({ arc: { ...cur } }); }));
      container.appendChild(numberRow('弧长(°)', (cur.length * 180) / Math.PI, [10, 360, 1], false, (v) => { cur.length = (v * Math.PI) / 180; onChange({ arc: { ...cur } }); }));
    }
  } else if (part.shape === 'wedge' && part.wedge) {
    const w = part.wedge;
    // mode 切换(改 mode 重置 wedge 为该 mode 默认参数,因三 mode 字段集不同)
    const onModeChange = (newMode: 'symmetric' | 'asymmetric' | 'glacis'): void => {
      if (newMode === w.mode) return;
      const fresh =
        newMode === 'glacis'
          ? { mode: 'glacis' as const, halfX: 0.5, halfDepth: 0.5, halfHeight: 0.3 }
          : newMode === 'symmetric'
          ? { mode: 'symmetric' as const, bottomHalfX: 0.5, topHalfX: 0.4, bottomHalfZ: 0.7, topHalfZ: 0.5, height: 0.4, centerY: 0 }
          : { mode: 'asymmetric' as const, bottomHalfX: 0.5, topHalfX: 0.4, bottomHalfZ: 0.7, frontHalfZ: 0.6, backHalfZ: 0.5, height: 0.4, centerY: 0 };
      onChange({ wedge: fresh });
    };
    container.appendChild(selectRow('楔形模式', w.mode, ['symmetric', 'asymmetric', 'glacis'], (v) => onModeChange(v as 'symmetric' | 'asymmetric' | 'glacis')));
    if (w.mode === 'glacis') {
      // cur 跟踪当前值:多字段顺序编辑时,避免闭包 w(初始值)覆盖前序改动(同 vec3Row 跳变 bug)
      const cur = { ...w };
      container.appendChild(numberRow('半宽 X', cur.halfX, SIZE_RANGE, false, (v) => { cur.halfX = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('半深 Z', cur.halfDepth, SIZE_RANGE, false, (v) => { cur.halfDepth = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('半高 Y', cur.halfHeight, SIZE_RANGE, false, (v) => { cur.halfHeight = v; onChange({ wedge: { ...cur } }); }));
    } else if (w.mode === 'asymmetric') {
      // 非对称楔形(炮塔前厚后薄):cur 收窄为 asymmetric,独有 frontHalfZ/backHalfZ 可访问
      const cur = { ...w };
      container.appendChild(numberRow('底宽 X', cur.bottomHalfX, SIZE_RANGE, false, (v) => { cur.bottomHalfX = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('顶宽 X', cur.topHalfX, SIZE_RANGE, false, (v) => { cur.topHalfX = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('底长 Z', cur.bottomHalfZ, SIZE_RANGE, false, (v) => { cur.bottomHalfZ = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('前长 Z', cur.frontHalfZ, SIZE_RANGE, false, (v) => { cur.frontHalfZ = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('后长 Z', cur.backHalfZ, SIZE_RANGE, false, (v) => { cur.backHalfZ = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('全高 Y', cur.height, SIZE_RANGE, false, (v) => { cur.height = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('中心 Y', cur.centerY, VEC3_RANGE, false, (v) => { cur.centerY = v; onChange({ wedge: { ...cur } }); }));
    } else {
      // 对称楔形(车体/炮塔):cur 收窄为 symmetric,独有 topHalfZ 可访问
      const cur = { ...w };
      container.appendChild(numberRow('底宽 X', cur.bottomHalfX, SIZE_RANGE, false, (v) => { cur.bottomHalfX = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('顶宽 X', cur.topHalfX, SIZE_RANGE, false, (v) => { cur.topHalfX = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('底长 Z', cur.bottomHalfZ, SIZE_RANGE, false, (v) => { cur.bottomHalfZ = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('顶长 Z', cur.topHalfZ, SIZE_RANGE, false, (v) => { cur.topHalfZ = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('全高 Y', cur.height, SIZE_RANGE, false, (v) => { cur.height = v; onChange({ wedge: { ...cur } }); }));
      container.appendChild(numberRow('中心 Y', cur.centerY, VEC3_RANGE, false, (v) => { cur.centerY = v; onChange({ wedge: { ...cur } }); }));
    }
  }

  // —— 变换 ——
  container.appendChild(groupTitle('变换'));
  container.appendChild(vec3Row('位置', part.position, VEC3_RANGE, (v) => onChange({ position: v })));
  if (part.rotation) {
    container.appendChild(vec3Row('旋转', part.rotation, [-3.14, 3.14, 0.01], (v) => onChange({ rotation: v })));
  }
  // pivot(仅 main-barrel 显示,炮管根部锚点)
  if (part.role === 'main-barrel' && part.pivot) {
    container.appendChild(vec3Row('根部锚点', part.pivot, VEC3_RANGE, (v) => onChange({ pivot: v })));
  }

  // —— 外观 ——
  container.appendChild(groupTitle('外观'));
  container.appendChild(colorRow('颜色', part.color, (v) => onChange({ color: v })));
  const mkOpts = ['(默认)', ...MATERIAL_KEYS];
  container.appendChild(selectRow('材质键', part.materialKey ?? '(默认)', mkOpts, (v) =>
    onChange({ materialKey: v === '(默认)' ? undefined : (v as MaterialKey) }),
  ));

  // —— 归属(mateTo,高级)——
  container.appendChild(groupTitle('归属'));
  const mateInput = document.createElement('input');
  mateInput.type = 'text';
  mateInput.value = part.mateTo ?? '';
  mateInput.placeholder = '(root 根级)';
  Object.assign(mateInput.style, { flex: '1', background: '#22242a', color: '#e6e6e6', border: '1px solid #3a3c42', borderRadius: '3px', padding: '3px 6px', fontFamily: 'monospace', fontSize: '12px' });
  const mateRow = document.createElement('div');
  mateRow.className = 'prop-row';
  const mateLab = document.createElement('label');
  mateLab.textContent = '挂载到';
  mateRow.appendChild(mateLab);
  mateRow.appendChild(mateInput);
  mateInput.addEventListener('input', () => onChange({ mateTo: mateInput.value || undefined }));
  container.appendChild(mateRow);
}
