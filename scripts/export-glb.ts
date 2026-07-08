/**
 * export-glb.ts — 预设坦克 → glb 导出(Blender 可编辑)
 * ============================================================
 * 跑: npx tsx scripts/export-glb.ts
 * 输出: glb/<variant>.glb(t14/tiger/abrams)
 *
 * 转换链路:convertLegacy → TankModel → 构建 three.Group(几何+层级+纯色材质) → GLTFExporter → glb
 *  - 几何:复用 makeWedgeGeometry/makeGlacisGeometry/makeWedgeTurretGeometry(纯 BufferGeometry,无 DOM)
 *  - 层级:复用 buildCustom 的 group 结构(车身/履带组/炮塔/炮管),Blender 里可独立选中编辑
 *  - 材质:纯色(materials 色值),迷彩/履带/贴花纹理丢失(Blender 里可重贴)
 */
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { Scene, Group, Mesh, MeshStandardMaterial, Object3D, BufferGeometry, BoxGeometry, CylinderGeometry } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { convertT14FromConfig, convertTigerFromConfig, convertAbramsFromConfig } from '../src/data/convertLegacy';
import { makeWedgeGeometry, makeGlacisGeometry, makeWedgeTurretGeometry } from '../src/entities/TankGeometryFactories';
import type { TankModel, TankPart, MaterialKey, PartType } from '../src/data/TankSchema';

