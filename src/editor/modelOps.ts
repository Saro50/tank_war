/**
 * editor/modelOps.ts — 编辑器不可变 part 操作(PartList/PartPropPanel 用)
 * ============================================================
 * 所有操作纯函数,返回新 TankModel(不可变,便于回溯/后续接撤销栈)。
 * id 生成基于当前 model.parts(保证不重复,跨加载安全)。
 *
 * 设计:操作不校验 schema(由调用方在落盘前 resolveTankModel + schema 校验),
 *      保持操作层轻量;但维护 role 唯一性(主炮塔/主炮管/左右履带各只能一个)。
 */
import type { TankModel, TankPart, PartRole } from '../data/TankSchema';

/** 生成不重复的 part id(p1/p2/...,跳过已存在的) */
export function genPartId(model: TankModel): string {
  const existing = new Set(model.parts.map((p) => p.id));
  let n = 1;
  while (existing.has(`p${n}`)) n++;
  return `p${n}`;
}

/** 加部件到末尾。id 缺省自动生成;若带 role,先清除同 role 旧 part(role 唯一)。 */
export function addPart(model: TankModel, partial: Omit<TankPart, 'id'> & { id?: string }): { model: TankModel; id: string } {
  const id = partial.id ?? genPartId(model);
  const part: TankPart = { ...partial, id, role: undefined };
  // role 唯一:新 part 带 role 时,移除同 role 旧 part
  if (partial.role) {
    part.role = partial.role;
    const parts = model.parts
      .filter((p) => p.role !== partial.role)
      .concat(part);
    return { model: { ...model, parts }, id };
  }
  return { model: { ...model, parts: [...model.parts, part] }, id };
}

/** 删部件(按 id)。若它是某 part 的 mateTo 目标,子 part 变 root 级(mateTo 清空) */
export function removePart(model: TankModel, id: string): TankModel {
  const parts = model.parts
    .filter((p) => p.id !== id)
    .map((p) => (p.mateTo === id ? { ...p, mateTo: undefined } : p));
  return { ...model, parts };
}

/** 更新部件字段(浅合并 patch)。若 patch 含 role,维护 role 唯一(清除其他 part 同 role) */
export function updatePart(model: TankModel, id: string, patch: Partial<TankPart>): TankModel {
  let parts = model.parts.map((p) => (p.id === id ? { ...p, ...patch } : p));
  // role 唯一:若 patch 含 role,清除其他 part 的同 role
  if (patch.role !== undefined) {
    parts = parts.map((p) => (p.id === id ? p : p.role === patch.role ? { ...p, role: undefined } : p));
  }
  return { ...model, parts };
}

/** 移动部件顺序(dir=-1 上移, +1 下移)。排序影响 PartList 显示 + buildCustom 遍历序 */
export function movePart(model: TankModel, id: string, dir: -1 | 1): TankModel {
  const idx = model.parts.findIndex((p) => p.id === id);
  if (idx < 0) return model;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= model.parts.length) return model;
  const parts = [...model.parts];
  const [moved] = parts.splice(idx, 1);
  parts.splice(newIdx, 0, moved);
  return { ...model, parts };
}

/** 复制部件(新 id + 名后缀"副本" + 位置偏移防重叠)。插在被复制者后面 */
export function duplicatePart(model: TankModel, id: string): { model: TankModel; newId: string } | null {
  const src = model.parts.find((p) => p.id === id);
  if (!src) return null;
  const newId = genPartId(model);
  const copy: TankPart = {
    ...src,
    id: newId,
    name: `${src.name} 副本`,
    position: { ...src.position, x: src.position.x + 0.3 },
    // 副本不继承 role(role 唯一,副本是普通装饰件)
    role: undefined,
    instances: src.instances?.map((off) => ({ ...off })),
  };
  const idx = model.parts.findIndex((p) => p.id === id);
  const parts = [...model.parts];
  parts.splice(idx + 1, 0, copy);
  return { model: { ...model, parts }, newId };
}

/** 查 part */
export function getPart(model: TankModel, id: string): TankPart | undefined {
  return model.parts.find((p) => p.id === id);
}

/** 查某 role 的 part(主炮塔/主炮管/左右履带) */
export function getPartByRole(model: TankModel, role: PartRole): TankPart | undefined {
  return model.parts.find((p) => p.role === role);
}

/** 查询某 role 当前归属的 part id(UI 高亮用) */
export function roleIdOf(model: TankModel, role: PartRole): string | undefined {
  return model.parts.find((p) => p.role === role)?.id;
}
