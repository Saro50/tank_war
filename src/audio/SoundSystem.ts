import { CONFIG } from '../config';
import type { IControllableTank } from '../entities/IControllableTank';
import { Logger } from '../utils/Logger';
import type { AudioEngine, LoopHandle, Vec3 } from './AudioEngine';
import type { VoiceId, SoundId } from './AudioAssets';

const log = Logger.create('SoundSystem');

/**
 * 音效事件钩子(各游戏系统通过此接口上报事件,解耦)
 * ============================================================
 * WeaponSystem/TankController/SkillSystem/DestructionSystem 持有
 * 可选的 SoundHooks 引用,事件发生时调用对应方法。SoundSystem 实现本接口,
 * 内部决定播放什么音效、加什么冷却/边沿过滤。
 *
 * 设计为可选(系统内 sound?: SoundHooks):
 *  - 未注入(音效加载失败/禁用)时,系统静默运行不受影响
 *  - 注入后,系统只在事件点调用一次,不关心播放细节(职责分离)
 */
export interface SoundHooks {
  /** 开火:机械音(炮口位置空间化) */
  onFire(tank: IControllableTank, muzzlePos: Vec3): void;
  /** 命中敌坦:机械音(爆炸位置空间化) + 玩家语音(发现敌人,owner是玩家时) */
  onTankHit(owner: IControllableTank | undefined, victim: IControllableTank, pos: Vec3): void;
  /** boost 技能激活:玩家语音(全速前进) */
  onBoostActivate(tank: IControllableTank): void;
  /** 弹药从不满→满:玩家语音(炮弹装填完毕) */
  onAmmoFilled(tank: IControllableTank): void;
  /** 弹药总量跌破阈值:玩家语音(低弹药警告,WeaponSystem 边沿触发) */
  onLowAmmo(tank: IControllableTank): void;
  /** 坦克被击毁:击毁爆炸音(空间化,位置=坦克本体) + 即时停该坦克引擎循环音 */
  onTankDestroyed(victim: IControllableTank, pos: Vec3): void;
}

/** 引擎速度档(决定 4 个循环源的音量组合) */
type EngineMode = 'static' | 'low' | 'high';

/**
 * 各档位下 4 个循环源的目标音量。
 * 顺序:[engineIdle, engineFull, drivingLow, drivingHigh]
 *  - static(静止)   :仅发动机怠速(停车有发动机声,无行驶声)
 *  - low(低速行驶)  :发动机怠速 + 低速行驶(起步,发动机未拉高转速)
 *  - high(高速)     :发动机全速 + 高速行驶(全速行驶,双层叠加最响)
 */
const ENGINE_VOL: Record<EngineMode, [number, number, number, number]> = {
  static: [1, 0, 0, 0],
  low: [1, 0, 1, 0],
  high: [0, 1, 0, 1],
};

/** 单辆坦克的引擎循环音状态(4 源:发动机 idle/full + 行驶 low/high) */
interface EngineLoop {
  tank: IControllableTank;
  engineIdle: LoopHandle;
  engineFull: LoopHandle;
  drivingLow: LoopHandle;
  drivingHigh: LoopHandle;
  /** 当前档位(变化时才 setVolume,避免每帧无效调用) */
  mode: EngineMode;
}

/** BGM 状态(决定播哪首背景音乐) */
type BgmState = 'loading' | 'battle' | 'none';

/**
 * 音效系统(游戏层)
 * ============================================================
 * 职责:
 *  1. 实现 SoundHooks:把游戏事件翻译成音效播放(含边沿/冷却防刷屏)。
 *  2. 管理引擎循环音:为玩家 + 近距离 NPC 维护 4 源(发动机 idle/full +
 *     行驶 low/high),按速度档交叉淡变;超出范围的 NPC 淡出移除(性能控制)。
 *  3. 每帧更新监听器位姿(跟随玩家相机),使空间化音效定位正确。
 *  4. BGM 状态管理:loading/battle 切换曲目(ctx 解锁后自动播放)。
 *
 * 玩家判断:持有 getPlayer getter(跟随 Tab 切换的活性坦克)。
 *   语音仅 getPlayer() 返回的坦克触发;机械音所有坦克都发。
 *
 * 引擎音性能策略:仅玩家 + 距玩家 < npcPlayRadius 的存活 NPC 播放引擎循环音。
 *   远处 NPC 不播(避免 PannerNode 循环源堆积卡顿),玩家靠近时自然恢复。
 */
