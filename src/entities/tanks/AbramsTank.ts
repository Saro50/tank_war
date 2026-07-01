import { StaticTankBase } from './StaticTankBase';

/**
 * M1 艾布拉姆斯(Abrams)
 * ------------------------------------------------------------
 * 现代主战坦克:倾斜复合装甲、楔形炮塔、7 对大负重轮、托带轮、沙漠迷彩 + 战术编号。
 *
 * 外形/HP/质量等全部由 CONFIG.staticTank.abrams 驱动(StaticTankBase 读 config 构造),
 * 本类只声明 variant 字面量——所有逻辑下沉到 StaticTankBase/TankBase。
 */
export class AbramsTank extends StaticTankBase {
  protected readonly variant = 'abrams' as const;
}
