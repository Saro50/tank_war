import { CONFIG } from '../config';
import { PhysicsWorld } from './PhysicsWorld';
import { TankDataStore } from '../data/TankDataStore';
import { GltfTankAsset } from '../entities/GltfTankAsset';
import { loadHeightmap, type HeightmapData } from './TerrainSystem';
import type { AudioAssets } from '../audio/AudioAssets';
import { Logger } from '../utils/Logger';

const log = Logger.create('AssetLoader');

/** 加载进度回调(供 UI 更新进度条) */
export interface LoadProgress {
  /** 已完成项数 */
  done: number;
  /** 总项数(用于算百分比) */
  total: number;
  /** 当前阶段的文字描述(显示在进度条下方) */
  label: string;
}

/**
 * 加载耗时统计(诊断/优化用)
 */
interface PhaseTiming {
  physics: number;
  data: number;
  audio: number;
  glb: number;
  terrain: number;
}

/**
 * 统一资源加载器
 * ============================================================
 * 职责:把启动时的异步加载(物理引擎 / 坦克数据 / 音效 / glb 模型)统一编排,
 * 提供 done/total 进度回调供加载界面更新进度条。
 *
 * 各加载项相互独立,用 Promise.allSettled 并行执行(谁先完成谁 tick 进度)。
 * 硬依赖(physics/data,以及启用 gltf variant 时的 glb)失败 → 抛出,加载界面
 * 显示"加载失败+重试";软依赖(audio)失败降级静音,不阻塞。
 *
 * 权重设计(总项数):
 *  - 物理引擎:1 项(rapier wasm 初始化)
 *  - 坦克数据:1 项(JSON fetch + zod 校验)
 *  - 音效:每个文件 1 项(5 机械音 + 2 BGM + 4 语音 = 11 项,单语言)
 *  - glb 模型:1 项(仅当 config.tanks 含 variant:'gltf' 时)
 *  - heightmap:1 项(地形高度图,始终加载;缺失回退平面,不阻塞)
 *
 * @param ctx          AudioContext(suspended 态,供音频解码)
 * @param audioAssets  音频资源仓库(loadAll 写入其内部缓存)
 * @param onProgress   进度回调(每完成一项调用)
 * @throws 物理引擎/坦克数据/(启用时)glb 加载失败时抛出(硬依赖)
 */
export async function loadAssets(
  ctx: AudioContext,
  audioAssets: AudioAssets,
  onProgress: (p: LoadProgress) => void,
): Promise<{ physics: PhysicsWorld; heightmap: HeightmapData | null; timing: PhaseTiming }> {
  // 是否启用 glb 玩家坦克(检测 config.tanks 是否有 variant:'gltf')
  const hasGltf = CONFIG.tanks.some((t) => t.variant === 'gltf');
  // 总项数 = 1(physics) + 1(data) + 音频文件数 + (有 glb 时)1 + 1(heightmap)
  // 音频 = 5 机械音(cannon+engine_idle/full+driving_low/high) + 2 BGM + 4 语音(单语言)
  const voiceCount = CONFIG.audio.voiceLang === 'both' ? 8 : 4;
  const total = 1 + 1 + 5 + 2 + voiceCount + (hasGltf ? 1 : 0) + 1;
  let done = 0;
  const tick = (label: string): void => {
    done++;
    onProgress({ done, total, label });
  };

  const timing: PhaseTiming = { physics: 0, data: 0, audio: 0, glb: 0, terrain: 0 };

  // 并行加载;physics/data/glb 是硬依赖(失败抛出),audio 软依赖(内部降级)
  const physicsPromise = (async (): Promise<PhysicsWorld> => {
    const t0 = performance.now();
    const p = await PhysicsWorld.create();
    timing.physics = performance.now() - t0;
    tick('物理引擎');
    return p;
  })();

  const dataPromise = (async (): Promise<void> => {
    const t0 = performance.now();
    await TankDataStore.load();
    timing.data = performance.now() - t0;
    tick('坦克数据');
  })();

  const audioPromise = (async (): Promise<void> => {
    const t0 = performance.now();
    await audioAssets.loadAll(ctx, () => tick('音效资源'));
    timing.audio = performance.now() - t0;
  })();

  // glb 玩家坦克模型(仅启用时加载;GltfTankAsset 单例缓存,GltfTank 构造时 build clone)。
  // 文件名固定 t14.glb(玩家坦克 = T-14;单例只缓存一个 glb)。
  const glbPromise = hasGltf
    ? (async (): Promise<void> => {
        const t0 = performance.now();
        await GltfTankAsset.load(`${import.meta.env.BASE_URL}assets/t14.glb`);
        timing.glb = performance.now() - t0;
        tick('坦克模型');
      })()
    : Promise.resolve();

  // heightmap 地形高度图(始终加载;缺失/失败返回 null,TerrainSystem 回退平面)。
  const heightmapPromise = (async (): Promise<HeightmapData | null> => {
    const t0 = performance.now();
    const hm = await loadHeightmap(`${import.meta.env.BASE_URL}${CONFIG.ground.terrain.heightmap}`);
    timing.terrain = performance.now() - t0;
    tick('地形高度图');
    return hm;
  })();

  // allSettled:audio/heightmap 失败不影响整体(软依赖);physics/data/glb 失败 → 抛出
  const results = await Promise.allSettled([physicsPromise, dataPromise, audioPromise, glbPromise, heightmapPromise]);

  // 检查硬依赖:physics(0)/data(1)/glb(3,仅启用时)任一失败 → 抛出
  if (results[0].status === 'rejected') {
    const err = new Error('物理引擎加载失败: ' + String(results[0].reason));
    log.error('physics load failed', { err: String(results[0].reason) });
    throw err;
  }
  if (results[1].status === 'rejected') {
    const err = new Error('坦克数据加载失败: ' + String(results[1].reason));
    log.error('tank data load failed', { err: String(results[1].reason) });
    throw err;
  }
  // audio(2)失败仅记日志,不抛出(降级静音)
  if (results[2].status === 'rejected') {
    log.warn('audio load failed (degraded, continuing silent)', { err: String(results[2].reason) });
  }
  // glb(3)失败:启用时是硬依赖(GltfTank.build 会抛错),此处明确报错
  if (hasGltf && results[3].status === 'rejected') {
    const err = new Error('坦克模型(glb)加载失败: ' + String(results[3].reason));
    log.error('glb load failed', { err: String(results[3].reason) });
    throw err;
  }
  // heightmap(4)软依赖:失败/缺失返回 null(loadHeightmap 内已处理回退),TerrainSystem 自动平面

  const physics = (results[0] as PromiseFulfilledResult<PhysicsWorld>).value;
  const heightmap = (results[4] as PromiseFulfilledResult<HeightmapData | null>).value ?? null;
  log.info('assets loaded', { ...timing, done, total, hasHeightmap: !!heightmap });
  return { physics, heightmap, timing };
}