export class SoundSystem implements SoundHooks {
  /** 语音冷却计时(按 VoiceId,防同一语音频繁触发) */
  private readonly voiceCooldowns = new Map<VoiceId, number>();
  /** 引擎循环音(按 tankId) */
  private readonly engineLoops = new Map<number, EngineLoop>();
  /** BGM 期望状态(refreshBgm 据此 + ctx 解锁状态决定播放) */
  private bgmState: BgmState = 'none';
  /** 当前正在播的 BGM id(null=无),避免重复 playBgm */
  private currentBgm: SoundId | null = null;
  /** 引擎音 4 源资源是否齐全(懒检查:缺失则禁用引擎音,避免每帧无效创建 source)。
   *  undefined=尚未检查;false=有缺失已禁用;true=齐全可正常用 */
  private engineSoundsReady?: boolean;

  constructor(
    private readonly engine: AudioEngine,
    /** 玩家活性坦克 getter(跟随 Tab 切换),语音仅此坦克触发 */
    private readonly getPlayer: () => IControllableTank,
    /** 所有坦克列表(引擎音遍历用;与 director.allTanks 同一数组,spawn 会自动包含) */
    private readonly allTanks: IControllableTank[],
  ) {
    log.info('sound system ready', { available: engine.available });
  }

  // ============================================================
  // SoundHooks 实现
  // ============================================================

  onFire(_tank: IControllableTank, muzzlePos: Vec3): void {
    // 机械音:开炮(空间化,所有坦克开火都响)。音量 1.5 调大突出开火反馈
    // 注:曾在此触发玩家语音(目标锁定),因开火频繁过于吵闹已移除
    this.engine.playOnce('cannon_fire', 'sfx', muzzlePos, 1.5);
  }

  onTankHit(owner: IControllableTank | undefined, victim: IControllableTank, pos: Vec3): void {
    // 机械音:命中爆炸(空间化)——命中即有爆炸,所有玩家/NPC 命中都响
    this.engine.playOnce('cannon_fire', 'sfx', pos, 0.5); // 复用炮击音作爆炸,音量降
    // 玩家语音:发现敌人(owner 是玩家 + victim 是敌方阵营时)
    if (owner && this.isPlayer(owner) && this.isEnemy(victim)) {
      this.playVoice('voice_spotted_enemy', CONFIG.audio.voiceCooldown.spotted);
    }
  }

  onBoostActivate(tank: IControllableTank): void {
    // 仅玩家语音;NPC boost 不喊
    if (!this.isPlayer(tank)) return;
    this.playVoice('voice_full_speed');
  }

  onAmmoFilled(tank: IControllableTank): void {
    // 仅玩家语音;NPC 补满弹药不喊
    if (!this.isPlayer(tank)) return;
    this.playVoice('voice_shell_loaded');
  }

  onLowAmmo(tank: IControllableTank): void {
    // 仅玩家语音;NPC 低弹药不喊
    if (!this.isPlayer(tank)) return;
    this.playVoice('voice_low_ammo', CONFIG.audio.voiceCooldown.lowAmmo);
  }

  // ============================================================
  // 辅助:玩家判定 / 语音播放(带冷却)
  // ============================================================

  /** 某坦克是否是当前玩家活性坦克 */
  private isPlayer(tank: IControllableTank): boolean {
    return tank === this.getPlayer();
  }

  /** 某坦克是否是敌方阵营。简化判定:非玩家即视为敌方(单人视角下
   *  玩家打到的其他可附身坦克都是敌/中立,符合"发现敌人"语义)。 */
  private isEnemy(tank: IControllableTank): boolean {
    return !this.isPlayer(tank);
  }

