import { CONFIG } from '../config';
import { Logger } from '../utils/Logger';

const log = Logger.create('AudioAssets');

/**
 * 音效语义 id
 * ============================================================
 * 全代码用语义 id 引用音效,不关心具体文件名/语言。
 * AudioAssets 内部按 id + voiceLang 映射到实际 wav 文件。
 *
 * 分三类:
 *  - 机械音(开炮/引擎/行驶):所有坦克发声,空间化距离衰减。
 *  - 人声语音(voice_*):仅玩家触发,非空间化直放。
 *  - 背景音乐(bgm_*):状态切换曲目,非空间化,独立音量轨。
 */
export type SoundId =
  // —— 机械音(语言无关) ——
  | 'cannon_fire' // 开炮
  | 'engine_idle' // 发动机怠速(静止/低速)
  | 'engine_full' // 发动机全速(高速)
  | 'driving_low' // 行驶低速
  | 'driving_high' // 行驶高速
  // —— 人声语音(按 voiceLang 加载对应文件) ——
  | 'voice_full_speed'
  | 'voice_spotted_enemy'
  | 'voice_shell_loaded'
  | 'voice_low_ammo'
  // —— 背景音乐 ——
  | 'bgm_loading' // 加载/菜单
  | 'bgm_in_game'; // 作战

/** 人声语音 id 子集(SoundSystem.playVoice 参数类型用) */
export type VoiceId =
  | 'voice_full_speed'
  | 'voice_spotted_enemy'
  | 'voice_shell_loaded'
  | 'voice_low_ammo';

/**
 * 机械音 / BGM 路径(语言无关)。
 * 注意目录:sounds/tank/ 是机械音,sounds/bgm/ 是背景音乐。
 * (历史命名:sounds/voice/ 是人声语音,与"voice=人声"语义一致)
 */
const FIXED_PATHS: Partial<Record<SoundId, string>> = {
  cannon_fire: 'sounds/tank/tank_cannon_fire.wav',
  engine_idle: 'sounds/tank/tank_engine_idle_loop.wav',
  engine_full: 'sounds/tank/tank_engine_full_speed_loop.wav',
  driving_low: 'sounds/tank/tank_driving_low_speed_loop.wav',
  driving_high: 'sounds/tank/tank_driving_high_speed_loop.wav',
  bgm_loading: 'sounds/bgm/loading_bgn.wav',
  bgm_in_game: 'sounds/bgm/in_game.wav',
};

/**
 * 人声语音文件名(按语言)。
 * ------------------------------------------------------------
 * low_ammo 中英编号不一致(zh_01_low_ammo / en_05_low_ammo,美术编号时撞号),
 * 故 per-lang 写死文件名,不用统一模板。其余语音编号中英一致。
 */
const VOICE_FILES: Array<{ id: VoiceId; zh: string; en: string }> = [
  { id: 'voice_full_speed', zh: 'zh_03_full_speed', en: 'en_03_full_speed' },
  { id: 'voice_spotted_enemy', zh: 'zh_04_spotted_enemy', en: 'en_04_spotted_enemy' },
  { id: 'voice_shell_loaded', zh: 'zh_05_shell_loaded', en: 'en_05_shell_loaded' },
  { id: 'voice_low_ammo', zh: 'zh_01_low_ammo', en: 'en_05_low_ammo' },
];

/**
 * 音频资源仓库
 * ============================================================
 * 职责:加载阶段把所有需要的 wav fetch + decodeAudioData 成 AudioBuffer 缓存,
 * 运行时供 AudioEngine 取用。缺失的 id 播放时静默跳过(降级,不阻塞游戏)。
 *
 * 解码时机:decodeAudioData 不需要 AudioContext 处于 running(suspended 即可),
 * 故加载阶段(用户手势前)就能完成解码,进入游戏后播放零延迟。
 */
export class AudioAssets {
  /** 已解码的 AudioBuffer 缓存(按 id) */
  private readonly buffers = new Map<SoundId, AudioBuffer>();
  /** 加载失败的 id 集合(诊断用) */
  private readonly failed = new Set<SoundId>();

  /**
   * 加载所有需要的音效资源。
   * ------------------------------------------------------------
   * 串行 decode(而非并行):文件小、解码快,串行让进度条平滑推进;
   * 并行会瞬间全完成,进度条瞬跳反而体验差。
   *
   * 单个失败不抛出:log.error 记录 + 加入 failed 集合,继续加载其他。
   * 遵循"永不静默失败":失败项汇总到日志;播放侧 has(id) 判定后静默跳过。
   *
   * @param ctx    AudioContext(suspended 态即可解码)
   * @param onItem 每完成一个文件解码后回调(进度推进用)
   */
  async loadAll(ctx: AudioContext, onItem?: () => void): Promise<void> {
    const lang = CONFIG.audio.voiceLang;
    // both 模式语音仍只加载一套(当前"仅玩家触发"用 zh;如需中英同播需扩展 id)
    const useEn = lang === 'en';

    // 1. 机械音 + BGM(固定路径,语言无关)
    for (const idStr of Object.keys(FIXED_PATHS) as SoundId[]) {
      const path = FIXED_PATHS[idStr]!;
      await this.loadOne(ctx, idStr, path);
      onItem?.();
    }
    // 2. 人声语音(按 lang 选文件;low_ammo 编号 per-lang)
    for (const v of VOICE_FILES) {
      const file = useEn ? v.en : v.zh;
      await this.loadOne(ctx, v.id, `sounds/voice/${file}.wav`);
      onItem?.();
    }

    log.info('audio assets loaded', {
      ok: this.buffers.size,
      failed: this.failed.size,
      failedIds: this.failed.size > 0 ? Array.from(this.failed) : undefined,
    });
  }

  /** 加载单个文件:fetch → arrayBuffer → decodeAudioData → 缓存 */
  private async loadOne(ctx: AudioContext, id: SoundId, relPath: string): Promise<void> {
    const url = import.meta.env.BASE_URL + relPath;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arr = await resp.arrayBuffer();
      // decodeAudioData 在 suspended 态可用;成功返回 AudioBuffer
      const buf = await ctx.decodeAudioData(arr);
      this.buffers.set(id, buf);
    } catch (e) {
      // 单个失败:记录但不中断整体加载(降级:该音效静默缺失)
      this.failed.add(id);
      log.error('audio load failed', { id, url, err: String(e) });
    }
  }

  /** 取某音效的解码 buffer;缺失返回 undefined(播放侧静默跳过) */
  get(id: SoundId): AudioBuffer | undefined {
    return this.buffers.get(id);
  }

  /** 某音效是否加载成功(可用) */
  has(id: SoundId): boolean {
    return this.buffers.has(id);
  }
}
