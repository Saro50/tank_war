"use strict";
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * check-glb.ts — glb 坦克资产套用前自检
 * ============================================================
 * 运行: npx tsx scripts/check-glb.ts [glb文件...] (默认扫 public/assets/*.glb)
 *
 * 目的:检测 glb 能否【直接套用】到 GltfTankAsset,并保证游戏内所有动作
 *      (炮塔旋转/炮管俯仰/开炮/移动/爆炸/焦黑等)正常运作。不修改任何游戏代码。
 *
 * 检测依据 = GltfTankAsset(GltfTankAsset.ts)的实际要求 + 各动作对模型的依赖:
 *  [A 直接套用门槛] 严格英文命名 Turret/Barrel/Muzzle(GltfTankAsset.findByName 大小写敏感)
 *  [B 动画驱动]     无 skin/骨骼(rotation 才有效) + pivot 在座圈/铰链(旋转不画弧)
 *  [C 单位尺寸]     米制(归一化会缩放,但量级要对)
 *  [D 材质]         PBR/MeshStandardMaterial(scorch 焦黑才能生效)
 *  [E 降级项]       履带独立UV(滚动)/Hull节点(车身摇晃) —— 不致命但丢效果
 *
 * 命名不符时,额外用中文节点(炮塔/炮管组)做"改名后可行性预判",
 * 让用户知道:改名 + 修 pivot 后能否套用。
 */
var node_fs_1 = require("node:fs");
var node_path_1 = require("node:path");
// ============================================================
// 检测基准(来自 src/entities/GltfTankAsset.ts 与 src/config.ts)
// ============================================================
/** GltfTankAsset.build() 实际查找的节点名(大小写敏感,见 GltfTankAsset.NODE) */
var STRICT = { turret: 'Turret', barrel: 'Barrel', muzzle: 'Muzzle' };
/** 各语义节点的别名(中英文),用于检测到近似命名时给改名提示。
 *  顺序即匹配优先级:精确中文优先,再英文变体。findSemanticApprox 按此查找。 */
var SEMANTIC_ALIASES = {
    Turret: ['炮塔', 'turret', 'tower', '炮塔组'],
    Barrel: ['炮管组', '炮管', '炮身', 'barrel', 'cannon', 'gun'],
    Muzzle: ['炮口', 'muzzle', '枪口'],
};
/** Blender 操作提示(给美术的速查;在脚本里就近输出,省去翻文档) */
var TIP = {
    /** 改名提示:Outliner 双击改名 */
    rename: function (from, to) { return "Outliner \u53CC\u51FB '".concat(from, "' \u2192 \u6539\u540D\u4E3A '").concat(to, "'"); },
    /** 新增 Muzzle Empty 的完整步骤 */
    addMuzzle: "\u70AE\u53E3\u52A0 Empty: Add \u2192 Empty \u2192 Plain Axes,\u653E\u70AE\u53E3\u6B63\u4E2D(\u7565\u51FA\u70AE\u53E3),\u547D\u540D 'Muzzle',Outliner \u62D6\u5230 Barrel \u4E0B",
    /** Barrel pivot 优化(消除俯仰小弧,可选) */
    barrelPivot: "\u53EF\u9009(\u6D88\u9664\u4FEF\u4EF0\u5C0F\u5F27): \u9009 Barrel \u2192 Shift+\u53F3\u952E \u653E 3D Cursor \u5230\u70AE\u7BA1\u6839\u90E8 \u2192 Object \u2192 Transform \u2192 Set Origin \u2192 Origin to 3D Cursor",
    /** 建立父子关系 */
    reparent: function (child, parent) { return "Outliner \u628A '".concat(child, "' \u62D6\u5230 '").concat(parent, "' \u4E0B(\u6216\u9009\u4E2D ").concat(child, " \u2192 Shift \u9009\u4E2D ").concat(parent, " \u2192 Ctrl+P)"); },
};
/** 玩家 T14 物理碰撞体尺寸(来自 config.ts bodyHalf×2,GltfTankAsset 按此归一化) */
var REF_SIZE = { x: 2.6, y: 1.56, z: 4.3 };
/** pivot 判定阈值(米) */
var PIVOT_OK = 0.2; // origin 距包围盒 < 此值 = 在几何上
var PIVOT_FAIL = 0.3; // > 此值 = 在几何外(画弧)
/** 解析 glb 二进制,提取 JSON chunk(glb=12字节header + chunk(JSON) + chunk(BIN)) */
function parseGlb(file) {
    var buf = node_fs_1.default.readFileSync(file);
    var magic = buf.toString('ascii', 0, 4);
    if (magic !== 'glTF')
        throw new Error("".concat(file, " \u4E0D\u662F\u5408\u6CD5 glb(magic=").concat(magic, ")"));
    var jsonLen = buf.readUInt32LE(12);
    return JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
}
/** 递归算每个节点的世界 translation(累加父级)。遇到非单位 rotation/scale 标记(影响精度) */
function worldTranslations(gltf) {
    var nodes = gltf.nodes || [];
    var wt = nodes.map(function () { return ({ x: 0, y: 0, z: 0 }); });
    var hasComplex = false;
    var roots = nodes
        .map(function (_, i) { return i; })
        .filter(function (i) { return !nodes.some(function (o) { return (o.children || []).includes(i); }); });
    var visit = function (idx, parent) {
        var n = nodes[idx];
        var t = n.translation || [0, 0, 0];
        var w = { x: parent.x + t[0], y: parent.y + t[1], z: parent.z + t[2] };
        wt[idx] = w;
        // 检测非单位旋转/缩放(会让"纯translation累加"近似失效)
        if (n.rotation && !isIdentityQuat(n.rotation))
            hasComplex = true;
        if (n.scale && !isUnitScale(n.scale))
            hasComplex = true;
        for (var _i = 0, _a = n.children || []; _i < _a.length; _i++) {
            var c_1 = _a[_i];
            visit(c_1, w);
        }
    };
    roots.forEach(function (r) { return visit(r, { x: 0, y: 0, z: 0 }); });
    return { wt: wt, hasComplex: hasComplex };
}
function isIdentityQuat(q) {
    return Math.abs(q[0]) < 1e-6 && Math.abs(q[1]) < 1e-6 && Math.abs(q[2]) < 1e-6 && Math.abs(q[3] - 1) < 1e-6;
}
function isUnitScale(s) {
    return Math.abs(s[0] - 1) < 1e-6 && Math.abs(s[1] - 1) < 1e-6 && Math.abs(s[2] - 1) < 1e-6;
}
/** 节点的子树包围盒(合并所有 mesh 的 POSITION accessor min/max + 世界 translation) */
function subtreeBBox(gltf, rootIdx, wt) {
    var _a;
    var nodes = gltf.nodes || [];
    var min = { x: Infinity, y: Infinity, z: Infinity };
    var max = { x: -Infinity, y: -Infinity, z: -Infinity };
    var has = false;
    var stack = [rootIdx];
    while (stack.length) {
        var i = stack.pop();
        var n = nodes[i];
        if (n.mesh !== undefined && gltf.meshes && gltf.accessors) {
            var prim = (_a = gltf.meshes[n.mesh]) === null || _a === void 0 ? void 0 : _a.primitives[0];
            var acc = prim && gltf.accessors[prim.attributes.POSITION];
            if (acc && acc.min && acc.max) {
                var w = wt[i];
                min.x = Math.min(min.x, acc.min[0] + w.x);
                min.y = Math.min(min.y, acc.min[1] + w.y);
                min.z = Math.min(min.z, acc.min[2] + w.z);
                max.x = Math.max(max.x, acc.max[0] + w.x);
                max.y = Math.max(max.y, acc.max[1] + w.y);
                max.z = Math.max(max.z, acc.max[2] + w.z);
                has = true;
            }
        }
        for (var _i = 0, _b = n.children || []; _i < _b.length; _i++) {
            var c_2 = _b[_i];
            stack.push(c_2);
        }
    }
    return has ? { min: min, max: max } : null;
}
/** 点到包围盒最近点距离(0=在盒内) */
function distPointBBox(p, b) {
    var cx = Math.max(b.min.x, Math.min(p.x, b.max.x));
    var cy = Math.max(b.min.y, Math.min(p.y, b.max.y));
    var cz = Math.max(b.min.z, Math.min(p.z, b.max.z));
    return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}
var bboxSize = function (b) { return ({ x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z }); };
var bboxCenter = function (b) { return ({ x: (b.min.x + b.max.x) / 2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 }); };
// ============================================================
// 报告输出
// ============================================================
var c = {
    red: function (s) { return "\u001B[31m".concat(s, "\u001B[0m"); },
    green: function (s) { return "\u001B[32m".concat(s, "\u001B[0m"); },
    yellow: function (s) { return "\u001B[33m".concat(s, "\u001B[0m"); },
    cyan: function (s) { return "\u001B[36m".concat(s, "\u001B[0m"); },
    dim: function (s) { return "\u001B[2m".concat(s, "\u001B[0m"); },
    bold: function (s) { return "\u001B[1m".concat(s, "\u001B[0m"); },
};
var PASS = c.green('✓');
var FAIL = c.red('✗');
var WARN = c.yellow('⚠');
/** 检测单个 glb */
function check(file, gltf) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l, _m;
    var result = { pass: true, fatal: [], degraded: [], fixes: [] };
    var nodes = gltf.nodes || [];
    var stat = node_fs_1.default.statSync(file);
    console.log(c.bold("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 ".concat(node_path_1.default.basename(file), " \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550")));
    console.log(c.dim("\u4F53\u79EF ".concat((stat.size / 1024).toFixed(0), "KB | meshes ").concat((_b = (_a = gltf.meshes) === null || _a === void 0 ? void 0 : _a.length) !== null && _b !== void 0 ? _b : 0, " | materials ").concat((_d = (_c = gltf.materials) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0)));
    // —— [A] 直接套用门槛:严格英文命名 + 层级 + Muzzle Empty ——
    console.log(c.bold("\n[A] \u76F4\u63A5\u5957\u7528\u95E8\u69DB(".concat(c.dim('GltfTankAsset 严格英文命名,大小写敏感'), ")")));
    var findStrict = function (name) { return nodes.findIndex(function (n) { return n.name === name; }); };
    var tIdx = findStrict(STRICT.turret);
    var bIdx = findStrict(STRICT.barrel);
    var mIdx = findStrict(STRICT.muzzle);
    // 提示输出辅助:在检测结果下方紧跟一行 Blender 操作建议(青色 💡)
    var tip = function (s) { return console.log("              ".concat(c.cyan('💡 ' + s))); };
    var strictOk = true;
    // Turret
    if (tIdx < 0) {
        strictOk = false;
        result.fatal.push('缺 Turret 节点 → 炮塔旋转/开炮方向/炮口焰/击毁炸炮塔 全部失效');
        console.log("    Turret : ".concat(FAIL, " \u672A\u627E\u5230").concat(c.dim('  → 炮塔旋转/开炮方向/炮口焰/炸炮塔')));
        var approx = findSemanticApprox(nodes, 'Turret');
        if (approx) {
            var t = TIP.rename(approx.name, 'Turret');
            tip(t);
            result.fixes.push(t);
        }
        else {
            tip("需有名为 'Turret' 的对象(炮塔主体,绕 Y 旋转)");
        }
    }
    else {
        console.log("    Turret : ".concat(PASS, " \u627E\u5230 #").concat(tIdx));
    }
    // Barrel(须在 Turret 子树)
    if (bIdx < 0) {
        strictOk = false;
        result.fatal.push('缺 Barrel 节点 → 炮管俯仰/后坐力/抛物线瞄准 失效');
        console.log("    Barrel : ".concat(FAIL, " \u672A\u627E\u5230").concat(c.dim('  → 炮管俯仰/后坐力/瞄准')));
        var approx = findSemanticApprox(nodes, 'Barrel');
        if (approx) {
            var t = TIP.rename(approx.name, 'Barrel');
            tip(t);
            result.fixes.push(t);
        }
        else {
            tip("需有名为 'Barrel' 的对象(炮管组,绕 X 俯仰)");
        }
    }
    else if (tIdx >= 0 && !isDescendant(nodes, bIdx, tIdx)) {
        strictOk = false;
        result.fatal.push('Barrel 不在 Turret 子树 → 层级不符');
        console.log("    Barrel : ".concat(WARN, " \u627E\u5230\u4F46\u4E0D\u5728 Turret \u5B50\u6811(\u5C42\u7EA7\u4E0D\u7B26)"));
        var t = TIP.reparent('Barrel', 'Turret');
        tip(t);
        result.fixes.push(t);
    }
    else {
        console.log("    Barrel : ".concat(PASS, " \u627E\u5230 #").concat(bIdx));
    }
    // Muzzle(须在 Barrel 子树 + 是 Empty)
    if (mIdx < 0) {
        strictOk = false;
        result.fatal.push('缺 Muzzle 节点 → 开炮位置/炮弹方向/炮口焰 错位');
        console.log("    Muzzle : ".concat(FAIL, " \u672A\u627E\u5230").concat(c.dim('  → 开炮位置/炮弹方向/炮口焰')));
        var approx = findSemanticApprox(nodes, 'Muzzle');
        // 统一建议【新增 Empty】,不推荐改现有 mesh 名(会破坏炮口装置等视觉部件)。
        // 检测到炮口附近 mesh 时,提示参考其位置放 Empty。
        var hint = approx
            ? "\u53C2\u8003 '".concat(approx.name, "' \u7684\u4F4D\u7F6E,").concat(TIP.addMuzzle)
            : TIP.addMuzzle;
        tip(hint);
        result.fixes.push(hint);
    }
    else {
        var mn = nodes[mIdx];
        var isEmpty = mn.mesh === undefined;
        if (!isEmpty) {
            result.degraded.push('Muzzle 是 mesh(建议改 Empty,不影响位置取值)');
            console.log("    Muzzle : ".concat(WARN, " \u627E\u5230\u4F46\u662F mesh(\u5EFA\u8BAE\u6539 Empty)"));
        }
        else if (bIdx >= 0 && !isDescendant(nodes, mIdx, bIdx)) {
            strictOk = false;
            result.fatal.push('Muzzle 不在 Barrel 子树 → 层级不符');
            console.log("    Muzzle : ".concat(WARN, " \u627E\u5230\u4F46\u4E0D\u5728 Barrel \u5B50\u6811(\u5C42\u7EA7\u4E0D\u7B26)"));
            var t = TIP.reparent('Muzzle', 'Barrel');
            tip(t);
            result.fixes.push(t);
        }
        else {
            console.log("    Muzzle : ".concat(PASS, " Empty #").concat(mIdx));
        }
    }
    console.log("    ".concat(c.bold('直接套用结论'), ": ").concat(strictOk ? PASS + ' 命名/层级通过' : FAIL + ' 失败(命名或层级不符)'));
    // —— [B] 动画驱动有效性(改名后预判:用中文节点或已找到的英文节点) ——
    console.log(c.bold("\n[B] \u52A8\u753B\u9A71\u52A8\u6709\u6548\u6027".concat(c.dim('(改名后预判:用中文/已找到的炮塔节点'), ")")));
    // 骨骼
    var skins = (_f = (_e = gltf.skins) === null || _e === void 0 ? void 0 : _e.length) !== null && _f !== void 0 ? _f : 0;
    var skinnedNodes = nodes.filter(function (n) { return n.skin !== undefined; }).length;
    if (skins > 0 || skinnedNodes > 0) {
        result.fatal.push("\u542B\u9AA8\u9ABC(skins:".concat(skins, ", skin\u8282\u70B9:").concat(skinnedNodes, ") \u2192 rotation \u65E0\u6CD5\u9A71\u52A8\u7F51\u683C"));
        console.log("    \u9AA8\u9ABC   : ".concat(FAIL, " \u6709 skins:").concat(skins, " skinNodes:").concat(skinnedNodes, " ").concat(c.dim('→ rotation 无效,炮塔转不动')));
    }
    else {
        console.log("    \u9AA8\u9ABC   : ".concat(PASS, " \u65E0 ").concat(c.dim('→ rotation 驱动有效')));
    }
    // 动画
    var anims = (_h = (_g = gltf.animations) === null || _g === void 0 ? void 0 : _g.length) !== null && _h !== void 0 ? _h : 0;
    if (anims > 0) {
        result.degraded.push("\u542B ".concat(anims, " \u4E2A\u52A8\u753B(GltfTankAsset \u4E0D\u64AD\u653E,\u9759\u6001)"));
        console.log("    \u52A8\u753B   : ".concat(WARN, " \u6709 ").concat(anims, " \u4E2A(GltfTankAsset \u4E0D\u64AD\u653E)"));
    }
    else {
        console.log("    \u52A8\u753B   : ".concat(PASS, " \u65E0"));
    }
    // pivot 检测:优先用严格英文,否则用别名近似节点(中文等)
    var _o = worldTranslations(gltf), wt = _o.wt, hasComplex = _o.hasComplex;
    var turretNodeIdx = tIdx >= 0 ? tIdx : (_k = (_j = findSemanticApprox(nodes, 'Turret')) === null || _j === void 0 ? void 0 : _j.idx) !== null && _k !== void 0 ? _k : -1;
    var barrelNodeIdx = bIdx >= 0 ? bIdx : (_m = (_l = findSemanticApprox(nodes, 'Barrel')) === null || _l === void 0 ? void 0 : _l.idx) !== null && _m !== void 0 ? _m : -1;
    // Turret pivot
    if (turretNodeIdx >= 0) {
        var o = wt[turretNodeIdx];
        var bb = subtreeBBox(gltf, turretNodeIdx, wt);
        var nodeName = nodes[turretNodeIdx].name;
        if (bb) {
            var d = distPointBBox(o, bb);
            var size = bboxSize(bb);
            var detail = "".concat(c.dim('origin='), "[").concat(o.x.toFixed(2), ",").concat(o.y.toFixed(2), ",").concat(o.z.toFixed(2), "] ").concat(c.dim('距包围盒')).concat(d.toFixed(2), "m");
            if (d > PIVOT_FAIL) {
                result.fatal.push("Turret(".concat(nodeName, ") pivot \u9519\u4F4D:origin \u8DDD\u51E0\u4F55 ").concat(d.toFixed(2), "m(\u5728\u51E0\u4F55\u5916) \u2192 \u65CB\u8F6C\u753B\u5F27\u7529\u98DE"));
                console.log("    Turret pivot : ".concat(FAIL, " ").concat(detail, "\n").concat(' '.repeat(22)).concat(c.dim('几何 Y[' + bb.min.y.toFixed(2) + '~' + bb.max.y.toFixed(2) + '] → 旋转中心应在此范围(座圈)')));
            }
            else if (o.y > bb.min.y + size.y * 0.5) {
                result.degraded.push('Turret pivot 偏上(建议设在座圈=几何底部)');
                console.log("    Turret pivot : ".concat(WARN, " ").concat(detail, " ").concat(c.dim('(origin 偏上,建议下移到座圈)')));
            }
            else {
                console.log("    Turret pivot : ".concat(PASS, " ").concat(detail, " ").concat(c.dim('(在座圈附近)')));
            }
        }
    }
    else {
        console.log("    Turret pivot : ".concat(c.dim('— 无炮塔节点可预判')));
    }
    // Barrel pivot
    if (barrelNodeIdx >= 0) {
        var o = wt[barrelNodeIdx];
        var bb = subtreeBBox(gltf, barrelNodeIdx, wt);
        var nodeName = nodes[barrelNodeIdx].name;
        if (bb) {
            var d = distPointBBox(o, bb);
            var size = bboxSize(bb);
            var detail = "".concat(c.dim('origin='), "[").concat(o.x.toFixed(2), ",").concat(o.y.toFixed(2), ",").concat(o.z.toFixed(2), "] ").concat(c.dim('距包围盒')).concat(d.toFixed(2), "m");
            if (d > PIVOT_FAIL) {
                result.fatal.push("Barrel(".concat(nodeName, ") pivot \u9519\u4F4D:origin \u8DDD\u51E0\u4F55 ").concat(d.toFixed(2), "m \u2192 \u4FEF\u4EF0\u7A9C\u52A8"));
                console.log("    Barrel pivot : ".concat(FAIL, " ").concat(detail, "\n").concat(' '.repeat(22)).concat(c.dim('→ 俯仰会大幅窜动,应在炮管根部铰链')));
            }
            else {
                // 检查是否在长轴端点(根部)
                var longAxis = size.x >= size.y && size.x >= size.z ? 'x' : size.z >= size.y ? 'z' : 'y';
                var atEnd = Math.min(Math.abs(o[longAxis] - bb.min[longAxis]), Math.abs(o[longAxis] - bb.max[longAxis])) < 0.3;
                if (!atEnd) {
                    result.degraded.push('Barrel pivot 在炮管中部(建议设在根部端点)');
                    console.log("    Barrel pivot : ".concat(WARN, " ").concat(detail, " ").concat(c.dim('(在炮管中部,俯仰画小弧)')));
                    result.fixes.push(TIP.barrelPivot);
                }
                else {
                    console.log("    Barrel pivot : ".concat(PASS, " ").concat(detail, " ").concat(c.dim('(在根部铰链)')));
                }
            }
        }
    }
    else {
        console.log("    Barrel pivot : ".concat(c.dim('— 无炮管节点可预判')));
    }
    if (hasComplex) {
        result.degraded.push('节点含非单位 rotation/scale(pivot 精度为近似,建议人工复核)');
        console.log("    ".concat(c.dim('注: 检测到非单位 rotation/scale,pivot 判定为近似')));
    }
    // —— [C] 单位尺寸 ——
    console.log(c.bold("\n[C] \u5355\u4F4D/\u5C3A\u5BF8"));
    var full = subtreeBBox(gltf, nodes.findIndex(function (_, i) { return !nodes.some(function (o) { return (o.children || []).includes(i); }); }), wt);
    if (full) {
        var s = bboxSize(full);
        var maxDim = Math.max(s.x, s.y, s.z);
        var isMetric = maxDim < 20;
        console.log("    \u5305\u56F4\u76D2 ".concat(s.x.toFixed(2), "\u00D7").concat(s.y.toFixed(2), "\u00D7").concat(s.z.toFixed(2), " m ").concat(isMetric ? PASS + ' 米级' : WARN + ' 疑似非米制(归一化会缩放)'));
        if (!isMetric)
            result.degraded.push('包围盒非米级量级(归一化会修正,但建议导出时设米制)');
        // 对照玩家 T14 物理体(仅 t14 类对照)
        console.log(c.dim("    \u5BF9\u7167 T14 \u7269\u7406\u4F53 ".concat(REF_SIZE.x, "\u00D7").concat(REF_SIZE.y, "\u00D7").concat(REF_SIZE.z, " (GltfTankAsset \u6309 Z \u5F52\u4E00\u5316\u5BF9\u9F50)")));
    }
    // —— [D] 材质 ——
    console.log(c.bold("\n[D] \u6750\u8D28(scorch \u7126\u9ED1\u751F\u6548\u8981\u6C42)"));
    var mats = gltf.materials || [];
    var pbrCount = mats.filter(function (m) { return m.pbrMetallicRoughness !== undefined; }).length;
    if (pbrCount === mats.length && mats.length > 0) {
        console.log("    ".concat(PASS, " ").concat(mats.length, " \u4E2A PBR \u6750\u8D28 ").concat(c.dim('→ 焦黑/受击生效')));
    }
    else {
        result.degraded.push("\u4EC5 ".concat(pbrCount, "/").concat(mats.length, " \u6750\u8D28\u542B PBR(\u7126\u9ED1\u53EF\u80FD\u4E0D\u5B8C\u6574)"));
        console.log("    ".concat(WARN, " ").concat(pbrCount, "/").concat(mats.length, " \u542B PBR"));
    }
    // —— [E] 降级项 ——
    console.log(c.bold("\n[E] \u964D\u7EA7\u9879".concat(c.dim('(不致命但丢效果)'))));
    // 履带独立UV:glb 烘焙死的无法滚动(GltfTank.updateTracks 空转)
    console.log("    \u5C65\u5E26\u6EDA\u52A8 : ".concat(WARN, " glb \u5C65\u5E26\u4E3A\u70D8\u7119\u8D34\u56FE ").concat(c.dim('→ 履带滚动将失效(GltfTank 已空转处理)')));
    result.degraded.push('履带滚动失效(glb 烘焙贴图,GltfTank.updateTracks 已空转)');
    // Hull 节点(车身摇晃)
    var hasHull = nodes.some(function (n) { return n.name === 'Hull' || n.name === '车身'; });
    if (hasHull) {
        console.log("    \u8F66\u8EAB\u6447\u6643 : ".concat(PASS, " \u6709 Hull/\u8F66\u8EAB \u8282\u70B9 ").concat(c.dim('(可作 hullSway pivot)')));
    }
    else {
        console.log("    \u8F66\u8EAB\u6447\u6643 : ".concat(WARN, " \u65E0 Hull \u8282\u70B9 ").concat(c.dim('→ 车身摇晃将失效')));
        result.degraded.push('车身摇晃失效(无 Hull 节点)');
    }
    result.pass = strictOk && result.fatal.length === 0;
    return result;
}
/** b 是否为 a 的后代(含间接) */
function isDescendant(nodes, b, a) {
    var n = nodes[a];
    for (var _i = 0, _a = n.children || []; _i < _a.length; _i++) {
        var c_3 = _a[_i];
        if (c_3 === b)
            return true;
        if (isDescendant(nodes, b, c_3))
            return true;
    }
    return false;
}
/**
 * 查找语义节点的近似命名(给改名提示用)。
 * ------------------------------------------------------------
 * 按 SEMANTIC_ALIASES 顺序匹配:先精确名(大小写敏感),再包含匹配(大小写不敏感)。
 * 用途:严格英文名未找到时,检测是否有中文/变体名,提示美术"把 X 改成 Y"。
 * 返回首个匹配 {idx, name};无匹配返回 null。
 */
function findSemanticApprox(nodes, semantic) {
    var _a;
    if (!nodes)
        return null;
    var aliases = SEMANTIC_ALIASES[semantic];
    var _loop_1 = function (alias) {
        var idx = nodes.findIndex(function (n) { return n.name === alias; });
        if (idx >= 0)
            return { value: { idx: idx, name: alias } };
    };
    // 先精确匹配(大小写敏感)
    for (var _i = 0, aliases_1 = aliases; _i < aliases_1.length; _i++) {
        var alias = aliases_1[_i];
        var state_1 = _loop_1(alias);
        if (typeof state_1 === "object")
            return state_1.value;
    }
    // 再包含匹配(大小写不敏感;跳过已是严格名的节点,避免误报)
    for (var i = 0; i < nodes.length; i++) {
        var name_1 = (_a = nodes[i].name) !== null && _a !== void 0 ? _a : '';
        if (!name_1 || name_1 === semantic)
            continue;
        var lower = name_1.toLowerCase();
        for (var _b = 0, aliases_2 = aliases; _b < aliases_2.length; _b++) {
            var alias = aliases_2[_b];
            if (alias.length >= 2 && lower.includes(alias.toLowerCase()))
                return { idx: i, name: name_1 };
        }
    }
    return null;
}
// ============================================================
// main
// ============================================================
function main() {
    var args = process.argv.slice(2);
    var files = args.length > 0 ? args : node_fs_1.default.readdirSync('public/assets').filter(function (f) { return f.endsWith('.glb'); }).map(function (f) { return "public/assets/".concat(f); });
    if (files.length === 0) {
        console.log(c.yellow('未找到 glb 文件(默认扫 public/assets/*.glb,或传参指定)'));
        return;
    }
    console.log(c.bold("\u68C0\u6D4B ".concat(files.length, " \u4E2A glb \u6587\u4EF6:")));
    var allFatal = {};
    var allDegraded = {};
    var allFixes = {};
    for (var _i = 0, files_1 = files; _i < files_1.length; _i++) {
        var f = files_1[_i];
        try {
            var r = check(f, parseGlb(f));
            allFatal[f] = r.fatal;
            allDegraded[f] = r.degraded;
            allFixes[f] = r.fixes;
        }
        catch (e) {
            console.log(c.red("\n\u2550\u2550\u2550 ".concat(f, " \u2550\u2550\u2550\n  \u89E3\u6790\u5931\u8D25: ").concat(e.message)));
            allFatal[f] = ['glb 解析失败'];
            allFixes[f] = [];
        }
    }
    // —— 总结 ——
    console.log(c.bold("\n\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550 \u603B\u7ED3 \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550"));
    for (var _a = 0, files_2 = files; _a < files_2.length; _a++) {
        var f = files_2[_a];
        var fatal = allFatal[f] || [];
        var deg = allDegraded[f] || [];
        var fixes = __spreadArray([], new Set(allFixes[f] || []), true); // 去重(同一提示可能多次收集)
        var ok = fatal.length === 0;
        console.log("\n".concat(node_path_1.default.basename(f), ": ").concat(ok ? c.green('✓ 可直接套用') : c.red('✗ 不能直接套用')));
        if (fatal.length > 0) {
            console.log(c.red("  \u81F4\u547D\u95EE\u9898(\u5BFC\u81F4\u52A8\u4F5C\u5931\u6548):"));
            fatal.forEach(function (x) { return console.log(c.red("    \u2022 ".concat(x))); });
        }
        if (fixes.length > 0) {
            console.log(c.cyan("  \uD83D\uDCDD \u7F8E\u672F\u4FEE\u6539\u6E05\u5355(Blender):"));
            fixes.forEach(function (x, i) { return console.log(c.cyan("    ".concat(i + 1, ". ").concat(x))); });
        }
        if (deg.length > 0) {
            console.log(c.yellow("  \u964D\u7EA7(\u80FD\u8DD1\u4F46\u4E22\u6548\u679C):"));
            deg.forEach(function (x) { return console.log(c.yellow("    \u2022 ".concat(x))); });
        }
        if (ok && deg.length === 0)
            console.log(c.green('  所有动作正常,无降级'));
    }
}
main();