  /**
   * 播放人声语音(带冷却防刷屏)。
   * @param id       语音 id
   * @param cooldown 冷却秒(默认 0=无冷却,由技能/开火天然限频)
   */
  private playVoice(id: VoiceId, cooldown = 0): void {
    // 冷却检查:未到期则跳过(防同一语音频繁刷屏)
    if (cooldown > 0) {
      const remain = this.voiceCooldowns.get(id) ?? 0;
      if (remain > 0) return;
      this.voiceCooldowns.set(id, cooldown);
    }
    // voice 轨直放(非空间化):玩家自身指令,无需定位
    this.engine.playOnce(id, 'voice', undefined, 1);
  }

  // ============================================================
  // BGM 状态管理
  // ============================================================

  /**
   * 设置 BGM 期望状态(main 在游戏状态切换时调用)。
   * ------------------------------------------------------------
   * 仅记录期望状态;实际播放由 update/refreshBgm 在 ctx 解锁后执行
   * (加载/菜单阶段 ctx 未解锁,playBgm 不会响;点开始解锁后自动播当前状态)。
   */
  setBgmState(state: BgmState): void {
    if (this.bgmState === state) return;
    this.bgmState = state;
    log.info('bgm state set', { state });
  }

  /** 每帧检查:ctx 已解锁 + 期望 BGM 与当前不一致 → 切换播放 */
  private refreshBgm(): void {
    if (!this.engine.isUnlocked) return; // 未解锁不播(避免 suspended 态排队误响)
    const want: SoundId | null =
      this.bgmState === 'loading' ? 'bgm_loading' : this.bgmState === 'battle' ? 'bgm_in_game' : null;
    if (want !== this.currentBgm) {
      this.currentBgm = want;
      if (want) this.engine.playBgm(want);
      else this.engine.stopBgm();
    }
  }

  // ============================================================
  // 主循环更新(由 main 每帧调用)
  // ============================================================

  /**
   * 每帧更新:推进冷却 + 更新监听器 + 引擎循环音 + BGM 刷新。
   * ------------------------------------------------------------
   * @param dt             帧时间
   * @param listenerForward 监听器朝向(three 约定 -z 前,取相机朝向=屏幕左右对应声道)
   * @param listenerUp     监听器上方向(+y)
   * @param playing        游戏是否在进行(playing 态);非 playing 时停所有引擎循环音
   */
  update(dt: number, listenerForward: Vec3, listenerUp: Vec3, playing: boolean): void {
    if (!this.engine.available) return;

    // 1. 推进语音冷却
    if (this.voiceCooldowns.size > 0) {
      for (const [id, remain] of this.voiceCooldowns) {
        const next = remain - dt;
        if (next <= 0) this.voiceCooldowns.delete(id);
        else this.voiceCooldowns.set(id, next);
      }
    }

    // 2. 更新监听器位姿(空间化音效定位基准)
    //    ------------------------------------------------------------
    //    俯视等距视角下监听器跟随【玩家坦克】而非高高在上的相机:
    //    相机在 22m 高空,炮口到相机 ~29m,会触发 PannerNode inverse 衰减
    //    把玩家自身开炮音压到原来的 ~38%(耳朵离声源太远)。俯视策略游戏的
    //    听觉语义是"声源相对玩家坦克的远近/方向",耳朵应在坦克上:
    //      - 玩家自身开炮(炮口距坦克中心 ~2.5m < refDistance 8)→ 几乎不衰减,响亮;
    //      - NPC 开炮按"NPC→玩家坦克"距离衰减 → 近处威胁响、远处交火轻,符合预期。
    //    朝向仍用相机基准:屏幕左右 = 声道左右(玩家看屏幕判断方位)。
    //    引擎音播放半径中心=玩家坦克(与监听器一致),见 updateEngineLoops。
    const player = this.getPlayer();
    const pt = player.body.translation();
    this.engine.setListener({ x: pt.x, y: pt.y, z: pt.z }, listenerForward, listenerUp);

    // 3. 引擎循环音管理(4 源:发动机 + 行驶);非 playing 时清空(结算/菜单静音)
    this.updateEngineLoops(playing);

    // 4. BGM 刷新(ctx 解锁后按 bgmState 播放)
    this.refreshBgm();
  }

