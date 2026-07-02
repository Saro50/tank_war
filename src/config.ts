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

    /** 梯形车身(视觉)：上窄下宽，底宽>履带外缘以遮挡履带 */
    hull: {
      bottomHalfX: 1.06, // 底宽半(略<履带外缘1.15，让履带外侧面外露可见链节滚动)
      topHalfX: 0.9, // 顶宽半(X 方向收窄)
      bottomHalfZ: 2.15, // 底长半(接地满长，适配 7 对负重轮)
      topHalfZ: 1.65, // 顶长半(Z 收窄 → 前后楔形斜下，规避炮管下俯穿模)
      height: 1.05,
      centerY: -0.05, // 车身下沉，座于两履带之间
    },

    /** 履带(视觉)：左右各一，胶囊形(直段box+两端圆柱)，独立纹理滚动 */
    track: {
      halfX: 0.27, // 厚度半(x)
      halfY: 0.3, // 高度半(y) = 两端圆柱半径
      halfZ: 2.05, // T-14 总长半(含两端圆弧，适配 7 对轮)
      offsetX: 0.88, // 左右履带中心 x(±)，外缘 0.88+0.27=1.15 < 车身底宽 1.25
      centerY: -0.48, // 履带中心 y(底部接地)
      texRepeat: 6, // 纹理沿长度重复(链节组数)
      rollScale: 1.0, // 滚动视觉放大系数
    },

    /** 负重轮(写实：每侧多排小轮露在履带内侧，最影响"像不像坦克") */
    roadWheel: {
      count: 7, // T-14 每侧 7 对负重轮(辨识特征)
      radius: 0.22, // 轮半径(<履带主动轮0.3，形成主动轮更大的层次)
      halfWidth: 0.1, // 轮厚半(x)
      offsetX: 0.66, // 轮中心 x(在履带内侧，<履带offsetX0.88)
      centerY: -0.48, // 与履带中心同高(接地)
      zSpan: 1.6, // T-14 轮组前后分布半长(7 对轮更长)
    },

    /** 挡泥板(履带上方薄板，写实坦克标志，遮住履带上半圈) */
    fender: {
      halfX: 0.16, // 板宽半(覆盖到履带外缘)
      halfY: 0.025, // 板厚半(薄板)
      halfZ: 2.1, // 板长半(略长于履带，T-14 加长)
      offsetX: 0.88, // 与履带 x 对齐
      centerY: -0.16, // 在履带上方
    },

    /** 炮塔(键盘 U/I 控制左右旋转) */
    turret: {
      offset: { x: 0, y: 0.48, z: -0.3 },
      turnSpeed: 1.3, // rad/s
      /** 旋转惯性：角速度 lerp 系数(越小越迟钝、滑转越久；C 阶段) */
      omegaLerp: 0.12,
      /**
       * T-14 无人炮塔(扁平方形主体 + 传感器柱 + 遥控机枪)
       * 取代传统圆筒炮塔 + 指挥塔，是 T-14 一眼识别的核心
       */
      armata: {
        // 楔形炮塔(参考实物图)：顶窄底宽 + 顶短底长 → 正面装甲内倾的楔形轮廓
        bottomHalfX: 0.88, topHalfX: 0.6, // 底宽/顶宽半(顶收窄→正面楔形)
        bottomHalfZ: 1.05, topHalfZ: 0.85, // 底长/顶长半(顶面整体小一圈)
        halfY: 0.26, // 高半(扁平，仅传统炮塔~60%)
        offsetY: 0.3, // 中心相对炮塔基座的 y
        /** 车长全景瞄准镜(后部较大柱状方块) */
        sightCmdr: { half: { x: 0.2, y: 0.13, z: 0.16 }, offset: { x: 0, y: 0.46, z: -0.4 } },
        /** 炮长瞄准镜(前部偏右小柱状) */
        sightGunner: { half: { x: 0.13, y: 0.11, z: 0.12 }, offset: { x: 0.28, y: 0.42, z: 0.3 } },
        /** 遥控机枪 RCWS(右前方，含枪管) */
        rcws: { half: { x: 0.16, y: 0.09, z: 0.16 }, offset: { x: 0.42, y: 0.42, z: 0.05 }, barrelLen: 0.5, barrelRadius: 0.022 },
      },
      /** "阿富汗石"主动防御系统发射管(炮塔两侧小柱，T-14 标志) */
      afghanit: {
        radius: 0.045, height: 0.16,
        count: 5, // 每侧数量
        offsetX: 0.88, // 炮塔侧面 x(贴方形炮塔外侧)
        zSpan: 0.7, // 沿 z 分布范围
        offsetY: 0.2,
      },
      /**
       * 通讯天线(挂炮塔后部 → 随炮塔旋转，永远在炮管反方向，规避炮管穿模)
       * 坐标为炮塔局部：炮管指向 +z，故天线放在 -z 后部
       */
      antenna: {
        radius: 0.014, length: 1.0, // 炮塔顶天线
        baseX: 0.6, // T-14 炮塔右后(避开 RCWS x=0.42)
        baseY: 0.42, // 方形炮塔顶面附近(顶面 y≈0.56)
        baseZ: -0.7, // 炮塔后部(炮管 +z 的反方向)
        tilt: 0.3, // 后倾角(rad)
      },
    },

    /** 炮管(键盘 O/P 控制抬起放下) */
    barrel: {
      offset: { x: 0, y: 0.28, z: 0.4 },
      length: 1.9,
      pitchRange: { min: -0.32, max: 0.2 }, // rad: [最大下俯, 最大上仰]
      pitchSpeed: 0.9, // rad/s
      /** 炮盾(炮管根部加厚块，连接炮塔与炮管，写实坦克必备) */
      mantlet: {
        radius: 0.2, // 比炮管0.11粗，视觉上"鼓"出来
        halfZ: 0.18, // 厚度半
      },
      /** 炮管中段抽烟器(T-14 的 2A82，位于炮管中部偏前) */
      fumeExtractor: {
        radius: 0.15, // 比炮管0.11略粗
        length: 0.4, // 抽烟器长度
        posRatio: 0.66, // 沿炮管位置比例(0=根部,1=炮口)，距炮口约1/3
      },
      /** 炮口装置(消焰器，炮口端小粗段，参考实物图) */
      muzzleDevice: {
        radius: 0.13, // 略粗于炮管0.11
        length: 0.18,
      },
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

    /** 车体附件(写实细节，提升"装备感") */
    stowage: {
      /** 发动机舱格栅(车尾散热条) */
      engineGrille: {
        count: 5, halfX: 0.5, halfY: 0.16, halfThick: 0.018,
        z: -2.1, y: 0.0, // T-14 车体加长，后移
      },
      /** 驾驶员舱盖(车体前部顶上凸起，T-14 乘员舱在前) */
      driverHatch: { radius: 0.22, height: 0.1, x: 0, z: 1.5, y: 0.5 },
    },

    /**
     * 写实军事风配色板(B 阶段迷彩将在此基础上叠纹理)
     * 分材质 PBR：漆面哑光 / 金属高反射 / 橡胶全哑光
     */
    colors: {
      hull: 0x4a5535, // T-14 俄军橄榄绿(偏黄绿，哑光漆面)
      turret: 0x434d30, // 炮塔略深一档
      /** 程序迷彩色板(俄军绿系：绿底 + 深褐斑块 + 暗绿斑块) */
      camo: {
        base: 0x4a5535, // 底色俄军绿
        blobDark: 0x2a2e18, // 深黑褐斑块
        blobMid: 0x38401e, // 暗绿斑块
      },
      /** 炮塔战术编号贴花文字 */
      number: '03',
      trackMetal: 0x2a2d33, // 履带深铁灰(金属)
      wheelRubber: 0x1a1c1f, // 负重轮橡胶黑(全哑光)
      wheelHub: 0x3a3d42, // 轮毂金属中灰
      barrel: 0x33373d, // 炮管枪铁灰(金属)
      mantlet: 0x2e3137, // 炮盾深灰铸铁
      detail: 0x141619, // 天线/格栅等黑色细节
      fender: 0x4a5424, // 挡泥板(同车身略暗，区分层次)
    },

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

  /** 武器/开火（M3） */
  weapon: {
    /** 炮弹 */
    projectile: {
      radius: 0.13,
      mass: 2.5,
      /** 初速度(m/s) */
      muzzleVelocity: 60,
      /** 最长存活(s)，超时销毁防丢失 */
      maxLifetime: 6,
    },
    /** 开火冷却(s)：连发最小间隔 */
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
   * 逼玩家管理弹药、回补给点,打破"无限倾泻"的单调节奏。 */
  ammo: {
    /** 每辆坦克炮弹上限(玩家/NPC 统一)。约够 16s 连射,够一场交战但有上限。 */
    maxAmmo: 30,
    /** 补给点装填速率(发/秒):30 发约 3.75s 补满。不能瞬补(防战斗中滥用)。 */
    resupplyRate: 8,
    /** 补给点装填半径(m):坦克驶入此半径即开始装填。 */
    resupplyRadius: 5,
    /** NPC 弹药≤此值时主动前往补给点(留余量防路上无还手之力)。 */
    npcResupplyThreshold: 5,
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
    /** 德国虎式坦克(二战)：垂直方盒装甲、长车身、长88mm炮、德军迷彩 */
    tiger: {
      // 车身:垂直方盒装甲(写实虎式),加厚(高 1.3)显得敦实厚重有分量;
      // 整体按比例缩小到与玩家 T-14 接近(全长≈4.8m < 原 5.8m),不再明显大于玩家。
      hull: {
        bottomHalfX: 1.18, topHalfX: 1.18, // 略加宽(厚重感),垂直装甲
        bottomHalfZ: 2.4, topHalfZ: 2.4, // 长度缩(原2.9)
        height: 1.3, centerY: 0.9, // 再加厚(1.15→1.3)+ 上移,座于履带间更敦实厚重
        /** 车首下斜板(三角楔:后缘贴车体前端、斜面从前顶下倾到前底,无悬空) */
        frontSlope: { halfX: 1.18, halfDepth: 0.5, halfHeight: 0.65, x: 0, y: 0.9, z: 2.9 },
      },
      track: { halfX: 0.28, halfY: 0.3, halfZ: 2.4, offsetX: 1.18, centerY: 0.45, texRepeat: 12 },
      roadWheel: { count: 8, radius: 0.3, halfWidth: 0.16, offsetX: 1.18, centerY: 0.45, zSpan: 2.1 },
      /** 交错式负重轮(虎式标志)：内排轮偏移半距,视觉上呈交错排列 */
      roadWheelStagger: { radius: 0.26, halfWidth: 0.16, offsetX: 1.05, centerY: 0.45, zSpan: 2.1, zHalfStep: true },
      fender: { halfX: 0.24, halfY: 0.05, halfZ: 2.45, offsetX: 1.36, centerY: 1.05 },
      /** 侧裙板(虎式 Schürzen 护板:仅遮履带顶端,露出交错轮组的标志造型) */
      sideSkirt: { halfX: 0.05, halfY: 0.18, halfZ: 2.2, offsetX: 1.42, centerY: 0.78 },
      turret: {
        offset: { x: 0, y: 1.55, z: -0.3 }, // 炮塔随加厚车体上移(1.36→1.55),坐稳车顶
        // 炮塔主体:前后非对称楔形(正面厚、后部急剧收薄 → 真楔形,非对称截头锥)
        // frontHalfZ 大=正面装甲厚、近乎垂直;backHalfZ 小=向后收薄成尖锐楔尾
        body: { bottomHalfX: 0.78, topHalfX: 0.6, bottomHalfZ: 1.05, topHalfZ: 0.85, frontHalfZ: 0.85, backHalfZ: 0.45, height: 0.6, centerY: 0.3 },
        /** 车长指挥塔(炮塔顶圆柱,虎式标志) */
        cupola: { radius: 0.22, height: 0.2, x: 0, y: 0.7, z: -0.5 },
        /** 无独立周视瞄准镜(二战坦克无此装置) */
        sight: undefined,
        /** 无装填手舱盖配置 */
        loaderHatch: undefined,
        /** 炮塔后部战斗室加宽段(与主体同宽,后延加厚 → H 形后部,H 形平面) */
        bustle: { halfX: 0.78, halfY: 0.22, halfZ: 0.3, x: 0, y: 0.32, z: -1.15 },
        /** 前脸厚防盾(88mm 炮根处加厚块,模拟虎式弧形防盾,避免前脸平板) */
        frontShield: { halfX: 0.42, halfY: 0.32, halfZ: 0.18, x: 0, y: 0.32, z: 1.0 },
      },
      barrel: { offset: { x: 0, y: 0.25, z: 0.5 }, length: 3.0, radius: 0.09 }, // 88mm 长炮(随车身缩)
      /** 炮口制退器(88mm 双室制退器,虎式标志) */
      muzzleBrake: { radius: 0.13, length: 0.4 },
      /** 无热护套(二战坦克用炮口制退器,不用热护套) */
      thermalSleeve: undefined,
      /** 炮盾(炮管根部加厚,防盾) */
      mantlet: { radius: 0.17, halfZ: 0.32 },
      colors: {
        hull: 0x6b6a55, turret: 0x6b6a55,
        camo: { base: 0x6b6a55, blobDark: 0x4a4a35, blobMid: 0x8a7d4a }, // 德军灰绿+褐黄
        trackMetal: 0x333333, wheelRubber: 0x1a1a1a, wheelHub: 0x555555,
        barrel: 0x4a4a35, detail: 0x2a2a20, fender: 0x5a5a45,
      },
      number: '231',
      /** 贴花:德军黑十字(Balkenkreuz)贴炮塔两侧 */
      decal: { cross: true, crossColor: 0x1a1a1a },
      maxHp: 40, // 重装甲但游戏化:3~4 发可毁(原 200 太高体感无反应)
      /** 调试附身模式用的运行参数(履带位置/相机偏移适配更大车身) */
      debugDrive: {
        trackOffsetX: 1.18,
        trackHalfZ: 2.4,
        cameraOffset: { x: 0, y: 5.2, z: -11 },
        cameraLookOffset: { x: 0, y: 1.6, z: 7 },
      },
    },
    /** M1 艾布拉姆斯(现代主战)：倾斜复合装甲、楔形炮塔、7对大负重轮、沙漠迷彩 */
    abrams: {
      hull: {
        bottomHalfX: 1.35, topHalfX: 1.15, // 略加宽(厚重感)
        bottomHalfZ: 2.6, topHalfZ: 2.4,
        height: 1.0, centerY: 0.85, // 加厚(原0.75→1.0)+上移,座于履带间更敦实厚重
        /** 车首驾驶舱凸起(M1 前上装甲板上的驾驶舱,标志性前凸) */
        frontHatch: { halfX: 0.4, halfY: 0.22, halfZ: 0.45, x: 0, y: 1.3, z: 1.6 },
        /** 车首下斜板(三角楔:M1 标志性大倾角 lower glacis,后缘贴车体前端、斜面前伸接地) */
        frontSlope: { halfX: 1.35, halfDepth: 0.45, halfHeight: 0.5, x: 0, y: 0.85, z: 3.05 },
      },
      track: { halfX: 0.32, halfY: 0.32, halfZ: 2.6, offsetX: 1.35, centerY: 0.4, texRepeat: 13 },
      roadWheel: { count: 7, radius: 0.36, halfWidth: 0.2, offsetX: 1.35, centerY: 0.4, zSpan: 2.2 },
      /** 托带轮(M1 履带上方回程支撑轮,现代坦克标志,4-6 个小轮) */
      returnRoller: { radius: 0.12, halfWidth: 0.1, offsetX: 1.32, centerY: 0.72, count: 5, zSpan: 1.6 },
      /** 前主动轮带齿、后诱导轮实心盘(M1 履带端轮差异化) */
      toothedSprocket: true,
      /** 无交错轮(现代坦克用扭杆悬挂均匀排列) */
      roadWheelStagger: undefined,
      fender: { halfX: 0.28, halfY: 0.05, halfZ: 2.65, offsetX: 1.55, centerY: 0.82 },
      /** 侧裙板(M1 标志:只遮履带上半,露出下排大负重轮,现代坦克特征) */
      sideSkirt: { halfX: 0.06, halfY: 0.26, halfZ: 2.3, offsetX: 1.62, centerY: 0.72 },
      turret: {
        offset: { x: 0, y: 1.35, z: 0.1 }, // 炮塔随加厚车体上移(原1.0→1.35),坐稳车顶
        // 炮塔主体:前后非对称楔形(正面厚装甲、后部收薄成楔尾,M1 炮塔本质前厚后薄)
        body: { bottomHalfX: 0.95, topHalfX: 0.68, bottomHalfZ: 1.1, topHalfZ: 0.85, frontHalfZ: 0.85, backHalfZ: 0.4, height: 0.7, centerY: 0.35 },
        /** 车长指挥塔(M1 车长独立周视镜,右后) */
        cupola: { radius: 0.22, height: 0.24, x: 0.35, y: 0.78, z: -0.25 },
        /** 车长瞄准镜(前部柱状,独立周视镜) */
        sight: { halfX: 0.13, halfY: 0.2, halfZ: 0.13, x: 0.32, y: 0.82, z: 0.28 },
        /** 装填手舱盖(左侧不对称,M1 标志) */
        loaderHatch: { radius: 0.22, height: 0.12, x: -0.35, y: 0.78, z: 0.0 },
        /** 炮塔尾部储物篮(后部楔尾处,扁平篮筐) */
        bustle: { halfX: 0.68, halfY: 0.28, halfZ: 0.4, x: 0, y: 0.42, z: -1.1 },
        /** 无独立前脸防盾块(楔形炮塔本身够锐) */
        frontShield: undefined,
        /** 车长机枪站(M1 炮塔顶 12.7mm 机枪:底座+枪管,装填手位) */
        mgStation: {
          baseHalf: { x: 0.16, y: 0.1, z: 0.18 },
          base: { x: -0.35, y: 0.95, z: -0.1 },
          barrelRadius: 0.025, barrelLen: 0.7,
          barrel: { x: -0.35, y: 1.1, z: 0.15 },
        },
      },
      barrel: { offset: { x: 0, y: 0.3, z: 0.55 }, length: 2.9, radius: 0.1 }, // M256 120mm,热护套粗
      /** 无炮口制退器(M256 用热护套不用制退器) */
      muzzleBrake: undefined,
      /** 热护套(炮管中段分段加粗,防热变形,现代坦克标志) */
      thermalSleeve: { radius: 0.14, length: 1.6, posRatio: 0.45 },
      /** 炮盾(炮管根部加厚防盾) */
      mantlet: { radius: 0.2, halfZ: 0.4 },
      colors: {
        hull: 0xb5a06a, turret: 0xb5a06a,
        camo: { base: 0xb5a06a, blobDark: 0x8a7445, blobMid: 0xd4c089 }, // 沙漠黄三色
        trackMetal: 0x333333, wheelRubber: 0x1a1a1a, wheelHub: 0x555555,
        barrel: 0x8a7445, detail: 0x3a3520, fender: 0xa08a55,
      },
      number: 'A11',
      /** 贴花:战术编号(无十字,美军风格) */
      decal: { cross: false, crossColor: 0x1a1a1a },
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
    { variant: 't14', spawn: { x: 0, y: 0, z: -16 }, yaw: 0, player: true, team: 'player' },
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
} as const;
