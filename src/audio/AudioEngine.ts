import { CONFIG } from '../config';
import { Logger } from '../utils/Logger';
import type { SoundId } from './AudioAssets';

const log = Logger.create('AudioEngine');

/** 三维向量(与项目内联风格一致,避免引入 three 依赖) */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** 音轨:决定走哪条 gain 总线(机械音/人声) */
export type AudioTrack = 'sfx' | 'voice';

/**
 * 循环音句柄(SoundSystem 持有,用于停停/调音量/更新位置)
 * ------------------------------------------------------------
 * 引擎循环音(idle/run)需要长期播放 + 动态切换音量(交叉淡变)+ 跟随坦克移动。
 * 本句柄封装 source + gain + 可选 panner,提供 setVolume/setPosition/stop。
 */
export interface LoopHandle {
  /** 原始 source(停止后失效) */
  readonly source: AudioBufferSourceNode;
  /** 停止循环(带淡出,避免咔哒声) */
  stop(fadeSec: number): void;
  /** 调整音量(带淡变时间) */
  setVolume(volume: number, fadeSec: number): void;
  /** 更新声源世界位置(空间化音用;非空间化音调用无效) */
  setPosition(pos: Vec3): void;
}

/**
 * 音频引擎(底层)
 * ============================================================
 * 职责:封装 Web Audio API,提供两类播放原语:
 *  - playOnce  :瞬态一次性音(开炮)
 *  - startLoop :循环音(引擎 idle/run),返回 LoopHandle 供外部控制
 *
 * 音轨分三条总线:
 *  - sfxGain  :机械音(开炮/引擎/行驶),可挂 PannerNode 做空间化距离衰减
 *  - voiceGain:人声语音,直放不空间化(仅玩家自身,无需定位)
 *  - bgmGain  :背景音乐,直放不空间化,全局唯一循环(状态切换换曲)
 * 三者同接 masterGain,统一受 master 音量控制。
 *
 * 监听器(AudioListener):每帧由 setListener 更新位姿(玩家相机),
 * PannerNode 据此做空间化。默认 forward 朝 -z(three 相机约定)。
 *
 * 解锁:浏览器要求用户手势才能 resume。加载阶段 ctx 处于 suspended
 * (decodeAudioData 仍可用),unlock() 在用户点"开始作战"时调用 resume。
 */
export class AudioEngine {
  /** AudioContext 生命周期由本类管理;暴露供 AudioAssets 解码用 */
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly sfxGain: GainNode;
  private readonly voiceGain: GainNode;
  private readonly bgmGain: GainNode;
  /** 当前 BGM 的 source + 音量节点(switchBgm 切换时淡出旧的)。
   *  BGM 全局唯一(同时只播一首),非空间化走 bgmGain 轨。 */
  private bgmSource?: AudioBufferSourceNode;
  private bgmVolGain?: GainNode;
  /** 是否已解锁(ctx 处于 running)。未解锁时播放操作排队/静默 */
  private unlocked = false;
  /** ctx 创建是否失败(无 Web Audio 支持) */
  private readonly disabled: boolean;
  /**
   * 已警告过"buffer 缺失"的 id 集合(去重防刷屏)。
   * ------------------------------------------------------------
   * playOnce(开炮)高频调用,若某音效解码失败每次调用都 warn 会刷屏;
   * 用此 Set 保证每个 id 只警告一次。playBgm 低频亦同(保险)。
   * 遵循"永不静默失败":静默 return 仅指不阻塞游戏,但必须留可追溯日志。
   */
  private readonly warnedMissing = new Set<SoundId>();
  /** pending setTimeout id 集合(dispose 时统一清除,防 teardown 后回调访问已关闭 ctx) */
  private readonly pendingTimeouts = new Set<number>();

