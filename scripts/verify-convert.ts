/**
 * verify-convert.ts — Phase A 转换器自检脚本
 * ============================================================
 * 运行:npx tsx scripts/verify-convert.ts
 *
 * 验证 convertLegacy 产出的 TankModel:
 *  1. 通过 TankModelSchema 校验(结构合法)
 *  2. 展开 mesh 数符合期望(与 buildT14/buildTiger/buildAbrams 实际创建的 mesh 数一致)
 *  3. 关键字段/部件断言(零回归核对点)
 *
 * 这是 Phase A "数据模型 + 转换器" 的回归基线。Phase B 实现 buildCustom 后,
 * 可再用渲染对比(转换→buildCustom→截图)做视觉零回归验证。
 */
import {
  convertAbramsFromConfig,
  convertT14FromConfig,
  convertTigerFromConfig,
  describeTankModel,
  expandMeshCount,
} from '../src/data/convertLegacy';
import { TankModelSchema, PART_SHAPES, type TankModel } from '../src/data/TankSchema';
import {
  META_SHAPES,
  getMetaShape,
  getUserVisibleMetaShapes,
} from '../src/data/metaShapeRegistry';

let pass = 0;
let fail = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
    pass++;
  } else {
    console.error(`  ✗ ${name} ${detail}`);
    fail++;
  }
}

const t14 = convertT14FromConfig();
const tiger = convertTigerFromConfig();
const abrams = convertAbramsFromConfig();

const cases: Array<[string, typeof t14, number, string]> = [
  ['T-14', t14, 63, 't14'],
  ['虎式', tiger, 65, 'tiger'],
  ['M1', abrams, 61, 'abrams'],
];

for (const [label, m, expectMesh, expectId] of cases) {
  console.log(`\n=== ${label} ===`);
  // 1. schema 合法性
  const parsed = TankModelSchema.safeParse(m);
  check(
    `${label} TankModel 通过 schema 校验`,
    parsed.success,
    parsed.success ? '' : JSON.stringify(parsed.error.issues, null, 2),
  );
  // 2. mesh 计数
  const cnt = expandMeshCount(m);
  check(`${label} 展开mesh数=${cnt}(期望${expectMesh})`, cnt === expectMesh);
  // 3. id
  check(`${label} id=${m.id}`, m.id === expectId);
  // 4. 部件数 > 0
  check(`${label} parts 非空(${m.parts.length}件)`, m.parts.length > 0);
  // 5. 材质表完整(9 键)
  check(`${label} materials 9 键齐全`, Object.keys(m.materials).length === 9);
  // 6. camo 存在
  check(`${label} camo 存在`, m.camo !== undefined && typeof m.camo.base === 'number');
  // 7. 每个 part 的 mateTo 指向存在的 id(或 root)
  const ids = new Set(m.parts.map((p) => p.id));
  const mateOk = m.parts.every((p) => p.mateTo === undefined || ids.has(p.mateTo));
  check(`${label} 所有 mateTo 指向有效 part`, mateOk);
  // 8. turret part 存在(炮塔级归属锚点)
  check(`${label} 存在 id='turret' 部件`, m.parts.some((p) => p.id === 'turret'));

  console.log(describeTankModel(m));
}

// ===== P1 新字段检查(role/physics/drive,零回归核对)=====
console.log('\n=== P1 新字段(role/physics/drive/smokeOffset) ===');
const requiredRoles = ['turret-body', 'main-barrel', 'left-track', 'right-track'] as const;
for (const [label, m] of [['T-14', t14], ['虎式', tiger], ['M1', abrams]] as const) {
  const roles = new Set(m.parts.map((p) => p.role).filter(Boolean) as string[]);
  check(`${label} 含齐 4 必备 role`, requiredRoles.every((r) => roles.has(r)), `实际: ${[...roles].join(',')}`);
  check(`${label} physics.bodyHalf 存在`, m.physics?.bodyHalf !== undefined && m.physics.bodyHalf.x > 0);
  check(`${label} drive 存在(每车独立手感)`, m.drive !== undefined && m.drive.moveSpeed > 0);
  check(`${label} damage.smokeOffset 存在`, m.damage?.smokeOffset !== undefined);
  check(`${label} 主炮管 id='barrel' 标 role='main-barrel'`, m.parts.some((p) => p.id === 'barrel' && p.role === 'main-barrel'));
  check(`${label} 左履带 role='left-track'`, m.parts.some((p) => p.role === 'left-track'));
  check(`${label} 右履带 role='right-track'`, m.parts.some((p) => p.role === 'right-track'));
}

