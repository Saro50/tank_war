import { StaticTankBase } from './StaticTankBase';

/**
 * 虎式坦克(Tiger I)
 * ------------------------------------------------------------
 * 二战德军重型坦克:垂直方盒装甲、长 88mm 炮、交错负重轮、德军迷彩 + 黑十字贴花。
 *
 * 外形/HP/质量等全部由 CONFIG.staticTank.tiger 驱动(StaticTankBase 读 config 构造),
 * 本类只声明 variant 字面量——所有逻辑下沉到 StaticTankBase/TankBase。
 */
export class TigerTank extends StaticTankBase {
  protected readonly variant = 'tiger' as const;
}
