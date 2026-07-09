import { t14, tiger as tigerVisual, abrams as abramsVisual } from './data/tankVisuals';

/**
 * 弹种标识(联合类型,全代码共用)。
 * ------------------------------------------------------------
 *  ap: 穿甲弹 —— 直击高伤、穿透装甲、对建筑弱、无溅射。打坦克主弹种。
 *  he: 高爆弹 —— AOE 溅射、对建筑强、对装甲弱。清建筑 / 盲区压制。
 * 详见 docs/combat-layer-design.md §2。
 */
export type AmmoType = 'ap' | 'he';

/**
 * NPC 难度档位(rookie 新兵 / regular 老兵 / veteran 精英)。
 * ------------------------------------------------------------
 * 跨 AI(NpcController.profile 决策参数)/ 实体外观(tierVisuals 配色+标识)/
 * director(spawn 分配)共用,故定义在 config 共享层,避免 entities→ai 循环依赖。
 */
export type NpcTier = 'rookie' | 'regular' | 'veteran';

/**
 * 全局参数集中地
 * ============================================================
 * 所有可调的物理 / 游戏参数集中在此，原因：
 *  1. 物理调优时只改一处，避免参数散落各模块难追溯。
 *  2. 后续可统一接入调试 UI 面板动态调节。
 *  3. 不同 milestone 扩展（tank/weapon/destruction）互不干扰。
 *
 * 约定：每个数值都注明物理意义与影响，禁止出现裸数字。
 */