// ===== T-14 专项(零回归核对)=====
console.log('\n=== T-14 专项 ===');
check('T14 主炮管半径=0.11(历史硬编码)', t14.parts.find((p) => p.id === 'barrel')!.radius === 0.11);
check('T14 afghanit 实例=10(两侧×5)', t14.parts.find((p) => p.id === 'afghanit')!.instances!.length === 10);
check('T14 发动机格栅实例=5', t14.parts.find((p) => p.id === 'engine-grille')!.instances!.length === 5);
check('T14 负重轮实例=7(每侧)', t14.parts.find((p) => p.id === 'road-wheel-l')!.instances!.length === 7);
check('T14 materials.hull=0x4a5535', t14.materials.hull === 0x4a5535);
check('T14 materials.mantlet=0x2e3137(有独立 mantlet 色)', t14.materials.mantlet === 0x2e3137);
check('T14 decal 无黑十字', t14.decal!.cross === undefined);
check('T14 trackTexRepeat=6', t14.trackTexRepeat === 6);
check('T14 decal.number=03', t14.decal!.number === '03');
check('T14 天线存在', t14.parts.some((p) => p.id === 'antenna'));
check('T14 抽烟器存在', t14.parts.some((p) => p.id === 'fume-extractor'));
check('T14 车体 wedge.mode=symmetric', t14.parts.find((p) => p.id === 'hull')!.wedge!.mode === 'symmetric');
check('T14 炮塔 wedge.mode=symmetric', t14.parts.find((p) => p.id === 'turret')!.wedge!.mode === 'symmetric');
check('T14 isStatic 缺省(动态坦克)', t14.isStatic === undefined);
check('T14 mass=1500(真实物理质量)', t14.mass === 1500);
check('T14 physics.bodyHalf={1.3,0.78,2.15}(CONFIG.tank.bodyHalf)', t14.physics?.bodyHalf.x === 1.3 && t14.physics.bodyHalf.y === 0.78 && t14.physics.bodyHalf.z === 2.15);
check('T14 physics 无 colliderOffset(动态,collider 在 body 中心)', t14.physics?.colliderOffset === undefined);
check('T14 physics 无 turretHalf(玩家坦克不炸炮塔)', t14.physics?.turretHalf === undefined);
check('T14 damage.smokeOffset.y=1.2', t14.damage?.smokeOffset?.y === 1.2);
check('T14 damage.regen 存在(玩家脱战回血)', t14.damage?.regenDelay !== undefined && t14.damage?.regenRate !== undefined);

// ===== 虎式专项 =====
console.log('\n=== 虎式专项 ===');
check('虎式 车首斜板(wedge glacis 子模式)存在', tiger.parts.some((p) => p.shape === 'wedge' && p.wedge?.mode === 'glacis'));
check('虎式 交错轮实例=7(count-1)', tiger.parts.find((p) => p.id === 'stagger-wheel-l')!.instances!.length === 7);
check('虎式 负重轮实例=8', tiger.parts.find((p) => p.id === 'road-wheel-l')!.instances!.length === 8);
check('虎式 decal 有黑十字', tiger.decal!.cross === true);
check('虎式 炮塔非对称楔形(wedge.mode=asymmetric)', tiger.parts.find((p) => p.id === 'turret')!.wedge!.mode === 'asymmetric');
check('虎式 主动轮24段(无齿)', tiger.parts.find((p) => p.id === 'sprocket-l')!.segments === 24);
check('虎式 trackTexRepeat=12', tiger.trackTexRepeat === 12);
check('虎式 isStatic=true(静态展示坦克)', tiger.isStatic === true);
check('虎式 mass=30(击毁后附加质量,非真实质量)', tiger.mass === 30);
check('虎式 decal.number=231', tiger.decal!.number === '231');
check('虎式 侧裙板存在', tiger.parts.some((p) => p.id === 'side-skirt-l'));
check('虎式 炮口制退器存在(无抽烟器)', tiger.parts.some((p) => p.id === 'muzzle-brake') && !tiger.parts.some((p) => p.id === 'fume-extractor'));
check('虎式 physics.colliderOffset 存在(静态上移到车体)', tiger.physics?.colliderOffset !== undefined);
check('虎式 physics.turretHalf 存在(击毁炸飞炮塔)', tiger.physics?.turretHalf !== undefined);
check('虎式 damage.smokeOffset.y=1.0', tiger.damage?.smokeOffset?.y === 1.0);
check('虎式 damage 无 regen(静态不回血)', tiger.damage?.regenDelay === undefined);