  constructor() {
    try {
      const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctx) throw new Error('AudioContext not supported');
      this.ctx = new Ctx();
      this.master = this.ctx.createGain();
      this.sfxGain = this.ctx.createGain();
      this.voiceGain = this.ctx.createGain();
      this.bgmGain = this.ctx.createGain();
      this.sfxGain.connect(this.master);
      this.voiceGain.connect(this.master);
      this.bgmGain.connect(this.master);
      this.master.connect(this.ctx.destination);
      this.applyVolumes();
      this.disabled = false;
    } catch (e) {
      // 无 Web Audio 支持:标记 disabled,所有播放静默降级,不阻塞游戏
      log.error('AudioContext init failed, audio disabled', { err: String(e) });
      this.disabled = true;
      // 占位 ctx(master/sfxGain/voiceGain/bgmGain 用 any 兜底,disabled 后永不访问)
      this.ctx = undefined as unknown as AudioContext;
      this.master = undefined as unknown as GainNode;
      this.sfxGain = undefined as unknown as GainNode;
      this.voiceGain = undefined as unknown as GainNode;
      this.bgmGain = undefined as unknown as GainNode;
    }
  }

  /** 应用 config 音量到各 gain 节点 */
  private applyVolumes(): void {
    if (this.disabled) return;
    this.master.gain.value = CONFIG.audio.master;
    this.sfxGain.gain.value = CONFIG.audio.sfx;
    this.voiceGain.gain.value = CONFIG.audio.voice;
    this.bgmGain.gain.value = CONFIG.audio.bgm;
  }

  /** 用户手势触发:resume ctx。失败记 warn(游戏继续,无声降级) */
  async unlock(): Promise<void> {
    if (this.disabled || this.unlocked) return;
    try {
      await this.ctx.resume();
      this.unlocked = true;
      // 带 ctx.state:确认是否真正 running(某些环境下 resume() resolve 但 state 仍 suspended)
      log.info('audio unlocked', { state: this.ctx.state });
    } catch (e) {
      log.warn('audio unlock failed, playing silent', { err: String(e), state: this.ctx.state });
    }
  }

  /**
   * 播放一次性瞬态音(开炮)。
   * ------------------------------------------------------------
   * @param id      音效 id(buffer 缺失则静默跳过)
   * @param track   音轨:sfx 可空间化,voice 直放
   * @param pos     世界坐标(sfx 时挂 PannerNode 做距离衰减;voice 忽略)
   * @param volume  音量倍率(叠加在 track gain 之上)
   */
  playOnce(id: SoundId, track: AudioTrack, pos?: Vec3, volume = 1): void {
    if (this.disabled) return;
    const buf = this.assets?.get(id);
    if (!buf) {
      // 资源缺失静默跳过(降级,不阻塞游戏),但记 warn 一次以便追溯
      // (开炮等高频调用,去重防刷屏;若 mp3 解码失败这里是定位根因的关键日志)
      if (!this.warnedMissing.has(id)) {
        this.warnedMissing.add(id);
        log.warn('audio buffer missing, playback skipped', { id, track });
      }
      return;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    // route 内部完成 src→gain→(panner?)→trackBus 全链路连接,返回链尾节点
    const tail = this.route(src, gain, track, pos);
    src.start();
    // 播放完自动断开整条链回收(Web Audio source 是一次性的)
    src.onended = (): void => {
      try {
        src.disconnect();
        gain.disconnect();
        tail.disconnect();
      } catch {
        /* 已断开,忽略 */
      }
    };
  }

  /**
   * 启动循环音(引擎 idle/run),返回可控句柄。
   * ------------------------------------------------------------
   * 循环音长期播放,SoundSystem 持有 handle 做交叉淡变/位置更新/停止。
   * 同一辆坦克同时持有 idle + run 两个 handle,通过 setVolume 互斥淡变。
   */
  startLoop(id: SoundId, track: AudioTrack, pos: Vec3, volume = 1): LoopHandle | undefined {
    if (this.disabled) return undefined;
    const buf = this.assets?.get(id);
    if (!buf) {
      // 资源缺失:warn 一次(去重),返回 undefined 让上层跳过此源(避免半套循环源泄漏)
      if (!this.warnedMissing.has(id)) {
        this.warnedMissing.add(id);
        log.warn('audio buffer missing, loop skipped', { id, track });
      }
      return undefined;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const gain = this.ctx.createGain();
    gain.gain.value = volume;
    let panner: PannerNode | undefined;
    const tail = this.route(src, gain, track, pos, (p) => {
      panner = p;
    });
    src.start();
    return {
      source: src,
      stop: (fadeSec): void => {
        // 淡出到 0 再停止,避免咔哒声
        const t = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(0, t + fadeSec);
        // 停止时机:淡变结束后。source.stop 不能重复调用,用标志防多次
        let stopped = false;
        const doStop = (): void => {
          if (stopped) return;
          stopped = true;
          this.pendingTimeouts.delete(id);
          try {
            src.stop(this.ctx.currentTime + 0.02);
            src.disconnect();
            gain.disconnect();
            tail.disconnect();
            panner?.disconnect();
          } catch {
            /* 已停止,忽略 */
          }
        };
        // 用 timeout 触发清理(Web Audio 无 stop 后回调的可靠方式)
        const id = window.setTimeout(doStop, (fadeSec + 0.1) * 1000);
        this.pendingTimeouts.add(id);
      },
      setVolume: (vol, fadeSec): void => {
        const t = this.ctx.currentTime;
        gain.gain.cancelScheduledValues(t);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(vol, t + fadeSec);
      },
      setPosition: (p): void => {
        if (panner) {
          panner.positionX.value = p.x;
          panner.positionY.value = p.y;
          panner.positionZ.value = p.z;
        }
      },
    };
  }

  /**
   * 路由 source → gain → (panner?) → trackBus
   * ------------------------------------------------------------
   * sfx 轨且提供 pos 时,插入 PannerNode 做空间化;否则直连。
   * 内部完成全链路连接(src→gain→panner→trackBus),返回链尾节点(panner 或 gain),
   * 供调用方在 onended/stop 时 disconnect 回收。
   *
   * @param onPanner 创建 PannerNode 后回调(SoundSystem 需持有引用更新位置)
   */
  private route(
    src: AudioNode,
    gain: GainNode,
    track: AudioTrack,
    pos: Vec3 | undefined,
    onPanner?: (p: PannerNode) => void,
  ): AudioNode {
    src.connect(gain);
    const trackBus = track === 'sfx' ? this.sfxGain : this.voiceGain;
    if (track === 'sfx' && pos) {
      // 空间化:创建 PannerNode 并配置距离衰减
      const cfg = CONFIG.audio.spatial;
      const panner = this.ctx.createPanner();
      panner.panningModel = 'equalpower'; // 比 HRTF 轻量,够用
      panner.distanceModel = 'inverse';
      panner.refDistance = cfg.refDistance;
      panner.rolloffFactor = cfg.rolloff;
      panner.maxDistance = cfg.maxDistance;
      panner.positionX.value = pos.x;
      panner.positionY.value = pos.y;
      panner.positionZ.value = pos.z;
      gain.connect(panner);
      panner.connect(trackBus);
      onPanner?.(panner);
      return panner; // 链尾=panner
    }
    // 非空间化:gain 直连 trackBus
    gain.connect(trackBus);
    return gain; // 链尾=gain
  }

  // ============================================================
  // BGM 管理(背景音乐:全局唯一循环,非空间化,独立 bgmGain 轨)
  // ============================================================

  /**
   * 播放 BGM(循环,淡入)。
   * ------------------------------------------------------------
   * 若已有 BGM 在播,先淡出停掉再播新的(等价 switchBgm 语义,实现状态切换换曲)。
   * BGM 非空间化,走 bgmGain 轨。buffer 缺失静默跳过(降级)。
   *
   * @param id      bgm_loading / bgm_in_game
   * @param fadeSec 淡入时长(s);同时用作旧曲淡出
   */
  playBgm(id: SoundId, fadeSec = 0.5): void {
    if (this.disabled) return;
    const buf = this.assets?.get(id);
    if (!buf) {
      // BGM 资源缺失:warn 一次(去重)。这是"BGM 不响"最常见的根因日志,
      // 用户据此可判断是 mp3 解码失败还是路径错误。
      if (!this.warnedMissing.has(id)) {
        this.warnedMissing.add(id);
        log.warn('bgm buffer missing, playback skipped', { id });
      }
      return;
    }
    // 先停当前(淡出):交叉淡变效果——旧曲淡出同时新曲淡入
    if (this.bgmSource) this.stopBgm(fadeSec);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = 0; // 从 0 淡入
    src.connect(g);
    g.connect(this.bgmGain);
    const t = this.ctx.currentTime;
    g.gain.linearRampToValueAtTime(1, t + fadeSec);
    src.start();
    this.bgmSource = src;
    this.bgmVolGain = g;
  }

  /** 停止当前 BGM(淡出)。无 BGM 在播时空操作。 */
  stopBgm(fadeSec = 0.5): void {
    if (this.disabled || !this.bgmSource || !this.bgmVolGain) return;
    const src = this.bgmSource;
    const g = this.bgmVolGain;
    const t = this.ctx.currentTime;
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(g.gain.value, t);
    g.gain.linearRampToValueAtTime(0, t + fadeSec);
    // 淡变结束后真正停止(source.stop 不可重复调用,用标志防护)
    let stopped = false;
    const doStop = (): void => {
      if (stopped) return;
      stopped = true;
      this.pendingTimeouts.delete(id);
      try {
        src.stop();
        src.disconnect();
        g.disconnect();
      } catch {
        /* 已停止,忽略 */
      }
    };
    const id = window.setTimeout(doStop, (fadeSec + 0.1) * 1000);
    this.pendingTimeouts.add(id);
    // 立即清引用(playBgm 可紧接着开播新曲,旧的在 timeout 后自行停止)
    this.bgmSource = undefined;
    this.bgmVolGain = undefined;
  }

  /**
   * 更新监听器位姿(每帧由 SoundSystem 调用)。
   * ------------------------------------------------------------
   * PannerNode 的空间化基于 listener 的位置与朝向。
   * forward/up 用 three 相机约定:forward=-z,up=+y。
   */
  setListener(pos: Vec3, forward: Vec3, up: Vec3): void {
    if (this.disabled) return;
    const l = this.ctx.listener;
    // 老版本 API 用 positionX/orientationX,部分浏览器需 fallback
    if (l.positionX) {
      l.positionX.value = pos.x;
      l.positionY.value = pos.y;
      l.positionZ.value = pos.z;
      l.forwardX.value = forward.x;
      l.forwardY.value = forward.y;
      l.forwardZ.value = forward.z;
      l.upX.value = up.x;
      l.upY.value = up.y;
      l.upZ.value = up.z;
    } else {
      // fallback:旧 API setPosition/setOrientation(已废弃但兼容)
      const old = l as AudioListener & {
        setPosition?(x: number, y: number, z: number): void;
        setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
      };
      old.setPosition?.(pos.x, pos.y, pos.z);
      old.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
    }
  }

  /** 注入 AudioAssets(加载完成后由 main 设置,供播放取 buffer) */
  bindAssets(assets: { get(id: SoundId): AudioBuffer | undefined; has(id: SoundId): boolean }): void {
    this.assets = assets;
  }

  /** 引擎是否可用(disabled 时所有操作静默) */
  get available(): boolean {
    return !this.disabled;
  }

  /** ctx 是否已解锁(running 状态)。SoundSystem 据此决定 BGM 何时播放
   *  (suspended 态 playBgm 会排队,resume 后误响,故解锁前不播)。 */
  get isUnlocked(): boolean {
    return this.unlocked;
  }

  /** 某音效资源是否已加载(转发给 AudioAssets)。SoundSystem 用此判断引擎音
   *  资源是否齐全,缺失则禁用引擎音避免每帧无效创建 source(性能黑洞)。 */
  hasAsset(id: SoundId): boolean {
    return this.assets?.has(id) ?? false;
  }

  /** 销毁:停 BGM + 清除 pending timeout + 关闭 ctx(HMR/卸载时调用,防资源泄漏) */
  dispose(): void {
    if (this.disabled) return;
    this.stopBgm(0);
    for (const id of this.pendingTimeouts) clearTimeout(id);
    this.pendingTimeouts.clear();
    try {
      void this.ctx.close();
    } catch {
      /* ctx 已关闭 */
    }
    log.info('audio engine disposed');
  }

  // assets 引用(bindAssets 注入)
  private assets?: { get(id: SoundId): AudioBuffer | undefined; has(id: SoundId): boolean };
}
