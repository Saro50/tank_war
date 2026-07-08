/**
 * metaShapeRegistry.ts — 元组件类型注册表(META_SHAPES)
 * ============================================================
 * 元组件 = 坦克几何的最基础原子(box/cylinder/wedge),只管"形状",不掺用途/动作/受击/数值。
 * 本注册表是元组件的【唯一扩展点】:每种元组件的类型描述(显示信息 + 参数 schema +
 * 编辑器 UI 配置 + 几何工厂)集中在此。buildCustom(Phase B)和编辑器(Phase D)都从注册表
 * 派生,不写 switch。
 *
 * 分层边界(见 docs & 讨论):
 *  - MetaShape: 只管形状(几何参数),不掺用途/动作/受击/数值
 *  - TankPart:  形状实例 + 空间 + 身份标记(partType/hitTag) + 重复(instances)
 *  - 行为层:    按 partType/hitTag 查 CONFIG 全局规则(动作/受击/数值),不进数据
 *
 * 扩展新元组件(如 sphere)的步骤:
 *  1. TankSchema: PART_SHAPES 加 'sphere' + TankPartSchema 加 sphere 字段 + refine 分支
 *  2. 本文件:    META_SHAPES.sphere = { type, label, icon, userVisible, paramsSchema, paramUI }
 *  3. buildCustom(entities 层): SHAPE_FACTORIES.sphere = (params) => new SphereGeometry(...)
 *  编辑器形状选择器从注册表派生,buildCustom 从 SHAPE_FACTORIES 派生,核心循环不写 switch。
 *
 * 分层边界(重要):
 *  - 本文件(data 层): 纯协议/UI 描述(label/icon/paramsSchema/paramUI),无 three.js 依赖
 *  - 几何工厂(entities 层 buildCustom 的 SHAPE_FACTORIES): 按 type 关联,生成 BufferGeometry
 *  data 层不依赖 entities/three,保持分层方向干净
 */
import { z } from 'zod';
import { pos, intPos, halfBox, WedgeSpecSchema } from './TankSchema';

// ============================================================
// 编辑器参数 UI 配置
// ============================================================

/** 单个参数的编辑器 UI 配置(编辑器动态生成参数表单用)。
 *  key 对应 paramsSchema 的顶层字段名(如 'half'/'radius'/'mode')。 */
export interface ParamUIItem {
  /** 控件类型 */
  control:
    | 'slider'        // 单数值滑块(用 min/max/step)
    | 'input'         // 自由输入(数字/文本)
    | 'color'         // 颜色拾取
    | 'select'        // 下拉枚举(用 options)
    | 'vector'        // 3D 向量(3 个 slider:x/y/z,用 min/max/step)
    | 'corner-radii'; // 8 角圆角专用(Phase B 圆角编辑器,box 专属)
  /** 显示名 */
  label: string;
  /** slider/vector 的范围 */
  min?: number;
  max?: number;
  step?: number;
  /** select 的选项 */
  options?: { value: string; label: string }[];
}

// ============================================================
// 元组件类型描述
// ============================================================

/** 单个元组件类型的协议描述(显示 + 参数契约 + UI 配置)。
 *  纯数据层,不依赖 three.js(几何工厂在 entities 层的 buildCustom 自带,分层边界)。 */
export interface MetaShapeType {
  /** 类型 id(对应 TankPart.shape 值,序列化进 JSON;须与 PART_SHAPES 对齐) */
  type: string;
  /** 编辑器显示名(形状选择器按钮文字) */
  label: string;
  /** 编辑器图标(emoji 或 svg name) */
  icon: string;
  /** 是否在用户形状选择器显示。
   *  true=用户可直接拖拽新建;false=转换内部用(预留,目前3种都 true)。 */
  userVisible: boolean;

