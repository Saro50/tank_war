/**
 * PartList.ts — 左侧部件列表(自定义模式专用)
 * ============================================================
 * 渲染 model.parts,每项显示:部位图标 + 名称 + role 徽章 + hover 操作(上移/下移/复制/删除)。
 * 选中高亮,操作回调到 CustomEditorMode。
 *
 * 视觉引导(用图标而非文字堆叠):
 *   部位图标:🚜hull / 🎯turret / ➤barrel / 🛞track/wheel / ✨decorative
 *   role 徽章:主炮塔/主炮管/左履带/右履带(金色小标,暗示"运行时锚点")
 */
import type { TankModel, PartRole } from '../data/TankSchema';

export interface PartListCallbacks {
  onSelect: (id: string) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onDuplicate: (id: string) => void;
}

/** partType → 图标 */
const TYPE_ICON: Record<string, string> = {
  hull: '🚜', turret: '🎯', barrel: '➤', track: '🛞', wheel: '🛞', decorative: '✨',
};
/** role → 徽章文字 */
const ROLE_BADGE: Record<PartRole, string> = {
  'turret-body': '主炮塔',
  'main-barrel': '主炮管',
  'left-track': '左履带',
  'right-track': '右履带',
};

export function renderPartList(
  container: HTMLElement,
  model: TankModel,
  selectedId: string | undefined,
  cb: PartListCallbacks,
): void {
  container.innerHTML = '';

  // 添加按钮(顶部,强引导)
  const addBtn = document.createElement('button');
  addBtn.textContent = '＋ 添加部件';
  addBtn.style.cssText = 'display:block;width:calc(100% - 24px);margin:8px 12px;padding:6px;background:#2a3a2a;color:#7fff7f;border:1px solid #3a5a3a;border-radius:4px;cursor:pointer;font-family:monospace;font-size:12px;';
  addBtn.addEventListener('click', () => cb.onAdd());
  container.appendChild(addBtn);

  // 部件列表
  for (const part of model.parts) {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;align-items:center;padding:5px 14px;gap:6px;cursor:pointer;font-size:12px;white-space:nowrap;overflow:hidden;';
    item.style.background = part.id === selectedId ? '#2a3a2a' : 'transparent';
    item.style.color = part.id === selectedId ? '#7fff7f' : '#ccc';
    item.addEventListener('mouseenter', () => { if (part.id !== selectedId) item.style.background = '#22242a'; });
    item.addEventListener('mouseleave', () => { if (part.id !== selectedId) item.style.background = 'transparent'; });
    item.addEventListener('click', () => cb.onSelect(part.id));

    // 部位图标
    const icon = document.createElement('span');
    icon.textContent = TYPE_ICON[part.partType] ?? '？';
    icon.style.width = '18px';
    item.appendChild(icon);

    // 名称
    const name = document.createElement('span');
    name.textContent = part.name;
    name.style.flex = '1';
    name.style.overflow = 'hidden';
    name.style.textOverflow = 'ellipsis';
    item.appendChild(name);

    // role 徽章(仅 role 部件显示)
    if (part.role) {
      const badge = document.createElement('span');
      badge.textContent = ROLE_BADGE[part.role];
      badge.style.cssText = 'font-size:9px;background:#4a3a1a;color:#ffcc33;padding:1px 4px;border-radius:2px;border:1px solid #5a4a2a;';
      item.appendChild(badge);
    }

    // hover 操作组(上移/下移/复制/删除)
    const actions = document.createElement('span');
    actions.style.cssText = 'display:none;gap:2px;margin-left:4px;';
    const mkBtn = (txt: string, title: string, onClick: (e: Event) => void): void => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.title = title;
      b.style.cssText = 'background:#22242a;color:#aaa;border:1px solid #3a3c42;border-radius:2px;padding:0 4px;cursor:pointer;font-size:11px;line-height:1.4;';
      b.addEventListener('click', (e) => { e.stopPropagation(); onClick(e); });
      actions.appendChild(b);
    };
    mkBtn('▲', '上移', () => cb.onMove(part.id, -1));
    mkBtn('▼', '下移', () => cb.onMove(part.id, 1));
    mkBtn('⎘', '复制', () => cb.onDuplicate(part.id));
    mkBtn('✕', '删除', () => cb.onRemove(part.id));
    item.appendChild(actions);
    item.addEventListener('mouseenter', () => { actions.style.display = 'flex'; });
    item.addEventListener('mouseleave', () => { actions.style.display = 'none'; });

    container.appendChild(item);
  }

  // 空态提示(无部件时)
  if (model.parts.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:20px 14px;color:#555;font-size:12px;text-align:center;';
    empty.textContent = '暂无部件,点上方添加';
    container.appendChild(empty);
  }
}