// ===== M1 专项 =====
console.log('\n=== M1 专项 ===');
check('M1 主动轮带齿(12段)', abrams.parts.find((p) => p.id === 'sprocket-l')!.segments === 12);
check('M1 主动轮半径=halfY×1.12', abrams.parts.find((p) => p.id === 'sprocket-l')!.radius === 0.32 * 1.12);
check('M1 托带轮实例=5', abrams.parts.find((p) => p.id === 'return-roller-l')!.instances!.length === 5);
check('M1 decal 无十字', abrams.decal!.cross === false);
check('M1 热护套存在(无炮口制退器)', abrams.parts.some((p) => p.id === 'thermal-sleeve') && !abrams.parts.some((p) => p.id === 'muzzle-brake'));
check('M1 驾驶舱凸起存在', abrams.parts.some((p) => p.id === 'front-hatch'));
check('M1 机枪站存在', abrams.parts.some((p) => p.id === 'mg-station'));
check('M1 trackTexRepeat=13', abrams.trackTexRepeat === 13);
check('M1 decal.number=A11', abrams.decal!.number === 'A11');
check('M1 车首斜板 wedge.mode=glacis', abrams.parts.find((p) => p.id === 'front-slope')!.wedge!.mode === 'glacis');
check('M1 炮塔 wedge.mode=asymmetric', abrams.parts.find((p) => p.id === 'turret')!.wedge!.mode === 'asymmetric');
check('M1 isStatic=true(静态展示坦克)', abrams.isStatic === true);
check('M1 physics.colliderOffset 存在(静态上移)', abrams.physics?.colliderOffset !== undefined);
check('M1 physics.turretHalf 存在(击毁炸飞)', abrams.physics?.turretHalf !== undefined);
check('M1 damage.smokeOffset.y=1.0', abrams.damage?.smokeOffset?.y === 1.0);
check('M1 damage 无 regen(静态不回血)', abrams.damage?.regenDelay === undefined);

// ===== 元组件注册表自检 =====
console.log('\n=== 元组件注册表 ===');
const metaKeys = Object.keys(META_SHAPES).sort();
const partShapes = [...PART_SHAPES].sort();
check('META_SHAPES keys 与 PART_SHAPES 对齐', JSON.stringify(metaKeys) === JSON.stringify(partShapes), `${JSON.stringify(metaKeys)} vs ${JSON.stringify(partShapes)}`);
check('注册表含 box/cylinder/wedge 三项', metaKeys.length === 3 && ['box', 'cylinder', 'wedge'].every((k) => META_SHAPES[k]));
check('getUserVisibleMetaShapes 返回 3 项(都 userVisible)', getUserVisibleMetaShapes().length === 3);
check('getMetaShape("box") 返回正确类型', getMetaShape('box')?.type === 'box' && getMetaShape('box')?.label === '立方体');
check('getMetaShape("cylinder") 参数 schema 存在', getMetaShape('cylinder')?.paramsSchema !== undefined);
check('getMetaShape("wedge") 复用 WedgeSpecSchema', getMetaShape('wedge')?.paramsSchema !== undefined);
check('getMetaShape("unknown") 返回 undefined(永不静默)', getMetaShape('sphere') === undefined);
check('每项有 label/icon/paramsSchema', ['box', 'cylinder', 'wedge'].every((k) => {
  const m = META_SHAPES[k];
  return m && m.label && m.icon && m.paramsSchema;
}));
check('box paramUI 含 half(vector)', META_SHAPES.box.paramUI?.half?.control === 'vector');
check('cylinder paramUI 含 radius/height/segments(slider)', ['radius', 'height', 'segments'].every((k) => META_SHAPES.cylinder.paramUI?.[k]?.control === 'slider'));
check('wedge paramUI.mode 是 select 含 3 选项', META_SHAPES.wedge.paramUI?.mode?.control === 'select' && META_SHAPES.wedge.paramUI?.mode?.options?.length === 3);
check('registry 纯协议层(无 geometryFactory 字段,工厂在 entities 层)', !('geometryFactory' in META_SHAPES.box));
check('TankPartSchema 支持新 hitTag 字段(可选 string)', t14.parts[0].hitTag === undefined); // 现有3车型未配 hitTag,缺省 undefined