  /** 此元组件的参数 schema(zod)。
   *  消费者:
   *  - 编辑器:动态生成参数表单 + 即时校验用户输入
   *  - TankPartSchema:按 shape 的字段与此对应(refine 校验对应字段存在性)
   *  字段名与 TankPart 的 shape 专属字段一致(half/radius/height/wedge...)。
   *  几何工厂(returns BufferGeometry)不在此层,在 entities 层 buildCustom 的
   *  SHAPE_FACTORIES 映射里(按 type 关联),保持 data 层不依赖 three.js。 */
  paramsSchema: z.ZodType;

  /** 参数 UI 配置(按 paramsSchema 顶层字段名索引)。
   *  编辑器按此 + paramsSchema 共同生成参数面板:控件类型/范围用 paramUI,
   *  字段结构/嵌套/校验用 paramsSchema。嵌套字段(如 wedge 的 discriminatedUnion 各 mode
   *  分支)由编辑器按 schema 自动展开(选中 mode 后显示对应字段组)。 */
  paramUI?: Record<string, ParamUIItem>;
}

// ============================================================
// 各元组件参数 schema(复用 TankSchema 原子,DRY)
// ============================================================

/** box 元组件参数:half(半尺寸 xyz)。 */
const BoxShapeParams = z.object({
  half: halfBox,
});

/** cylinder 元组件参数:radius + height + segments(周向分段,越大越圆滑)。 */
const CylinderShapeParams = z.object({
  radius: pos,
  height: pos,
  segments: intPos.optional(),
});

// wedge 元组件参数直接复用 WedgeSpecSchema(discriminatedUnion by mode:
// symmetric/asymmetric/glacis 三子模式,字段各异)

// ============================================================
// META_SHAPES 注册表(唯一扩展点)
// ============================================================

/** 元组件类型注册表。key = type id,须与 TankSchema.PART_SHAPES 完全对齐。
 *  新增元组件在此加一项 + PART_SHAPES 加对应值(见文件头扩展步骤)。 */
export const META_SHAPES: Record<string, MetaShapeType> = {
  box: {
    type: 'box',
    label: '立方体',
    icon: '▢',
    userVisible: true,
    paramsSchema: BoxShapeParams,
    paramUI: {
      half: { control: 'vector', label: '半尺寸', min: 0.05, max: 3, step: 0.05 },
    },
  },

  cylinder: {
    type: 'cylinder',
    label: '圆柱体',
    icon: '◯',
    userVisible: true,
    paramsSchema: CylinderShapeParams,
    paramUI: {
      radius: { control: 'slider', label: '半径', min: 0.01, max: 0.5, step: 0.01 },
      height: { control: 'slider', label: '高度', min: 0.1, max: 3.5, step: 0.05 },
      segments: { control: 'slider', label: '分段', min: 3, max: 32, step: 1 },
    },
  },

  wedge: {
    type: 'wedge',
    label: '楔体',
    icon: '◢',
    userVisible: true,
    paramsSchema: WedgeSpecSchema,
    paramUI: {
      mode: {
        control: 'select',
        label: '楔体模式',
        options: [
          { value: 'symmetric', label: '对称楔形(车体/炮塔)' },
          { value: 'asymmetric', label: '非对称楔形(前厚后薄)' },
          { value: 'glacis', label: '三角楔(车首斜板)' },
        ],
      },
      // 其余参数(symmetric/asymmetric/glacis 各 mode 分支的尺寸字段)由编辑器
      // 按 WedgeSpecSchema 的 discriminatedUnion 自动展开:用户选 mode 后显示对应字段组
    },
  },
};

// ============================================================
// 辅助查询函数(buildCustom / 编辑器用)
// ============================================================

/** 按类型 id 查元组件描述。未知类型返回 undefined(调用方应抛错或回退,永不静默)。 */
export function getMetaShape(type: string): MetaShapeType | undefined {
  return META_SHAPES[type];
}

/** 获取用户可见的元组件列表(编辑器形状选择器派生用)。
 *  返回所有 userVisible=true 的元组件,按注册顺序。 */
export function getUserVisibleMetaShapes(): MetaShapeType[] {
  return Object.values(META_SHAPES).filter((m) => m.userVisible);
}
