/**
 * AssemblyEngine.ts —— 装配约束惰性求解引擎 + 延展限制
 * ============================================================
 * 两个职责:
 *  1. 装配约束(Mate):维持子字段相对命名面的初始偏移(惰性求解)
 *  2. 延展限制(ExtensionRule):限制延展字段的最短长度(防穿透/视觉异常)
 *
 * 两者独立,在 editor.onPropChange 中依次调用:
 *  clampExtension(限制输入)→ resolve(维持约束)
 */
import { FACES, num } from './geometryFaces';
import type { Mate } from './assemblyRules';
import type { ExtensionRule } from './extensionAxes';

/** 脱离容差 */
const DEFAULT_TOLERANCE = 0.05;
/** 最大迭代次数(防震荡) */
const MAX_ITER = 10;

export class AssemblyEngine {
  private readonly locked = new Set<string>();
  private readonly offsets = new Map<string, number>();
  private readonly extensionRules: ExtensionRule[];

  constructor(
    private readonly mates: Mate[],
    data: Record<string, unknown>,
    extensionRules: ExtensionRule[] = [],
    private readonly tolerance = DEFAULT_TOLERANCE,
  ) {
    this.extensionRules = extensionRules;
    // 记录每条 mate 的初始偏移(装配基准)
    for (const m of mates) {
      const faceFn = FACES[m.face];
      const pv = faceFn(data);
      const cv = num(data, m.child);
      if (Number.isFinite(pv) && Number.isFinite(cv)) {
        this.offsets.set(m.child, cv - pv);
      }
    }
  }

  /** 惰性求解:维持装配约束(相对偏移)。返回新 data。 */
  resolve<T extends Record<string, unknown>>(data: T): T {
    const result = structuredClone(data) as T;
    let changed = true;
    let iter = 0;
    while (changed && iter < MAX_ITER) {
      changed = false;
      for (const m of this.mates) {
        if (this.locked.has(m.child)) continue;
        const offset = this.offsets.get(m.child);
        if (offset === undefined) continue;
        const faceFn = FACES[m.face];
        const expected = faceFn(result) + offset;
        const current = num(result, m.child);
        if (!Number.isFinite(expected) || !Number.isFinite(current)) continue;
        if (Math.abs(expected - current) > this.tolerance) {
          writePath(result, m.child, expected);
          changed = true;
        }
      }
      iter++;
    }
    return result;
  }

  /**
   * 延展字段最短限制:若字段值 < minLength,clamp 到 minLength(防穿透)。
   * 原地修改 data。在 resolve 前调用(先限制输入,再维持约束)。
   */
  clampExtension(data: Record<string, unknown>, field: string): void {
    const rule = this.extensionRules.find((r) => r.field === field);
    if (!rule?.minLength) return;
    const v = num(data, field);
    if (Number.isFinite(v) && v < rule.minLength) {
      writePath(data, field, rule.minLength);
    }
  }

  /** 查询字段的延展规则(Phase 4 UI 用:显示延展方向箭头) */
  getExtension(field: string): ExtensionRule | undefined {
    return this.extensionRules.find((r) => r.field === field);
  }

  /** 用户手动改了某字段 → 若它是 mate 的 child,锁定 */
  lockOnUserEdit(path: string): void {
    if (this.mates.some((m) => m.child === path)) {
      this.locked.add(path);
    }
  }

  reset(): void {
    this.locked.clear();
  }

  isLocked(childPath: string): boolean {
    return this.locked.has(childPath);
  }

  /** 解锁某字段(恢复约束跟随)。与 lockOnUserEdit 反向,供 UI 点击解锁。 */
  unlock(path: string): void {
    this.locked.delete(path);
  }

  /** 查询某字段是否是约束 child(供 UI 显示约束状态图标) */
  hasConstraint(path: string): boolean {
    return this.mates.some((m) => m.child === path);
  }
}

/** 写入点分路径的数值 */
function writePath(obj: Record<string, unknown>, path: string, value: number): void {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object') {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}
