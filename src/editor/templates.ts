/**
 * templates.ts — 新建坦克的起点模板(编辑器用)
 * ============================================================
 * 两种新建起点(对应产品方案"新建流程"):
 *   1. blankTemplate(name):空白模板,5 默认部件(含 4 必备 role),用户从零搭
 *   2. fromOfficial(variant):基于官方车型复制,调 convertXxxFromConfig 生成完整 TankModel
 *
 * 设计:
 *   - blank 的 4 部件必须含齐 role(过 schema 完整性 refine),否则模板自身非法
 *   - blank 的 physics/drive/damage 不填(留 resolveTankModel 兜底),用户编辑时看到 resolve 后的值
 *   - fromOfficial 复用转换器(零回归),用户在官方车上改后"另存为自定义"
 */
import type { TankModel, TankVariant } from '../data/TankSchema';
import {
  convertT14FromConfig,
  convertTigerFromConfig,
  convertAbramsFromConfig,
} from '../data/convertLegacy';

const HALF_PI = Math.PI / 2;

/**
 * 空白模板:5 默认部件(车体 + 炮塔 + 主炮管 + 左右履带)。
 * 4 必备 role 齐全(过 schema refine);尺寸/位置给合理初值,用户可调。
 * physics/drive/damage 不填 → resolveTankModel 兜底(用户在编辑器看到 resolve 后的完整值)。
 */
export function blankTemplate(name: string): TankModel {
  return {
    id: 'custom-blank', // 临时 id,后台 POST 时生成正式 id(custom-<slug>)
    name,
    parts: [
      // 车体(box,接地:底 y=0)。尺寸参考 T-14 车体比例(宽 1.8 / 高 0.8 / 长 3.6)
      {
        id: 'hull', name: '车体', partType: 'hull', shape: 'box',
        half: { x: 0.9, y: 0.4, z: 1.8 },
        position: { x: 0, y: 0.4, z: 0 },
        color: 0x4a5535,
      },
      // 炮塔主体(必备 role='turret-body')。坐车体顶(车体顶 y=0.8 = 炮塔底 1.1-0.3)
      {
        id: 'turret', name: '炮塔', partType: 'turret', shape: 'box',
        half: { x: 0.6, y: 0.3, z: 1.0 },
        position: { x: 0, y: 1.1, z: 0 },
        color: 0x434a30, role: 'turret-body',
      },
      // 主炮管(必备 role='main-barrel',挂 barrel group 随俯仰)。
      // 关键:mateTo='barrel' 的 position 是【相对 turret group 的局部坐标】,非世界坐标!
      // y=0 = 炮塔中心高度(turret group 已在 y=1.1);z=1.15 = 炮管中心(根部 0.4 在炮塔内,沿+z 到炮口 1.9)
      {
        id: 'barrel', name: '主炮管', partType: 'barrel', shape: 'cylinder',
        radius: 0.08, height: 1.5,
        position: { x: 0, y: 0, z: 1.15 },
        rotation: { x: HALF_PI, y: 0, z: 0 },
        color: 0x333333, materialKey: 'barrel', mateTo: 'barrel', role: 'main-barrel',
      },
      // 左履带(必备 role='left-track')。车体外侧(x=-1.0),接地(底 y=-0.15)
      {
        id: 'track-l', name: '左履带', partType: 'track', shape: 'box',
        half: { x: 0.25, y: 0.3, z: 1.8 },
        position: { x: -1.0, y: 0.15, z: 0 },
        color: 0x2a2a23, materialKey: 'trackMetal', role: 'left-track',
      },
      // 右履带(必备 role='right-track')
      {
        id: 'track-r', name: '右履带', partType: 'track', shape: 'box',
        half: { x: 0.25, y: 0.3, z: 1.8 },
        position: { x: 1.0, y: 0.15, z: 0 },
        color: 0x2a2a23, materialKey: 'trackMetal', role: 'right-track',
      },
    ],
    mass: 1500,
    maxHp: 50,
    // 配色板(写实军事风,与 T14 同系)
    materials: {
      hull: 0x4a5535, turret: 0x434a30, trackMetal: 0x2a2a23,
      wheelRubber: 0x1a1a14, wheelHub: 0x3a3a30, barrel: 0x333333,
      mantlet: 0x333333, detail: 0x2a2a23, fender: 0x4a5535,
    },
    camo: { base: 0x4a5535, blobDark: 0x2a3522, blobMid: 0x3a4530, style: 'nato-blotch', wear: 0.25 },
    decal: { number: '00' },
    // physics/drive/damage 留空 → resolveTankModel 兜底(CONFIG + 几何推算)
  };
}

/**
 * 基于官方车型复制:调转换器生成完整 TankModel(含 physics/drive/role,零回归)。
 * 用户在其上修改后"另存为自定义"(后台 POST 生成新 id)。
 * 注意:返回的 id 仍是官方 id(t14/tiger/abrams),保存为自定义时后台会换新 id。
 */
export function fromOfficial(variant: TankVariant): TankModel {
  switch (variant) {
    case 't14': return convertT14FromConfig();
    case 'tiger': return convertTigerFromConfig();
    case 'abrams': return convertAbramsFromConfig();
  }
}