  /**
   * 引擎循环音管理:为玩家 + 近距离 NPC 维护 4 源循环音。
   * ------------------------------------------------------------
   * 流程:
   *  1. 收集本帧需要引擎音的坦克(玩家 + 距玩家<npcPlayRadius 的存活 NPC);
   *  2. 对新进入的:startLoop 4 源,初始音量按当前速度档;
   *  3. 对已存在的:更新 PannerNode 位置 + 档位变化时交叉淡变 4 源音量;
   *  4. 对离开的(死了/远了):stop 淡出移除。
   */
  private updateEngineLoops(playing: boolean): void {
    const cfg = CONFIG.audio.engine;
    // 非 playing(菜单/won/lost):清空所有引擎循环音,保持安静。
    // 玩家被毁→lost、胜利→won 后结算界面不再有引擎轰鸣干扰;菜单也不该有引擎声(仅 BGM)。
    // 统一在入口门控,覆盖玩家+NPC 全部引擎音(onTankDestroyed 在击毁瞬间清单辆,此处清全部)。
    if (!playing) {
      if (this.engineLoops.size > 0) {
        const f = cfg.crossfade;
        for (const [, loop] of this.engineLoops) {
          loop.engineIdle.stop(f);
          loop.engineFull.stop(f);
          loop.drivingLow.stop(f);
          loop.drivingHigh.stop(f);
        }
        this.engineLoops.clear();
      }
      return;
    }
    const radius = cfg.npcPlayRadius;
    const r2 = radius * radius;

    // 引擎音资源可用性懒检查:4 源任一缺失则禁用引擎音(避免每帧无效创建/销毁 source 的性能黑洞)。
    // 缺失时记 warn(永不静默失败),游戏继续只是无引擎循环音。
    if (this.engineSoundsReady === undefined) {
      const required: SoundId[] = ['engine_idle', 'engine_full', 'driving_low', 'driving_high'];
      const missing = required.filter((id) => !this.engine.hasAsset(id));
      this.engineSoundsReady = missing.length === 0;
      if (missing.length > 0) log.warn('engine sounds missing, engine audio disabled', { missing });
    }
    if (!this.engineSoundsReady) return;

    // 本帧需要引擎音的坦克集合(玩家始终需要 + 近距离存活 NPC)
    const wanted = new Set<number>();
    const player = this.getPlayer();
    if (player.state === 'intact') wanted.add(player.id);
    // 半径中心=玩家坦克位置(与监听器一致)。曾用相机位置致投影点偏离玩家 ~22m,
    // 播放范围椭圆变形(部分该播的没播/不该播的播了)。监听器在哪,能听到的范围就以哪为圆心。
    const pp = player.body.translation();
    for (const t of this.allTanks) {
      if (t === player) continue; // 玩家已加
      if (t.state !== 'intact') continue; // 残骸不播引擎音
      const p = t.body.translation();
      const dx = p.x - pp.x;
      const dz = p.z - pp.z;
      if (dx * dx + dz * dz <= r2) wanted.add(t.id);
    }

    // 移除不再需要的(死了/远了):4 源全部淡出
    for (const [tankId, loop] of this.engineLoops) {
      if (!wanted.has(tankId)) {
        const f = cfg.crossfade;
        loop.engineIdle.stop(f);
        loop.engineFull.stop(f);
        loop.drivingLow.stop(f);
        loop.drivingHigh.stop(f);
        this.engineLoops.delete(tankId);
      }
    }

    // 更新/创建需要的
    for (const tankId of wanted) {
      const tank = tankId === player.id ? player : this.allTanks.find((t) => t.id === tankId);
      if (!tank) continue;
      const pos = tank.body.translation();
      const v = tank.body.linvel();
      const speed = Math.hypot(v.x, v.z);
      // 速度档:< minSpeed 静止 | < speedThreshold 低速 | 否则高速
      const mode: EngineMode = speed < cfg.minSpeed ? 'static' : speed < cfg.speedThreshold ? 'low' : 'high';

      let loop = this.engineLoops.get(tankId);
      if (!loop) {
        // 新建 4 源,初始音量按当前档(此档不响的源音量 0 但仍创建,供切换淡变)
        const [ei, ef, dl, dh] = ENGINE_VOL[mode];
        const engineIdle = this.engine.startLoop('engine_idle', 'sfx', pos, ei);
        const engineFull = this.engine.startLoop('engine_full', 'sfx', pos, ef);
        const drivingLow = this.engine.startLoop('driving_low', 'sfx', pos, dl);
        const drivingHigh = this.engine.startLoop('driving_high', 'sfx', pos, dh);
        // 任一资源缺失则放弃这辆(避免半套源泄漏)
        if (!engineIdle || !engineFull || !drivingLow || !drivingHigh) {
          engineIdle?.stop(0.05);
          engineFull?.stop(0.05);
          drivingLow?.stop(0.05);
          drivingHigh?.stop(0.05);
          continue;
        }
        loop = { tank, engineIdle, engineFull, drivingLow, drivingHigh, mode };
        this.engineLoops.set(tankId, loop);
      } else {
        // 已存在:更新 4 源位置(跟随坦克移动)
        loop.engineIdle.setPosition(pos);
        loop.engineFull.setPosition(pos);
        loop.drivingLow.setPosition(pos);
        loop.drivingHigh.setPosition(pos);
        // 档位切换:4 源交叉淡变到新档音量
        if (loop.mode !== mode) {
          loop.mode = mode;
          const [ei, ef, dl, dh] = ENGINE_VOL[mode];
          const cf = cfg.crossfade;
          loop.engineIdle.setVolume(ei, cf);
          loop.engineFull.setVolume(ef, cf);
          loop.drivingLow.setVolume(dl, cf);
          loop.drivingHigh.setVolume(dh, cf);
        }
      }
    }
  }