export const CONFIG = {
  /** 物理世界参数 */
  physics: {
    /** 重力加速度 (m/s²)。y 轴向上为正，故为负值 */
    gravity: { x: 0, y: -9.81, z: 0 },
  },

  /** 地面：一个巨大固定刚体，作为碰撞基准面 */
  ground: {
    /** 地面厚板半边长(400×400，地图扩大一倍后的面积) */
    halfSize: { x: 200, y: 0.5, z: 200 },
  },

  /** 主循环：固定步长子步法，保证模拟确定性、抗卡顿 */
  loop: {
    /** 固定物理步长 (秒)。与帧率解耦，结果可复现 */
    fixedTimeStep: 1 / 60,
    /** 单帧最大子步数：卡顿后截断，防止物理爆炸穿透 */
    maxSubSteps: 5,
  },

  /** —— M1 验证用：初始下落方块 ——
   *  目的：肉眼确认引擎跑通 + 同步正确（下落→弹跳→静止、不穿地） */
  testBox: {
    /** 半边长，即边长 1m 的立方体 */
    halfExtent: 0.5,
    /** 弹性系数，0.4 让方块落地有可见弹跳但最终静止 */
    restitution: 0.4,
    /** 多个方块错位下落，顺便验证多方块互相碰撞不穿模 */
    spawnPositions: [
      { x: 0, y: 8, z: 0 },
      { x: 1.6, y: 10, z: 0.4 },
      { x: -1.3, y: 12, z: 0.6 },
    ],
  },

  /** 坦克（M2）—— 梯形车身+履带+键盘控制，所有手感参数集中于此 */
  tank: {
    /** 整体物理碰撞体外框(半尺寸,m)：包络车身+履带 */
    bodyHalf: { x: 1.3, y: 0.78, z: 2.15 }, // T-14 车体更长(7 对负重轮)
    /** 车身质量(kg)；越大越不易被后坐力推动(M3) */
    mass: 1500,

    /** 移动(方向键控制) */
    moveSpeed: 9,
    turnSpeed: 1.6,
    accelLerp: 0.15,
    reverseScale: 0.6,

    /** 梯形车身(视觉):上窄下宽(数据由 data/tankVisuals t14.hull 驱动) */
    hull: t14.hull,

    /** 履带(视觉):左右各一,胶囊形直段+两端圆柱,独立纹理滚动 */
    track: t14.track,

    /** 负重轮(视觉):每侧多排小轮露在履带内侧 */
    roadWheel: t14.roadWheel,

    /** 挡泥板(视觉):履带上方薄板,遮住履带上半圈 */
    fender: t14.fender,

    /** 炮塔(键盘 U/I 控制左右旋转;外形数据由 data/tankVisuals t14.turret 驱动) */
    turret: {
      turnSpeed: 1.3, // rad/s
      /** 旋转惯性：角速度 lerp 系数(越小越迟钝、滑转越久；C 阶段) */
      omegaLerp: 0.12,
      // 视觉部分(offset/armata/afghanit/antenna)从视觉数据合并
      ...t14.turret,
    },

    /** 炮管(键盘 O/P 控制抬起放下;外形数据由 data/tankVisuals t14.barrel 驱动) */
    barrel: {
      pitchRange: { min: -0.32, max: 0.2 }, // rad: [最大下俯, 最大上仰]
      pitchSpeed: 0.9, // rad/s
      // 视觉部分(offset/length/mantlet/fumeExtractor/muzzleDevice)从视觉数据合并
      ...t14.barrel,
    },

    /** 第三人称相机：偏移随车身 yaw 旋转，始终在车尾后方看车头 */
    camera: {
      offset: { x: 0, y: 4.2, z: -9 },
      lookOffset: { x: 0, y: 1.2, z: 6 },
      lerp: 0.12,
    },

    /** 车身悬挂视觉摇晃(C阶段：加减速俯仰 + 转向侧倾；物理刚体仍锁死保稳定) */
    sway: {
      pitchScale: 0.008, // 俯仰幅度(rad / 加速力度) — 调低，启动/刹车不剧烈
      rollScale: 0.014, // 侧倾幅度(rad / 角速度) — 调低，转向不晃
      lerp: 0.08, // 摇晃平滑系数(越小越软)
    },

    /** 移动扬尘(C阶段：履带接地扬起土黄尘雾，按行驶距离生成) */
    dust: {
      minSpeed: 1.5, // 触发最低速度(m/s)，慢速/静止不扬尘
      spawnPerMeter: 4, // 每米生成团数(按行驶距离调制)
      particles: 6, // 每团粒子数
      lifetime: 0.9, // 尘雾寿命(s)
      speed: 1.8, // 粒子初速度(m/s)
      particleRadius: 0.3, // 粒子半径
      color: 0x8a7a52, // 土黄
    },

    /** 车体附件(视觉):发动机舱格栅+驾驶员舱盖 */
    stowage: t14.stowage,

    /**
     * 写实军事风配色板(数据由 data/tankVisuals t14.colors 驱动)
     * 分材质 PBR：漆面哑光 / 金属高反射 / 橡胶全哑光
     */
    colors: t14.colors,

    /** 损坏系统(玩家坦克被击:HP 机制,与静态坦克同名参数语义一致,便于未来统一) */
    damage: {
      /** 最大血量:玩家 T-14 装甲厚,maxHp=60 → 直击命中(hitDamage=35 按距离衰减)
       *  约 2~3 发可毁(略厚于静态虎式 40),体感耐打但不至于无反应。 */
      maxHp: 60,
      /** HP 低于 maxHp × 此比例 → 开始冒烟(受伤状态视觉反馈),同静态坦克 */
      smokeThreshold: 0.6,
      /** 击毁大爆炸尺寸缩放(相对普通炮弹爆炸),同静态坦克 destroyExplosionScale */
      destroyExplosionScale: 4,
      /** 击毁浓烟尺寸缩放(相对受伤小烟),同静态坦克 destroySmokeScale */
      destroySmokeScale: 1.6,
      /** 脱战回血:最后一次受击后多少秒开始回血(1VN 续战力,躲掩体脱战可恢复) */
      regenDelay: 8,
      /** 回血速率(HP/秒),regenDelay 到期后每秒回血量 */
      regenRate: 5,
    },
  },

  /** —— 后续 milestone 占位 ——
   *  destruction:{ ... 破坏冲量阈值、Voronoi 碎片数、碎片淡出时间 }
   */

  /** 武器/开火（M3 + 弹药种类增强）
   *  ------------------------------------------------------------
   *  弹药分两种(详见 docs/combat-layer-design.md §2):
   *   - AP 穿甲弹:直击高伤、穿透装甲、对建筑弱、无溅射 → 走 DestructionSystem.applyDirectHit 直击管线。
   *   - HE 高爆弹:AOE 溅射、对建筑强、对装甲弱        → 走 DestructionSystem.onExplosion(AOE,复用现有)。
   *  两种弹各自独立库存(见 ammo.maxByType),按 1/2 键切换,切换不消耗不冷却。 */
  weapon: {
    /** 各弹种参数(替代原单一 projectile) */
    ammoTypes: {
      /** AP 穿甲弹:精准点杀坦克主弹种 */
      ap: {
        /** 直击伤害倍率(相对基础 hitDamage)——AP 打坦克更强 */
        damageMultiplier: 1.5,
        /** 装甲穿透:方向装甲倍率 ×(1 − 此值),即削弱 20% 装甲加成 */
        armorPenetration: 0.2,
        /** 对建筑/可破坏物伤害倍率——AP 打建筑弱(穿甲不爆) */
        destructibleMultiplier: 0.4,
        /** 弹体物理参数 */
        radius: 0.13,
        mass: 3.5,
        /** 初速度(m/s) */
        muzzleVelocity: 70,
        /** 最长存活(s)，超时销毁防丢失 */
        maxLifetime: 6,
        /** 弹体颜色(暗色,尖头穿甲感) */
        color: 0x1c1e22,
      },
      /** HE 高爆弹:清建筑 / 盲区压制 / 打集群 */
      he: {
        /** 直击伤害倍率——HE 直接命中也不算高(主要靠溅射) */
        damageMultiplier: 0.7,
        /** 爆炸半径倍率(相对基础 explosionRadius)——HE 溅射更大 */
        explosionRadiusMultiplier: 1.6,
        /** 对建筑/可破坏物伤害倍率——HE 清建筑强 */
        destructibleMultiplier: 1.5,
        /** 弹体物理参数 */
        radius: 0.15,
        mass: 2.5,
        /** 初速度(m/s) */
        muzzleVelocity: 60,
        /** 最长存活(s)，超时销毁防丢失 */
        maxLifetime: 6,
        /** 弹体颜色(橄榄色,圆钝高爆感) */
        color: 0x3a4a2a,
      },
    },
    /** 开火冷却(s)：连发最小间隔(不区分弹种) */
    fireCooldown: 0.55,
    /** 后坐力(三层叠加) */
    recoil: {
      /** 车身反向冲量系数(相对炮弹动量 mass*vel) */
      bodyImpulseScale: 0.4,
      /** 炮管后缩距离(m) */
      barrelBack: 0.45,
      /** 炮管回弹每帧系数(0~1) */
      barrelRecoverLerp: 0.18,
      /** 相机震动峰值强度(m) */
      cameraShake: 0.35,
      /** 相机震动衰减每帧系数 */
      cameraShakeDecay: 0.12,
    },
    /** 爆炸(命中特效) */
    explosion: {
      particleCount: 36,
      /** 粒子初速度(m/s) */
      speed: 9,
      /** 持续时间(s) */
      lifetime: 0.55,
      /** 粒子半径 */
      particleRadius: 0.16,
    },
    /** 炮口焰 + 烟雾(C阶段：开火瞬间白黄闪光 + 灰烟扩散) */
    muzzleFlash: {
      flashLife: 0.06, // 闪光寿命(s，极短)
      flashScale: 0.85, // 闪光球初始尺寸
      smokeCount: 8, // 烟雾粒子数
      smokeLife: 0.5, // 烟雾寿命(s)
      smokeSpeed: 3.2, // 烟雾初速度(m/s)
      smokeRadius: 0.16, // 烟雾粒子半径
    },
  },

  /** 弹药补给(M5:炮弹总量限制 + 资源点装填)
   * ------------------------------------------------------------
    * 所有坦克统一:开火消耗弹药,归零禁射;驶入补给点半径内自动持续装填。
    * 逼玩家管理弹药、回补给点,打破"无限倾泻"的单调节奏。
    * 弹药种类增强后:AP/HE 各自独立库存,补给点同时补两种(各自到顶)。 */
  ammo: {
    /** 各弹种上限(玩家/NPC 统一)。AP 18 + HE 12,够一场交战但有上限,鼓励按需选弹。 */
    maxByType: { ap: 18, he: 12 },
    /** 各弹种装填速率(发/秒,同时补)。不能瞬补(防战斗中滥用)。 */
    resupplyRate: { ap: 5, he: 4 },
    /** 补给点装填半径(m):坦克驶入此半径即开始装填。 */
    resupplyRadius: 5,
    /** NPC 当前选弹≤此值时主动前往补给点(留余量防路上无还手之力)。 */
    npcResupplyThreshold: 5,
  },

  /** 战斗层增强参数(部位 debuff / 主动技能,详见 docs/combat-layer-design.md)
   *  ------------------------------------------------------------
   *  集中管理 M2(弱点部位)与 M3(主动技能)的可调参数,与 destruction(基础伤害)解耦。 */
  combat: {
    /** 弱点部位 debuff(临时,到期恢复;用户原则"用结果反馈而非操作限制")
     *  AP 直击命中部位 collider 时注入对应 debuff 到 tank.status(M0 状态层聚合)。 */
    parts: {
      /** 炮塔命中:炮塔转速 ×0.4 持续 8s(对手准星跟不上,玩家绕侧窗口) */
      turret: { scale: 0.4, duration: 8 },
      /** 履带命中:机动(移动+转向)×0.5 持续 8s(大幅减速但仍可缓慢机动,给玩家 retreat/找掩体/去补给的空间) */
      track: { scale: 0.5, duration: 8 },
    },

    /** 主动技能(M3):玩家始终拥有;veteran NPC 也拥有(rookie/regular 无,平衡性)。
     *  激活时给 tank.status 注入对应 effect(M0 状态层统一聚合)。
     *  三个技能覆盖 续航/机动/防御 三维,玩家须选此刻最缺的——这才是"选择"。 */
    skills: {
      /** 应急维修:站桩 3s 回 30HP。战斗中乱用=送死(站桩期间被集火),残血脱战翻盘用。
       *  施法期间速度超 castMaxSpeed 则中断(防移动滥用,已回血保留)。 */
      repair: {
        cooldown: 20,
        duration: 3,
        healTotal: 30,
        /** 施法最大速度(m/s):超此视为移动中断维修 */
        castMaxSpeed: 1.5,
      },
      /** 引擎过载:4s 内机动 ×1.5/×1.3。冲锋/抢点/逃命。 */
      boost: { cooldown: 15, duration: 4, moveScale: 1.5, turnScale: 1.3 },
      /** 装甲倾斜:5s 内受击伤害 ×0.6(damageReduction)。顶上去硬换的关键窗口。 */
      armor: { cooldown: 18, duration: 5, damageReduction: 0.6 },
    },

    /** veteran NPC 技能决策参数(M3):rookie/regular 不持有技能,仅 veteran 按 these 规则触发。
     *  NPC 复用玩家 SkillSystem 接口(每辆 NPC 独立实例,独立冷却)。 */
    npcSkill: {
      /** 维修触发血量比:HP 低于此且脱战(无视线/远)才修,避免战斗中送死 */
      repairHpRatio: 0.4,
      /** 装甲倾斜触发血量比:HP 低于此且正交战时硬换 */
      armorHpRatio: 0.6,
      /** 引擎过载触发距离比(相对 fireRange):目标远需逼近冲锋,或残血逃跑 */
      boostDistRatio: 1.2,
    },

    /** NPC 难度外观映射(配色 + 军衔标识,让玩家一眼识别敌方难度)。
     *  ------------------------------------------------------------
     *  远距离靠配色(黑色剪影=精英),近距离靠炮塔后部军衔贴花。
     *  - rookie:  原配色不动(量产动员兵感)
     *  - regular: 原色 darken + 磨损加重(暗沉老兵感)+ 双道 V 杠
     *  - veteran: 黑灰系覆盖 + 高磨损(肃杀精锐感,远距离黑色剪影醒目)+ 暗红骷髅
     *  darken/wearBoost 基于"原配色"派生(tiger 灰绿、abrams 沙黄各自加深);
     *  camoOverride 用绝对值覆盖(veteran 两车型统一变黑,强化"精英=黑色"心智)。 */
    tierVisuals: {
      /** 新兵:原配色,无标识 */
      rookie: {},
      /** 老兵:原色整体变暗 + 重磨损,炮塔橙金双道 V 杠 */
      regular: {
        /** 原色整体变暗系数(×0.72),模拟老旧/战损车 */
        darken: 0.72,
        /** 磨损叠加(原 wear + 此值,clamp 1),加重做旧 */
        wearBoost: 0.15,
        /** 军衔标识:双道 V 杠(士官) */
        rank: 'chevron',
        /** 标识颜色(橙金) */
        rankColor: 0xd8a23a,
      },
      /** 精英:黑灰系绝对覆盖 + 暗红骷髅,两车型统一变黑 */
      veteran: {
        /** 黑灰系绝对覆盖(tiger/abrams 都变黑) */
        camoOverride: {
          base: 0x2a2a2a, // 深灰主色
          blobDark: 0x141414, // 近黑斑块
          blobMid: 0x4a4a4a, // 中灰斑块
          wear: 0.7, // 高磨损(肃杀)
        },
        /** 军衔标识:骷髅(特种精锐/死神头) */
        rank: 'skull',
        /** 标识颜色(暗红,危险信号) */
        rankColor: 0xc0392b,
      },
    },
  },

  /** 破坏系统（M4） */
  destruction: {
    /** Voronoi 种子数(≈碎片数) */
    seedCount: 10,
    /** 爆炸破坏半径(m)，半径内完整物/砖块被波及 */
    explosionRadius: 4.0,
    /** 碎片爆炸冲量(从爆心向外) */
    fragmentImpulse: 5,
    /** 碎片总寿命(s) */
    fragmentLifetime: 6,
    /** 开始淡出的时间(s，之前保持不透明) */
    fragmentFadeStart: 3.5,
    /** 砖墙房子：砖块独立堆叠，爆炸后坍塌 */
    brick: {
      /** 单砖尺寸(m)：长x 高y 厚z */
      size: { x: 0.8, y: 0.4, z: 0.4 },
      /** 砖块密度(越大越重越不飘) */
      density: 6,
    /** 砖块爆炸冲量(按距离衰减) */
    impulse: 5,
  },
  /** 直接命中伤害(按距离衰减)：箱子 hp=1 一击碎，塔楼 hp=100 需多击 */
  hitDamage: 35,
  /** 装甲方向性伤害(所有坦克生效):侧/背命中伤害更高,鼓励绕侧偷袭。
   *  按爆心相对坦克朝向的点积判定:dot>cosThreshold 为正面(×1),<-cosThreshold 为背面,中间为侧面。 */
  armor: {
    sideMultiplier: 1.5, // 侧面命中伤害倍率(绕侧奖励)
    backMultiplier: 2.0, // 背面命中伤害倍率(绕背奖励更高)
    cosThreshold: 0.5, // 前/后判定阈值(cos60°)
  },
  /** 水泥塔楼(弹坑式渐进破坏：每炮在弹着点表面崩落一小片碎渣，累积过多倒塌) */
  tower: {
    /** 三轴切块数(总块数 = gridX×gridY×gridZ)；块越小 → 弹坑越细腻、越不像砖头飞溅 */
    gridX: 3,
    gridY: 9,
    gridZ: 3,
    /** 弹坑半径(m)：仅命中点表面附近碎裂崩落形成凹陷弹坑(远小于塔宽 1.8，避免整层脱落) */
    hitRadius: 1.1,
    /** 块损比例超此阈值 → 剩余整体坍塌 */
    collapseRatio: 0.45,
    /** 塔身块密度(水泥，重 → 碎渣掉得快不飘) */
    density: 6,
    /** 弹坑碎块冲量(塌落式：远小于砖块 impulse=5，碎渣只散落不飞溅) */
    hitImpulse: 2.2,
    /** 整体坍塌冲量(建筑倒塌感：外散+下沉，非爆炸式向上爆) */
    collapseImpulse: 3.5,
  },
  /** 树(可被炮弹击倒，村庄情景用) */
  tree: {
    trunkRadius: 0.18, // 树干半径
    trunkHeight: 2.4, // 树干高
    crownRadius: 1.2, // 树冠底半径
    crownHeight: 2.6, // 树冠高
    density: 1.2, // 树干密度(倒下有重量感)
    fallImpulse: 7, // 被击中倒下冲量(水平推 + 上抬)
    hitRadius: 3.0, // 爆炸波及半径
  },
  /** 栅栏立柱(可被坦克推倒) */
  fence: {
    postHeight: 1.1, // 立柱高
    postRadius: 0.06, // 立柱半径
    density: 0.8, // 木质(轻)
    knockImpulse: 4, // 被撞倒下冲量
    hitRadius: 2.0, // 爆炸波及半径(被炮弹/撞击震倒)
  },
  /** 房屋人字屋顶(南方农家风：陡坡排水 + 屋檐外延遮雨) */
  house: {
    roofHeightRatio: 0.6, // 脊高/房屋宽(偏大坡度，利雨水快速滑落)
    eave: 0.7, // 屋檐外延(超出墙体一截，四面挑出遮雨遮阳)
    tileDensity: 2, // 瓦块密度
  },
  },

  /** 静态展示坦克(可破坏目标：HP 归零被炸翻) */
  staticTank: {
    /** 被击毁时受爆心方向的爆炸冲量(把坦克掀翻/炸飞)。
     *  注:碰撞体已设密度(density=2),击毁后总质量≈collider质量(73)+附加质量(30)≈103,
     *  较早期"无密度+附加30"的 30kg 重约 3.4 倍,故冲量同步放大约 3.4 倍以保持原飞翻手感。 */
    destroyImpulse: 95,
    /** 击毁转 dynamic 后的"附加"质量(kg):叠加在碰撞体密度算出的质量之上微调手感。
     *  (碰撞体已设密度,保证转 dynamic 时质量>0;此值仅作附加,不再承担"补质量防 0"职责) */
    destroyedMass: 30,
    /** HP 低于 maxHp × 此比例 → 开始冒烟(受伤状态视觉反馈) */
    smokeThreshold: 0.6,
    /** 击毁时飞溅的碎片数 */
    fragmentCount: 6,
    /** 击毁大爆炸的尺寸缩放(相对普通炮弹爆炸):4=粒子数×4、粒子更大、持续更久,猛烈震撼 */
    destroyExplosionScale: 4,
    /** 击毁浓烟的尺寸缩放(相对受伤小烟):1.6=烟更浓更密更持久,挡住视线后再散去露出焦黑车体 */
    destroySmokeScale: 1.6,
    /** 德国虎式坦克(外形数据由 data/tankVisuals tiger 驱动) */
    tiger: {
      ...tigerVisual,
      maxHp: 40, // 重装甲但游戏化:3~4 发可毁(原 200 太高体感无反应)
      /** 调试附身模式用的运行参数(履带位置/相机偏移适配更大车身) */
      debugDrive: {
        trackOffsetX: 1.18,
        trackHalfZ: 2.4,
        cameraOffset: { x: 0, y: 5.2, z: -11 },
        cameraLookOffset: { x: 0, y: 1.6, z: 7 },
      },
    },
    /** M1 艾布拉姆斯(外形数据由 data/tankVisuals abrams 驱动) */
    abrams: {
      ...abramsVisual,
      maxHp: 30, // 贫铀复合装甲但游戏化:2~3 发可毁(原 160 太高体感无反应)
      /** 调试附身模式用的运行参数(履带位置/相机偏移适配更大车身) */
      debugDrive: {
        trackOffsetX: 1.35,
        trackHalfZ: 2.6,
        cameraOffset: { x: 0, y: 5.5, z: -12 },
        cameraLookOffset: { x: 0, y: 1.7, z: 7 },
      },
    },
  },

  /** 调试模式总开关
   * ------------------------------------------------------------
   * 默认 false(发布纯净);URL 带 ?debug=1 时由 utils/debug.ts 运行时覆盖为 true。
   *  开启:Tab 可在所有坦克间切换 + 调参面板显示 + 周期诊断日志输出。
   *  关闭:仅初始玩家坦克(player:true)可操控,其余坦克只作可破坏静态目标存在。
   * 用 config 默认值而非硬编码,便于将来整体改为 URL-only 或环境变量。 */
  debug: {
    enabled: false,
  },

  /** 场景坦克列表(列表精确配置)
   * ------------------------------------------------------------
   * main 启动时遍历此表生成全部坦克。增减/改型号/改位置只改此数组,不动代码。
   *  - variant: 't14'(玩家型,dynamic 可驾驶) | 'tiger'/'abrams'(静态型,fixed 可附身)
   *  - spawn:   出生位置; y 为【地面高度】(非车身中心),main 按 variant 自行抬高
   *  - yaw:     朝向弧度(绕 y;0=面向 +z,炮管指 +z)
   *  - player:  true = 玩家初始附身载具(应恰好一辆;缺失取首辆并警告,多辆取首辆标记的)
   *  - team:    'player'(玩家阵营) | 'enemy'(敌对,NPC目标) | 缺省=中立靶子(NPC不主动攻)
   *  - npc:     true = 由 NpcController 驱动(机械AI);DirectorSystem 接管 possess+巡逻
   */
  tanks: [
    // 地图扩大一倍,所有坦克出生坐标 ×2,拉开战场纵深
    // 玩家 T-14 坦克。
    // variant 'gltf' → GltfTank(外部 glb 美术资产,assets/t14.glb,精细模型);
    // 切回程序化构建:variant 改 't14'(TankVisualBuilder.buildCustom,数据驱动)。
    { variant: 'gltf', spawn: { x: 0, y: 0, z: -16 }, yaw: 0, player: true, team: 'player' },
    // 静态展示坦克(可破坏靶子,team:neutral=NPC 不主动攻击)
    { variant: 'tiger', spawn: { x: -16, y: 0, z: -60 }, yaw: 0, player: false, team: 'neutral' },
    { variant: 'abrams', spawn: { x: 16, y: 0, z: -60 }, yaw: 0, player: false, team: 'neutral' },
    { variant: 'tiger', spawn: { x: -16, y: 0, z: 60 }, yaw: 0, player: false, team: 'neutral' },
    { variant: 'abrams', spawn: { x: 16, y: 0, z: 60 }, yaw: 0, player: false, team: 'neutral' },
    // NPC 敌坦(team:enemy + npc:true)。DirectorSystem 启动时接管,轮询分配巡逻区域。
    // 多辆分布东/西/北三个生成点(enemyFaction.spawnPoints),对应 east/north/south 巡逻区,避免挤一起
    { variant: 'tiger', spawn: { x: 50, y: 0, z: 0 }, yaw: 0, player: false, team: 'enemy', npc: true, tier: 'rookie' },
    { variant: 'abrams', spawn: { x: -50, y: 0, z: 10 }, yaw: 0, player: false, team: 'enemy', npc: true, tier: 'regular' },
    { variant: 'tiger', spawn: { x: 0, y: 0, z: 56 }, yaw: 0, player: false, team: 'enemy', npc: true, tier: 'veteran' },
  ],

  /** NPC 机械AI参数(L3反射层 + FSM 用)。确定性,无 LLM */
  npc: {
    sightRange: 65, // 感知半径(m),地图扩大一倍后适度提升(不满倍,留战术纵深)
    fireRange: 50, // 开火射程(同上,玩家可利用多出的距离绕侧/找掩体)
    aimTolerance: 0.06, // 瞄准收敛阈值(rad),炮塔朝向误差小于此→可开火
    retreatHpRatio: 0.25, // 血量低于此比例→RETREAT
    retreatMaxTime: 8, // retreat 持续超此秒数→强制脱离回 PATROL(无回血机制,避免无限后退)
    scanInterval: 0.2, // 感知扫描频率(秒,不必每帧扫)
    loseTargetTime: 3, // 目标脱离视野多久算"丢失"(秒,回到 PATROL)
    avoidanceRange: 10, // 前向避障射线安全距离(m);9m/s 车速需更长反应距离,避免高速转向撞障
    avoidanceAngle: 0.7, // 前向扇形半角(rad,≈40°);加宽以更早发现侧前障碍
  },

  /** NPC 难度梯度(差异化参数)
   * ------------------------------------------------------------
   * 与 npc(通用参数)分离:本表只放"随难度变化"的字段,按实例注入 NpcController。
   *  - aimTime:     瞄准锁定秒。锁定后炮塔+炮管持续收敛达此秒数才允许开火。
   *                 弱 NPC 蓄瞄久 → 给玩家反应/走位窗口。本需求的核心旋钮。
   *  - aimTolerance:水平瞄准收敛阈值(rad),越小要求越准。
   *  - aimNoise:    水平瞄准散布(rad,慢速随机游走),产生命中率梯度。
   *  - reactionTime:发现目标后"反应过来"才开始蓄瞄的延迟(s)。
   *  - fireRange/sightRange:射程/感知,按档位递增。
   * 三档递进:新兵(慢/散)→老兵(中)→精英(快/准)。 */
  npcTiers: {
    rookie:  { name: '新兵', aimTime: 2.5, aimTolerance: 0.12, aimNoise: 0.06,  reactionTime: 0.8,  fireRange: 45, sightRange: 60 },
    regular: { name: '老兵', aimTime: 1.4, aimTolerance: 0.08, aimNoise: 0.035, reactionTime: 0.45, fireRange: 50, sightRange: 65 },
    veteran: { name: '精英', aimTime: 0.7, aimTolerance: 0.05, aimNoise: 0.018, reactionTime: 0.25, fireRange: 55, sightRange: 70 },
  },

  /** 敌方阵营资源(DirectorSystem 管理,未来 LLM 导演分配这些资源调控节奏) */
  enemyFaction: {
    // 可生成点(地图扩大一倍,坐标 ×2)
    spawnPoints: [
      { x: 50, z: 0 },
      { x: -50, z: 10 },
      { x: 0, z: 56 },
    ],
    // 预定义巡逻区域(地图扩大一倍,坐标 ×2)
    patrolAreas: [
      { id: 'north', waypoints: [{ x: 36, z: 50 }, { x: -36, z: 44 }, { x: -44, z: 16 }] },
      { id: 'east', waypoints: [{ x: 56, z: 20 }, { x: 60, z: -16 }, { x: 44, z: -36 }] },
      { id: 'south', waypoints: [{ x: -36, z: -44 }, { x: 0, z: -36 }, { x: 32, z: -48 }] },
    ],
    maxConcurrent: 5, // 同场最大敌坦数(导演硬上限)
    targetConcurrent: 3, // 目标同场敌坦数(维持持续 3v1 压力)
    spawnInterval: 10, // 击毁后补充间隔(s,给玩家喘息窗口)
    reserveVariants: ['tiger', 'abrams'], // 可生成的型号池
  },

  /** AI 导演策略(A1波次 + A2姿态调控)
   * ------------------------------------------------------------
   * 导演按态势评估 → 切换全阵营姿态 → 修饰所有 NPC 行为参数(反应/蓄瞄/撤退),
   * 让 NPC 有"集体智能"(玩家残血时被猛攻、NPC 残血时收缩),而非各自为战。 */
  director: {
    /** 姿态评估周期(s);不必每帧评,省算 */
    postureEvalInterval: 1.0,
    /** aggro 触发:玩家血量(占 maxHp)低于此比例 → 全阵营激进追击 */
    aggroPlayerHpRatio: 0.4,
    /** defensive 触发:存活 NPC 平均血量低于此比例 → 全阵营收缩保守 */
    defensiveNpcHpRatio: 0.5,
    /** 姿态参数修饰系数(乘到 NPC profile/npc 参数上) */
    postureMod: {
      aggro:     { reaction: 0.6, aimTime: 0.8, retreat: 0.5 }, // 反应快/蓄瞄快/少撤退
      normal:    { reaction: 1.0, aimTime: 1.0, retreat: 1.0 },
      defensive: { reaction: 1.5, aimTime: 1.2, retreat: 1.5 }, // 反应慢/更早撤退
    },
  },

  /** 关卡清单(开始界面供玩家选择)
   * ------------------------------------------------------------
   * 每关声明获胜方式(objectiveType)+ 专属参数(target 等)+ UI 文案。
   * 开始界面渲染为可选卡片,玩家选中后 main 按 objectiveType 创建对应
   * Objective(+ 关卡专属实体,如占领军创建 CaptureZone)。
   *
   * 新增关卡只需:① 往此数组加一条;② 加对应 Objective 实现 + 工厂分支;
   *               ③ 若需专属实体(如占领点)在 main 选关回调里按 level.id 创建。
   * main/UI 数据驱动,加关卡不动循环/UI 主体。
   */
  levels: [
    {
      id: 'kill',
      name: '歼灭战',
      brief: '击毁 15 辆敌坦',
      tip: '全图搜索并歼灭敌方坦克,弹药有限注意补给',
      objectiveType: 'kill',
      target: 15, // 击毁目标数
    },
    {
      id: 'capture',
      name: '占领军',
      brief: '占领中央据点 60 秒',
      tip: '驶入中央据点驻留累计时间,敌方会来抢;进度满获胜,敌方占满则失败',
      objectiveType: 'capture',
      target: 60, // 玩方占领达此秒数 → 胜利
      enemyTarget: 60, // 敌方占领达此秒数 → 玩家失败
    },
  ],

  /** 占领点(仅 'capture' 关卡创建;歼灭战无此实体)
   * ------------------------------------------------------------
   * 中央据点:坦克驶入半径内即开始占领。无物理碰撞体(坦克可穿过中心),
   * 不可摧毁(纯区域 + 视觉)。视觉用与补给点完全不同的色系(蓝/红 vs 绿)区分。
   *
   * 进度规则(由 CaptureSystem 每帧推进):
   *  - 区域内只有玩家 → 玩家进度 += playerRate
   *  - 区域内只有敌方 → 敌方进度 += enemyRate(达 enemyTarget 玩家失败)
   *  - 双方同区(contestedFreeze=true)→ 进度冻结(避免"站着蹭")
   *  - 区域空 → 双方进度按 decayRate 回退(避免"蹭一下就稳住") */
  capturePoint: {
    /** 占领点位置:战场腹地(z=28),玩家(0,-16)往北推进 44m;与中央补给点(0,10)
     *  距离 18m 清晰分离;敌方(0,56)往南 28m。给玩家"进攻"节奏感。 */
    position: { x: 0, z: 28 },
    /** 占领半径(m):比补给点半径(5)更大,容得下双方对枪争夺 */
    radius: 8,
    /** 玩方占领推进速率(进度秒/秒) */
    playerRate: 1.0,
    /** 敌方占领推进速率(进度秒/秒) */
    enemyRate: 1.0,
    /** 空区回退速率(秒/秒):区域内无坦克时双方进度按此回退 */
    decayRate: 0.5,
    /** 争夺态冻结:true=双方同区进度完全冻结 */
    contestedFreeze: true,
    /** NPC 巡逻围绕半径(m):占领军关卡 DirectorSystem 给 NPC 分配的巡逻 waypoint
     *  以占领点为圆心、此半径布点,NPC 自然在据点周围逗留形成对抗。 */
    npcPatrolRadius: 6,
  },

  /** 补给点(M5:可被摧毁、定时再生的弹药装填点)
   * ------------------------------------------------------------
   * 坦克驶入半径内自动装填;可被炮弹/撞击摧毁,摧毁后倒计时原位复活。
   * 3 点均衡分布(玩家南、NPC 东/西/北 都能就近补给),鼓励机动与争夺。 */
  resupplyPoint: {
    /** 补给站 HP:hitDamage≈35 衰减后约 3 发直击可毁(战略资源,不至太脆也不至于太硬)。 */
    hp: 100,
    /** 被摧毁后再生时间(s):原位复活。摧毁方只能短期剥夺对方补给,不会永久瘫痪。 */
    regenTime: 30,
    /** 中央补给站建筑半尺寸(m,实心 fixed collider)。坦克撞不上需绕行至半径内装填。 */
    stationHalf: { x: 1.0, y: 1.0, z: 1.0 },
    /** 3 个补给点位置(均衡覆盖战场) */
    points: [
      { x: 0, z: 10 }, // 中央:战场核心争夺点
      { x: 45, z: -25 }, // 东侧:玩家与东线 NPC 共用
      { x: -45, z: 25 }, // 西侧:玩家与西线 NPC 共用
    ],
  },

  /** 山(四周背景，静态不可破坏，环形围合村庄) */
  mountain: {
    ringRadius: 190, // 山环半径(随地图扩大一倍)
    count: 24, // 山的数量(大地图多几座,避免空旷)
    radiusMin: 16, radiusMax: 32, // 山底半径范围(略放大,匹配更大的山环)
    heightMin: 20, heightMax: 40, // 山高范围(略放大,视觉更壮观)
    color: 0x4a4a3a, // 山体灰绿
  },

  /** 音频系统(机械音 + 人声语音)
   * ------------------------------------------------------------
   * 分三轨:
   *  - sfx(机械音:开炮/引擎/行驶):所有坦克都发声,经 PannerNode 做 3D 距离衰减,
   *    玩家能听声辨位、感知远近。引擎循环音仅近距离 NPC 播放(性能)。
   *  - voice(人声指挥):仅玩家附身坦克触发,中文,非空间化直放——
   *    避免远处 NPC 喊话混成一锅;玩家是单车指挥视角。
   *  - bgm(背景音乐):加载/作战状态各一曲循环,非空间化,独立音量轨。
   *
   * AudioContext 解锁:浏览器要求用户手势。加载阶段 ctx 保持 suspended
   * (decodeAudioData 不需 running),玩家点"开始作战"按钮时才 resume。
   * 加载失败/ctx 不可用时降级静音,不阻塞游戏。 */
  audio: {
    /** 主音量(0~1,作用于 masterGain) */
    master: 0.8,
    /** 机械音轨音量(0~1) */
    sfx: 0.9,
    /** 人声音轨音量(0~1) */
    voice: 1.0,
    /** 背景音乐轨音量(0~1)。低于音效,避免盖过战斗反馈 */
    bgm: 0.45,
    /** 空间化距离衰减(机械音用;PannerNode 参数) */
    spatial: {
      /** 参考距离(m):此距离内音量不衰减 */
      refDistance: 8,
      /** 衰减系数(inverse 模型 rolloffFactor) */
      rolloff: 1.2,
      /** 最大距离(m):超此静音(上限,防远处声源堆积) */
      maxDistance: 120,
    },
    /** 引擎循环音策略(双层:发动机 + 行驶,按速度分档切换)
     * ------------------------------------------------------------
     * 发动机层(engine):idle(静止/低速) ↔ full_speed(高速) —— 转速感
     * 行驶层(driving):静止不响,low(低速) ↔ high(高速) —— 路面行驶感
     * 两层独立按速度切档,叠加播放(更真实的"引擎+行驶"复合声)。 */
    engine: {
      /** NPC 引擎音播放半径(m):距玩家此距离内的存活 NPC 才播引擎循环音,
       *  超出的不播(避免十几个 PannerNode 循环源堆积卡顿) */
      npcPlayRadius: 50,
      /** 静止阈值(m/s):速度低于此视为静止,行驶层(driving)全部静音
       *  (停车无行驶声,仅发动机怠速)。发动机层仍响 idle。 */
      minSpeed: 0.5,
      /** 低速/高速分界(m/s):发动机与行驶层各自按此切档
       *  速度≥此 → engine_full + driving_high;否则 engine_idle + driving_low */
      speedThreshold: 1.5,
      /** 档位切换交叉淡变时长(s):平滑切换不突兀 */
      crossfade: 0.4,
    },
    /** 人声语音防刷屏冷却(s):同一条语音两次触发间的最小间隔 */
    voiceCooldown: {
      /** 发现敌人(玩家命中敌坦):冷却较长,避免连续命中刷屏 */
      spotted: 5,
      /** 低弹药警告:冷却较长,避免持续低弹药时反复播 */
      lowAmmo: 20,
    },
    /** 低弹药语音触发:弹药总量占比低于阈值时播一次警告,
     *  补满后重置(下次再低于阈值可再触发)。仅玩家触发。 */
    lowAmmo: {
      /** 触发阈值(0~1):(ap+he)/(maxAp+maxHe) 低于此比例 → 播 low_ammo */
      ratio: 0.3,
    },
    /** 语音语言(决定加载哪套语音文件)。
     *  'zh' 仅加载中文 | 'en' 仅英文(当前) | 'both' 双语都加载。
     *  当前决策"仅玩家触发语音" → 加载一套即可。 */
    voiceLang: 'en' as 'zh' | 'en' | 'both',
  },
} as const;
