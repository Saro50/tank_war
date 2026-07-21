/**
 * TankDataStore.ts — 坦克视觉数据的运行时加载与缓存
 * ============================================================
 * 启动时 fetch public/tanks/*.json,用 zod schema 校验后缓存;
 * 之后同步访问(get / getT14 / ...)。
 *
 * 加载优先级(永不静默失败):
 *   1. fetch JSON + schema 校验通过 → 用 JSON(主路径)
 *   2. fetch 失败 或 校验失败 → 回退内置基准(tankVisuals/*.ts 编译进 bundle)+ 告警
 *   3. 内置基准也不合法 → 抛错(严重 bug,数据与 schema 双双失效)
 *
 * 内置基准(tankVisuals/*.ts)的角色:
 *   不再是主数据源(主数据源是 public/tanks/*.json),
 *   降级为"编译期安全网"——保证 JSON 加载失败时游戏仍可启动。
 *
 * 用法(main.ts 启动时):
 *   await TankDataStore.load();   // 必须在创建任何坦克前完成
 *   TankDataStore.getT14();       // load 完成后同步访问
 */
import { TANK_VARIANTS, TankSchemaByVariant, type TankVariant, type TankData, type T14Data, type TigerData, type AbramsData } from './TankSchema';
import { t14 as t14Fallback, tiger as tigerFallback, abrams as abramsFallback } from './tankVisuals';
import { Logger } from '../utils/Logger';

const log = Logger.create('TankDataStore');

/** JSON 在 public/tanks/ 下,运行时由 vite dev server / 部署的静态服务提供 */
const JSON_PATHS: Record<TankVariant, string> = {
  t14: `${import.meta.env.BASE_URL}tanks/t14.json`,
  tiger: `${import.meta.env.BASE_URL}tanks/tiger.json`,
  abrams: `${import.meta.env.BASE_URL}tanks/abrams.json`,
};

/** 内置兜底基准(编译进 bundle,JSON 加载失败时使用) */
const FALLBACK: Record<TankVariant, unknown> = {
  t14: t14Fallback,
  tiger: tigerFallback,
  abrams: abramsFallback,
};

/** 数据缓存(load 完成后填充;初始空对象断言,get 前必须先 load) */
let cache = {} as Record<TankVariant, TankData>;
let loaded = false;
/** 防竞态:load 并发调用时复用同一 Promise(避免两次各自跑一遍 loadOne) */
let loadingPromise: Promise<void> | undefined;

/** fetch 单个车型 JSON(失败抛错,由调用方捕获回退)。10s 超时防网络挂起卡死加载 */
async function fetchJson(variant: TankVariant): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const resp = await fetch(JSON_PATHS[variant], { signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
    // 检测 Vite SPA fallback:不存在的文件返回 index.html(content-type: text/html)
    const ct = resp.headers.get('content-type') ?? '';
    if (!ct.includes('application/json')) {
      throw new Error(`not JSON (got ${ct}), file likely missing — SPA fallback returned HTML`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 加载单个车型:fetch → 校验 → 成功用 JSON,失败回退内置基准。
 * 内置基准也不合法时抛错(永不静默:数据与 schema 双失效是严重 bug)。
 */
async function loadOne(variant: TankVariant): Promise<TankData> {
  const schema = TankSchemaByVariant[variant];
  // 1. 尝试 fetch JSON
  try {
    const json = await fetchJson(variant);
    const parsed = schema.safeParse(json);
    if (parsed.success) {
      log.info('tank json loaded', { variant });
      return parsed.data as TankData;
    }
    // 校验失败:打印具体出错字段(便于定位 JSON 被改坏的位置)
    log.error('tank json invalid, fallback to built-in', {
      variant,
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
  } catch (e) {
    // JSON 文件不存在(SPA fallback 返回 HTML)是预期情况:
    // 内置基准数据是安全网,用 info 降级避免控制台刷屏 error
    log.info('tank json not available, using built-in data', { variant, reason: String(e) });
  }
  // 2. 回退内置基准 + 校验(基准理论上一定合法,因为随源码同步维护)
  const fallbackParsed = schema.safeParse(FALLBACK[variant]);
  if (!fallbackParsed.success) {
    // 3. 兜底也不合法:数据与 schema 双双失效,游戏无法继续,抛错
    throw new Error(
      `[TankDataStore] ${variant} 内置兜底数据也不合法,无法启动: ${
        JSON.stringify(fallbackParsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`))
      }`,
    );
  }
  log.warn('using built-in fallback data', { variant });
  return fallbackParsed.data as TankData;
}

export const TankDataStore = {
  /**
   * 启动时加载全部车型 JSON。重复调用安全(幂等,第二次直接返回)。
   * 永远 resolve(内部失败已回退);只有内置兜底也失效时才 reject。
   */
  async load(): Promise<void> {
    if (loaded) {
      log.warn('load called twice, ignored');
      return;
    }
    // 防竞态:并发调用时复用同一 Promise(避免两次各自跑一遍 loadOne + 写 cache)
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async (): Promise<void> => {
      const entries = await Promise.all(
        TANK_VARIANTS.map(async (v): Promise<[TankVariant, TankData]> => [v, await loadOne(v)]),
      );
      cache = Object.fromEntries(entries) as Record<TankVariant, TankData>;
      loaded = true;
      log.info('all tank data loaded', { variants: [...TANK_VARIANTS] });
    })();
    return loadingPromise;
  },

  /** 同步获取(load 完成后调用)。未 load 完成抛错(防御:避免读到空数据) */
  get(variant: TankVariant): TankData {
    if (!loaded) throw new Error('TankDataStore.load() not completed yet');
    return cache[variant];
  },

  /** 精确类型获取(load 完成后) */
  getT14(): T14Data {
    return this.get('t14') as T14Data;
  },
  getTiger(): TigerData {
    return this.get('tiger') as TigerData;
  },
  getAbrams(): AbramsData {
    return this.get('abrams') as AbramsData;
  },

  /** 是否已完成加载(供 main.ts 做状态检查) */
  get isLoaded(): boolean {
    return loaded;
  },
};