// node 环境无 FileReader,GLTFExporter 的 binary 导出依赖它读最终 Blob。polyfill。
class NodeFileReader {
  result: ArrayBuffer | string | null = null;
  onloadend: (() => void) | null = null;
  readAsArrayBuffer(blob: Blob): void {
    blob.arrayBuffer().then((ab) => { this.result = ab; this.onloadend?.(); });
  }
}
(globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;

/** partType → materialKey 默认映射(与 buildCustom 一致,决定纯色取哪个 materials 色值) */
const PART_TYPE_TO_MATERIAL: Record<PartType, MaterialKey> = {
  hull: 'hull', turret: 'turret', barrel: 'barrel',
  track: 'trackMetal', wheel: 'wheelRubber', decorative: 'detail',
};

/** 按 part.shape 生成几何(纯几何,无 DOM 依赖。不含 arc 弧面——预设坦克不用) */
function makeGeometry(part: TankPart): BufferGeometry {
  if (part.shape === 'box') {
    return new BoxGeometry(part.half!.x * 2, part.half!.y * 2, part.half!.z * 2);
  }
  if (part.shape === 'cylinder') {
    return new CylinderGeometry(part.radius!, part.radius!, part.height!, part.segments ?? 16);
  }
  const w = part.wedge!;
  if (w.mode === 'symmetric') {
    return makeWedgeGeometry({ bottomHalfX: w.bottomHalfX, topHalfX: w.topHalfX, bottomHalfZ: w.bottomHalfZ, topHalfZ: w.topHalfZ, height: w.height, centerY: w.centerY });
  }
  if (w.mode === 'asymmetric') {
    return makeWedgeTurretGeometry({ bottomHalfX: w.bottomHalfX, topHalfX: w.topHalfX, bottomHalfZ: w.bottomHalfZ, frontHalfZ: w.frontHalfZ, backHalfZ: w.backHalfZ, height: w.height, centerY: w.centerY });
  }
  return makeGlacisGeometry(w.halfX, w.halfDepth, w.halfHeight);
}

/**
 * 构建 three.Group(层级 + 纯色材质)。层级复用 buildCustom 逻辑:
 *  动态(t14): group → hullSway(车身) + trackGroup(履带) → turret → barrel
 *  静态(tiger/abrams): group → (root 级全部) → turret → barrel
 */
function buildExportGroup(model: TankModel): Group {
  const group = new Group();
  group.name = model.name;
  const isStatic = model.isStatic ?? false;
  const hullSway = isStatic ? group : new Group();
  const trackGroup = isStatic ? null : new Group();
  if (!isStatic) {
    hullSway.name = '车身';
    trackGroup!.name = '履带组';
    group.add(hullSway, trackGroup!);
  }

  const turret = new Group();
  turret.name = '炮塔';
  const barrel = new Group();
  barrel.name = '炮管组';
  turret.add(barrel);
  hullSway.add(turret);

  const turretBody = model.parts.find((p) => p.role === 'turret-body');
  const barrelAnchor = model.parts.find((p) => p.role === 'main-barrel');

  if (turretBody) turret.position.set(turretBody.position.x, turretBody.position.y, turretBody.position.z);
  const barrelGroupPos = barrelAnchor
    ? (barrelAnchor.pivot ?? { x: barrelAnchor.position.x, y: barrelAnchor.position.y, z: barrelAnchor.position.z - (barrelAnchor.height ?? 0) / 2 })
    : { x: 0, y: 0, z: 0 };
  if (barrelAnchor) barrel.position.set(barrelGroupPos.x, barrelGroupPos.y, barrelGroupPos.z);

  const cm = model.materials;
  for (const part of model.parts) {
    const geo = makeGeometry(part);
    const key = part.materialKey ?? PART_TYPE_TO_MATERIAL[part.partType];
    const color = cm[key];
    const mat = new MeshStandardMaterial({ color, roughness: 0.8, metalness: 0.1 });

    /** 建一个 mesh(name=部件名,Blender 里可识别) */
    const mkMesh = (px: number, py: number, pz: number): Mesh => {
      const m = new Mesh(geo, mat);
      m.name = part.name;
      m.position.set(px, py, pz);
      if (part.rotation) m.rotation.set(part.rotation.x, part.rotation.y, part.rotation.z);
      return m;
    };

    // 分配 parent(同 buildCustom 的 mateTo 逻辑)
    let parent: Object3D;
    if (part === turretBody) parent = turret;
    else if (part.mateTo === 'barrel') parent = barrel;
    else if (part.mateTo === 'turret') parent = turret;
    else if (isStatic) parent = group;
    else parent = part.partType === 'track' || part.partType === 'wheel' ? trackGroup! : hullSway;

    if (part === turretBody) {
      parent.add(mkMesh(0, 0, 0)); // 炮塔主体 mesh 在 turret group 中心
    } else if (part.mateTo === 'barrel') {
      // 反扁平:减 barrelGroupPos(同 buildCustom)
      parent.add(mkMesh(part.position.x - barrelGroupPos.x, part.position.y - barrelGroupPos.y, part.position.z - barrelGroupPos.z));
    } else {
      parent.add(mkMesh(part.position.x, part.position.y, part.position.z));
    }

    // instances(重复件):每个偏移生成独立 mesh(Blender 里各自可编辑)
    if (part.instances) {
      for (const off of part.instances) {
        let bx = part.position.x + off.dx, by = part.position.y + off.dy, bz = part.position.z + off.dz;
        if (part.mateTo === 'barrel') { bx -= barrelGroupPos.x; by -= barrelGroupPos.y; bz -= barrelGroupPos.z; }
        parent.add(mkMesh(bx, by, bz));
      }
    }
  }

  return group;
}

/** 导出单个 TankModel 为 glb */
function exportGlb(model: TankModel, outPath: string): Promise<void> {
  return new Promise((res, rej) => {
    const scene = new Scene();
    scene.add(buildExportGroup(model));
    const exporter = new GLTFExporter();
    exporter.parse(
      scene,
      (result) => {
        if (result instanceof ArrayBuffer) {
          writeFileSync(outPath, Buffer.from(result));
          console.log(`  ✓ ${model.name} → ${outPath} (${(result.byteLength / 1024).toFixed(0)} KB)`);
          res();
        } else {
          rej(new Error('GLTFExporter 返回非 binary'));
        }
      },
      (err) => rej(err),
      { binary: true },
    );
  });
}

async function main(): Promise<void> {
  const outDir = resolve(process.cwd(), 'glb');
  mkdirSync(outDir, { recursive: true });

  const tanks: Array<[string, TankModel]> = [
    ['t14', convertT14FromConfig()],
    ['tiger', convertTigerFromConfig()],
    ['abrams', convertAbramsFromConfig()],
  ];

  console.log(`导出 ${tanks.length} 个预设坦克到 ${outDir}/`);
  for (const [name, model] of tanks) {
    await exportGlb(model, resolve(outDir, `${name}.glb`));
  }
  console.log(`\n完成。Blender File→Open 打开 .glb 编辑。`);
}

main().catch((e) => {
  console.error('导出失败:', e);
  process.exit(1);
});
