/**
 * 从内置基准数据(tankVisuals/*.ts)导出 JSON 到 public/tanks/。
 * 运行: npx tsx scripts/export-tank-json.ts
 * ------------------------------------------------------------
 * 首次运行或 public/tanks/*.json 缺失时执行,生成与内置数据一致的 JSON 文件,
 * 让 TankDataStore.fetch 走正常路径(而非回退内置 + 日志刷屏)。
 */
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import t14 from '../src/data/tankVisuals/t14';
import tiger from '../src/data/tankVisuals/tiger';
import abrams from '../src/data/tankVisuals/abrams';

const outDir = resolve(import.meta.dirname, '..', 'public', 'tanks');
mkdirSync(outDir, { recursive: true });

const files: [string, unknown][] = [
  ['t14.json', t14],
  ['tiger.json', tiger],
  ['abrams.json', abrams],
];

for (const [name, data] of files) {
  const path = resolve(outDir, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  console.log(`[export] ${name} → ${path}`);
}
console.log('done: 3 JSON files exported to public/tanks/');
