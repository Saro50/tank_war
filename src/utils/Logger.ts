/**
 * 轻量级日志器
 * ------------------------------------------------------------
 * 作用：所有用户交互（开炮/命中/破坏）与引擎关键节点都经此记录，
 *       便于出问题时回溯用户操作链路。
 *
 * 设计：
 *  - 按模块创建带 tag 的 logger（Logger.create('Tank')），
 *    输出形如 [Tank] message {data}，一眼定位来源。
 *  - 维护一个环形缓冲（最近 500 条），即使关闭控制台也能事后取回。
 *  - 暴露到 window.__tankLog，方便运行时拉取历史。
 *  - 永不静默失败：error 级别务必保留。
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  t: number; // performance.now() 毫秒
  level: LogLevel;
  tag: string;
  msg: string;
  data?: unknown;
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const BUFFER_SIZE = 500;

const buffer: LogEntry[] = [];
let minLevel: LogLevel = 'debug'; // dev 默认全开

function push(entry: LogEntry): void {
  buffer.push(entry);
  if (buffer.length > BUFFER_SIZE) buffer.shift();
}

function emit(level: LogLevel, tag: string, msg: string, data?: unknown): void {
  if (ORDER[level] < ORDER[minLevel]) return;
  const entry: LogEntry = { t: performance.now(), level, tag, msg, data };
  push(entry);

  const fn =
    level === 'error' ? console.error
    : level === 'warn' ? console.warn
    : level === 'debug' ? console.debug
    : console.log;

  const prefix = `%c[${tag}]`;
  const color =
    level === 'error' ? '#e53935'
    : level === 'warn' ? '#fb8c00'
    : level === 'debug' ? '#8e8e8e'
    : '#43a047';
  if (data !== undefined) fn(prefix, `color:${color}`, msg, data);
  else fn(prefix, `color:${color}`, msg);
}

/** 带模块标签的 logger 工厂，模块内只持有一份。 */
export interface ModuleLogger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
}

export const Logger = {
  /** 调整全局最低输出级别 */
  setLevel(level: LogLevel): void {
    minLevel = level;
  },

  /** 创建模块 logger */
  create(tag: string): ModuleLogger {
    return {
      debug: (m, d) => emit('debug', tag, m, d),
      info: (m, d) => emit('info', tag, m, d),
      warn: (m, d) => emit('warn', tag, m, d),
      error: (m, d) => emit('error', tag, m, d),
    };
  },

  /** 取回历史（只读），用于事后排查或上报 */
  getHistory(): readonly LogEntry[] {
    return buffer;
  },
};

// 暴露到全局便于运行时调试取数
if (typeof window !== 'undefined') {
  (window as unknown as { __tankLog?: unknown }).__tankLog = {
    history: () => Logger.getHistory(),
    setLevel: (l: LogLevel) => Logger.setLevel(l),
  };
}
