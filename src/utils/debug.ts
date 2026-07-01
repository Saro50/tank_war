import { CONFIG } from '../config';
import { Logger } from './Logger';

const log = Logger.create('Debug');

/**
 * 调试模式开关(单一真相源)
 * ------------------------------------------------------------
 * 解析 URL ?debug 参数覆盖 CONFIG.debug.enabled 默认值,供全局各处查询。
 *
 * 为何独立模块而非各处自解析 URL:
 *  - 单一真相源:main(Tab/日志门控)与 TuningPanel(面板显隐)统一查询 isDebug(),
 *    避免各解析一次出现不一致;URL 解析逻辑集中可测。
 *  - 集中日志:开启时记录来源,便于排查"为何调试生效/未生效"。
 *
 * 上下游影响:main 启动最早调用 initDebugFlag() 一次(必须早于创建任何受调试
 * 影响的模块,如 TuningPanel);其余模块运行期只读 isDebug() 做门控。
 */
let enabled = false;

/**
 * 启动时调用一次:URL ?debug 覆盖 config 默认值。
 * 必须早于受调试影响的模块(TuningPanel 等)创建。
 *  - ?debug=1 → 强制开;?debug=0 → 强制关;缺省 → 用 CONFIG.debug.enabled
 */
export function initDebugFlag(): void {
  enabled = CONFIG.debug.enabled;
  let source = 'config';
  try {
    const v = new URLSearchParams(location.search).get('debug');
    if (v === '1') {
      enabled = true;
      source = 'url';
    } else if (v === '0') {
      enabled = false;
      source = 'url';
    }
  } catch (e) {
    // location 不可用(SSR 等罕见场景),沿用 config 默认值
    log.warn('location unavailable, keep config default', e);
    return;
  }
  log.info('debug flag', { enabled, source });
}

/** 查询调试是否开启(运行期各处门控用) */
export function isDebug(): boolean {
  return enabled;
}