  /**
   * 坦克被击毁:播放击毁爆炸音 + 即时清理该坦克引擎循环音。
   * ------------------------------------------------------------
   * 由 DestructionSystem 在坦克 HP 归零(state intact→destroyed)时调用,
   * 传击毁位置(坦克本体)用于空间化。一次调用完成两件事:
   *  1. 播 tank_destroy 击毁音(sfx 空间化,音量突出此关键事件);
   *  2. 即时停该坦克引擎循环音(不等 updateEngineLoops 下一帧,避免死亡瞬间残响)。
   * 注:updateEngineLoops 的 playing 门控也会在结算时清全部引擎音,
   *     此方法保证"击毁那一帧"就静音引擎 + 响起击毁音。
   */
  onTankDestroyed(victim: IControllableTank, pos: Vec3): void {
    // 击毁音:空间化在坦克本体,音量 1.8 突出"坦克爆炸"这一关键事件
    this.engine.playOnce('tank_destroy', 'sfx', pos, 1.8);
    // 即时清理该坦克引擎循环音(防死亡瞬间引擎残响叠在击毁音上)
    const loop = this.engineLoops.get(victim.id);
    if (loop) {
      const f = CONFIG.audio.engine.crossfade;
      loop.engineIdle.stop(f);
      loop.engineFull.stop(f);
      loop.drivingLow.stop(f);
      loop.drivingHigh.stop(f);
      this.engineLoops.delete(victim.id);
    }
    log.info('TANK DESTROYED', { tank: victim.displayName });
  }

  /** 场景重置/卸载时清理所有循环音 + BGM(HMR/重开用) */
  dispose(): void {
    for (const [, loop] of this.engineLoops) {
      loop.engineIdle.stop(0.1);
      loop.engineFull.stop(0.1);
      loop.drivingLow.stop(0.1);
      loop.drivingHigh.stop(0.1);
    }
    this.engineLoops.clear();
    this.engine.stopBgm();
    log.debug('sound system disposed');
  }
}
