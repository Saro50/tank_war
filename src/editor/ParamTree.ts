/**
 * ParamTree — 左侧参数树
 * ============================================================
 * 从视觉数据对象递归生成树形导航节点。
 * 展开/折叠组,点击叶子节点触发选中回调。
 */
export interface TreeNode {
  path: string[];      // 数据路径,如 ['hull','bottomHalfX']
  label: string;       // 显示名称
  isLeaf: boolean;     // 叶子节点(可编辑值) vs 分组节点
  children: TreeNode[];
}

/**
 * 从数据对象递归构建树节点列表
 */
export function buildTree(data: Record<string, unknown>, basePath: string[] = []): TreeNode[] {
  const nodes: TreeNode[] = [];
  for (const [key, value] of Object.entries(data)) {
    const path = [...basePath, key];
    const label = keyToLabel(key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      // 嵌套对象 → 分组节点
      const children = buildTree(value as Record<string, unknown>, path);
      nodes.push({ path, label, isLeaf: false, children });
    } else {
      // 叶子节点
      nodes.push({ path, label, isLeaf: true, children: [] });
    }
  }
  return nodes;
}

/** 驼峰/下划线 → 中文友好标签(导出供 PropPanel 复用,避免两份映射) */
export function keyToLabel(key: string): string {
  const map: Record<string, string> = {
    bottomHalfX: '底宽 X',
    topHalfX: '顶宽 X',
    bottomHalfZ: '底长 Z',
    topHalfZ: '顶长 Z',
    halfX: '宽半 X',
    halfY: '高半 Y',  // also used for height-half in turret
    halfZ: '长半 Z',
    offsetX: '偏移 X',
    offsetY: '偏移 Y',
    offsetZ: '偏移 Z',
    centerY: '中心 Y',
    radius: '半径',
    height: '高度',
    length: '长度',
    width: '宽度',
    count: '数量',
    zSpan: '跨度 Z',
    texRepeat: '纹理重复',
    rollScale: '滚动缩放',
    halfWidth: '厚度半',
    halfDepth: '深度半',
    halfHeight: '高度半',
    halfThick: '厚度半',
    barrelLen: '枪管长',
    barrelRadius: '枪管半径',
    posRatio: '位置比例',
    tilt: '后倾角',
    baseX: '基点 X',
    baseY: '基点 Y',
    baseZ: '基点 Z',
    frontHalfZ: '前长 Z',
    backHalfZ: '后长 Z',
    zHalfStep: '半距偏移',
    'half.x': '尺寸 X',
    'half.y': '尺寸 Y',
    'half.z': '尺寸 Z',
    'offset.x': '偏移 X',
    'offset.y': '偏移 Y',
    'offset.z': '偏移 Z',
    cross: '十字贴花',
    crossColor: '十字颜色',
    number: '编号',
    hull: '车体',
    track: '履带',
    roadWheel: '负重轮',
    roadWheelStagger: '交错轮',
    fender: '挡泥板',
    sideSkirt: '侧裙板',
    turret: '炮塔',
    barrel: '炮管',
    colors: '配色',
    color: '颜色',
    camo: '迷彩',
    style: '样式',
    wear: '磨损度',
    base: '底色',
    blobDark: '深色斑块',
    blobMid: '中间斑块',
    trackMetal: '履带金属',
    wheelRubber: '轮橡胶',
    wheelHub: '轮毂',
    detail: '细节',
    mantlet: '炮盾',
    fumeExtractor: '抽烟器',
    muzzleDevice: '炮口装置',
    muzzleBrake: '制退器',
    thermalSleeve: '热护套',
    stowage: '附件',
    engineGrille: '发动机格栅',
    driverHatch: '驾驶员舱盖',
    armata: 'Armata 炮塔',
    afghanit: '阿富汗石',
    antenna: '天线',
    sightCmdr: '车长镜',
    sightGunner: '炮长镜',
    rcws: '遥控机枪',
    cupola: '指挥塔',
    sight: '瞄准镜',
    loaderHatch: '装填手舱盖',
    bustle: '尾部储物篮',
    frontShield: '前脸防盾',
    frontSlope: '前下斜板',
    frontHatch: '驾驶舱凸起',
    mgStation: '机枪站',
    returnRoller: '托带轮',
    toothedSprocket: '主动轮带齿',
    decal: '贴花',
    offset: '安装偏移',
    body: '炮塔主体',
    half: '尺寸',
  };
  return map[key] ?? key;
}

/**
 * 渲染树节点到 DOM
 */
export function renderTree(
  container: HTMLElement,
  nodes: TreeNode[],
  onSelect: (path: string[]) => void,
  activePath?: string[],
  depth = 0,
): void {
  container.innerHTML = '';
  for (const node of nodes) {
    const el = document.createElement('div');
    el.className = 'tree-node';

    if (node.isLeaf) {
      // 叶子节点
      const leaf = document.createElement('div');
      leaf.className = 'tree-leaf';
      if (activePath && pathsEqual(node.path, activePath)) leaf.classList.add('active');
      leaf.textContent = node.label;
      leaf.addEventListener('click', () => onSelect(node.path));
      el.appendChild(leaf);
    } else {
      // 分组节点(可展开)
      const group = document.createElement('div');
      group.className = 'tree-group';

      const label = document.createElement('div');
      label.className = 'tree-group-label';
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '▶';
      label.appendChild(arrow);
      label.appendChild(document.createTextNode(node.label));
      group.appendChild(label);

      const childrenContainer = document.createElement('div');
      childrenContainer.style.display = 'none';
      renderTree(childrenContainer, node.children, onSelect, activePath, depth + 1);
      group.appendChild(childrenContainer);

      let expanded = false;
      label.addEventListener('click', () => {
        expanded = !expanded;
        childrenContainer.style.display = expanded ? 'block' : 'none';
        arrow.classList.toggle('open', expanded);
        // 点击分组时同时更新属性面板，显示该组的所有子字段
        onSelect(node.path);
      });

      // 如果子节点中有活跃节点,自动展开此组
      if (activePath && pathStartsWith(activePath, node.path)) {
        expanded = true;
        childrenContainer.style.display = 'block';
        arrow.classList.add('open');
      }

      el.appendChild(group);
    }

    container.appendChild(el);
  }
}

function pathsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function pathStartsWith(path: string[], prefix: string[]): boolean {
  if (path.length < prefix.length) return false;
  return prefix.every((v, i) => v === path[i]);
}