// ===== buildCustom 分配逻辑核对(Phase B 零回归) =====
// buildCustom 依赖 three.js canvas,无法在 node 跑渲染;但其 part→parent 分配逻辑可纯数据核对。
// 此函数镜像 buildCustom 的分配规则,验证每个 part 进对的 bucket + 展开 mesh 数与 expandMeshCount 一致。
console.log('\n=== buildCustom 分配逻辑核对 ===');
type BuildBucket = 'root' | 'hullSway' | 'trackGroup' | 'turret' | 'barrel';
function computeBuildStats(model: TankModel): { stats: Record<BuildBucket, number>; total: number } {
  const isStatic = model.isStatic ?? false;
  const stats: Record<BuildBucket, number> = { root: 0, hullSway: 0, trackGroup: 0, turret: 0, barrel: 0 };
  const turretBody = model.parts.find((p) => p.role === 'turret-body');
  for (const part of model.parts) {
    const n = part.instances?.length ?? 1;
    let bucket: BuildBucket;
    if (part === turretBody) {
      bucket = 'turret';
    } else if (part.mateTo === 'barrel') {
      // 主炮管级:挂 barrel group(随俯仰)
      bucket = 'barrel';
    } else if (part.mateTo === 'turret') {
      // 炮塔级(含机枪管独立)
      bucket = 'turret';
    } else if (isStatic) {
      bucket = 'root';
    } else {
      bucket = part.partType === 'track' || part.partType === 'wheel' ? 'trackGroup' : 'hullSway';
    }
    stats[bucket] += n;
  }
  return { stats, total: stats.root + stats.hullSway + stats.trackGroup + stats.turret + stats.barrel };
}

const t14stats = computeBuildStats(t14);
check('T14 buildCustom 总mesh=63(与 expandMeshCount 一致)', t14stats.total === 63 && t14stats.total === expandMeshCount(t14));
check('T14 hullSway=7(车体级:hull+舱盖+格栅5)', t14stats.stats.hullSway === 7);
check('T14 trackGroup=36(履带轮接地不摇)', t14stats.stats.trackGroup === 36);
check('T14 turret=16(炮塔主体+附件+rcws机枪管)', t14stats.stats.turret === 16);
check('T14 barrel=4(主炮管+炮盾+抽烟器+炮口,挂barrel group随俯仰)', t14stats.stats.barrel === 4);
check('T14 root=0(动态坦克无直挂root)', t14stats.stats.root === 0);

const tigerStats = computeBuildStats(tiger);
check('虎式 buildCustom 总mesh=65', tigerStats.total === 65 && tigerStats.total === expandMeshCount(tiger));
check('虎式 root=58(静态:全部root级直挂group)', tigerStats.stats.root === 58);
check('虎式 turret=4(主体+指挥塔+战斗室+防盾)', tigerStats.stats.turret === 4);
check('虎式 barrel=3(主炮管+炮盾+炮口制退器)', tigerStats.stats.barrel === 3);
check('虎式 hullSway/trackGroup=0(静态不建摇晃group)', tigerStats.stats.hullSway === 0 && tigerStats.stats.trackGroup === 0);

const abramsStats = computeBuildStats(abrams);
check('M1 buildCustom 总mesh=61', abramsStats.total === 61 && abramsStats.total === expandMeshCount(abrams));
check('M1 root=51', abramsStats.stats.root === 51);
check('M1 turret=7(主体+附件+机枪管,mg挂turret独立)', abramsStats.stats.turret === 7);
check('M1 barrel=3(主炮管+炮盾+热护套,挂barrel group)', abramsStats.stats.barrel === 3);

console.log(`\n============================`);
console.log(`结果: ${pass} 通过, ${fail} 失败`);
console.log(`============================`);
process.exit(fail > 0 ? 1 : 0);
