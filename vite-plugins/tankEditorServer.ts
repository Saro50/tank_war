/**
 * tankEditorServer.ts — 编辑器后台(vite dev server 插件)
 * ============================================================
 * 在 dev server 上挂载 REST API,供编辑器前端读写坦克 JSON 数据。
 * 仅 dev 模式工作(configureServer 钩子不影响生产构建)。
 *
 * 工作流("生产 → 审查 → 采纳"):
 *  - 编辑器保存 → PUT 写到 editor-dist/tanks/*.json(产物区,不影响游戏)
 *  - 读取优先 editor-dist(继续上次编辑),回退 public/tanks(游戏基准)
 *  - 开发者手动把 editor-dist 的 JSON 拷到 public/tanks(采纳,由人决定)
 *
 * 安全:
 *  - variant 白名单(防路径遍历,只允许 t14/tiger/abrams)
 *  - PUT 时后台 zod schema 校验(前端可绕,但非法数据进不来)
 *
 * API:
 *  GET  /api/tanks            → { variants: ['t14','tiger','abrams'] }
 *  GET  /api/tanks/:variant   → JSON 数据(Header X-Data-Source 标注来源)
 *  PUT  /api/tanks/:variant   → 写入 editor-dist(body=JSON,需通过 schema)
 */
import type { Plugin } from 'vite';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'fs';
import { resolve, sep } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { TANK_VARIANTS, TankSchemaByVariant, TankModelSchema, type TankVariant, type TankModel } from '../src/data/TankSchema';
import { blankTemplate, fromOfficial } from '../src/editor/templates';

/** 编辑器产物区(后台写入,开发者手动采纳到 public) */
const EDITOR_DIST_DIR = resolve(process.cwd(), 'editor-dist/tanks');
/** 游戏采纳的数据区(A 阶段生成的基准 JSON) */
const PUBLIC_DIR = resolve(process.cwd(), 'public/tanks');

/** variant 白名单校验(防路径遍历) */
function isVariant(v: string): v is TankVariant {
  return (TANK_VARIANTS as readonly string[]).includes(v);
}

/** 读取请求 body(PUT 用) */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((bodyResolve, bodyReject) => {
    let data = '';
    req.on('data', (chunk: Buffer | string) => {
      data += chunk.toString();
    });
    req.on('end', () => bodyResolve(data));
    req.on('error', bodyReject);
  });
}

/** JSON 响应快捷方法 */
function jsonRes(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * 编辑器后台插件。
 * 挂载 /api/tanks* 的 middleware,处理读写请求;其他请求放行给 vite。
 */
export function tankEditorServer(): Plugin {
  return {
    name: 'tank-editor-server',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        // 处理 /api/tanks(官方) + /api/custom-tanks(自定义),其他放行给 vite
        const isTankApi = path === '/api/tanks' || path.startsWith('/api/tanks/') ||
                          path === '/api/custom-tanks' || path.startsWith('/api/custom-tanks/');
        if (!isTankApi) {
          next();
          return;
        }
        try {
          await handleApi(req, res, path);
        } catch (e) {
          // 永不静默失败:未预期异常返回 500 + 错误信息
          jsonRes(res, 500, { error: 'internal', message: String(e) });
        }
      });
      console.info('[tank-editor-server] API ready: GET/PUT /api/tanks/:variant');
    },
  };
}

/** 处理 API 请求(已确定 path 以 /api/tanks 开头) */
async function handleApi(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  // 自定义坦克路由组(优先匹配,避免与 /api/tanks 的 segs 解析冲突)
  if (path === '/api/custom-tanks' || path.startsWith('/api/custom-tanks/')) {
    await handleCustomTanks(req, res, path);
    return;
  }

  const segs = path.split('/').filter(Boolean); // ['api','tanks'] 或 ['api','tanks','t14']
  const method = req.method ?? 'GET';

  // GET /api/tanks → 列出车型
  if (segs.length === 2 && method === 'GET') {
    jsonRes(res, 200, { variants: [...TANK_VARIANTS] });
    return;
  }

  // GET/PUT /api/tanks/:variant
  if (segs.length === 3) {
    const variant = segs[2];
    if (!isVariant(variant)) {
      jsonRes(res, 400, { error: `unknown variant: ${variant}` });
      return;
    }
    if (method === 'GET') {
      handleGet(variant, res);
      return;
    }
    if (method === 'PUT') {
      await handlePut(variant, req, res);
      return;
    }
    // 其他 method 不支持
    jsonRes(res, 405, { error: `method ${method} not allowed` });
    return;
  }

  // 未匹配的路由
  jsonRes(res, 404, { error: 'not found', path });
}

/** GET:读 editor-dist(编辑产物)优先,回退 public(游戏基准) */
function handleGet(variant: TankVariant, res: ServerResponse): void {
  const editorPath = resolve(EDITOR_DIST_DIR, `${variant}.json`);
  const publicPath = resolve(PUBLIC_DIR, `${variant}.json`);
  const fromEditor = existsSync(editorPath);
  const filePath = fromEditor ? editorPath : publicPath;
  if (!existsSync(filePath)) {
    jsonRes(res, 404, { error: `${variant} json not found in editor-dist or public` });
    return;
  }
  const content = readFileSync(filePath, 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // 来源标注:前端可据此提示"这是编辑器产物,未采纳到游戏"
  res.setHeader('X-Data-Source', fromEditor ? 'editor-dist' : 'public');
  res.end(content);
}

/** PUT:校验 schema 后写入 editor-dist */
async function handlePut(variant: TankVariant, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    jsonRes(res, 400, { error: 'invalid JSON body' });
    return;
  }
  // 后台 schema 校验(双重保险:前端校验可绕,后台不可绕)
  const schema = TankSchemaByVariant[variant];
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    jsonRes(res, 400, {
      error: 'schema validation failed',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return;
  }
  // 写入 editor-dist(确保目录存在)
  mkdirSync(EDITOR_DIST_DIR, { recursive: true });
  const outPath = resolve(EDITOR_DIST_DIR, `${variant}.json`);
  // 用 parsed.data(校验后的干净数据,去掉多余字段),格式化 + 换行结尾
  writeFileSync(outPath, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
  console.info(`[tank-editor-server] saved ${variant} → editor-dist/tanks/${variant}.json`);
  jsonRes(res, 200, { ok: true, variant, path: `editor-dist/tanks/${variant}.json` });
}

// ============================================================
// 自定义坦克 CRUD(/api/custom-tanks*)
// ============================================================
// 自定义坦克存 editor-dist/tanks/custom-*.json(与官方旧 JSON 前缀隔离)。
// id 规则:custom-<base36时间戳>,后台生成(防前端冲突)。
// 安全三重防御:① 正则白名单 ② resolve 后校验在目录内 ③ 拒绝 ..。

const CUSTOM_ID_RE = /^custom-[a-z0-9-]{1,40}$/;

/** 校验自定义 id 合法(正则白名单,防路径遍历) */
function isCustomId(id: string): boolean {
  return CUSTOM_ID_RE.test(id);
}

/** 拼自定义 JSON 路径 + 防御:resolve 后必须仍在 EDITOR_DIST_DIR 内(防 ../) */
function customFilePath(id: string): string {
  const p = resolve(EDITOR_DIST_DIR, `${id}.json`);
  const root = EDITOR_DIST_DIR + sep;
  if (!p.startsWith(root)) {
    throw new Error(`path traversal detected: ${id}`);
  }
  return p;
}

/** 生成唯一自定义 id(custom-<base36时间戳>,冲突时加随机后缀) */
function generateCustomId(): string {
  let id = 'custom-' + Date.now().toString(36);
  while (existsSync(customFilePath(id))) {
    id = 'custom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
  }
  return id;
}

/** 提取列表元数据(只取 id/name/parts 数/质量/静态,避免读全文) */
function customListMeta(filePath: string): { id: string; name: string; partsCount: number; mass: number; isStatic: boolean } | null {
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    return {
      id: raw.id,
      name: raw.name,
      partsCount: raw.parts?.length ?? 0,
      mass: raw.mass ?? 0,
      isStatic: raw.isStatic ?? false,
    };
  } catch {
    return null; // 损坏文件跳过(列表扫描容忍单个坏文件,不阻断整体)
  }
}

/** 处理 /api/custom-tanks* 路由组 */
async function handleCustomTanks(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const segs = path.split('/').filter(Boolean); // ['api','custom-tanks'] 或 ['api','custom-tanks','custom-xxx']
  const method = req.method ?? 'GET';

  // GET /api/custom-tanks → 列表(扫描目录 custom-*.json)
  if (segs.length === 2 && method === 'GET') {
    mkdirSync(EDITOR_DIST_DIR, { recursive: true });
    const files = readdirSync(EDITOR_DIST_DIR).filter((f) => f.startsWith('custom-') && f.endsWith('.json'));
    const tanks = files
      .map((f) => customListMeta(resolve(EDITOR_DIST_DIR, f)))
      .filter((m): m is NonNullable<typeof m> => m !== null);
    jsonRes(res, 200, { tanks });
    return;
  }

  // POST /api/custom-tanks → 新建(生成 id + 初始 model)
  if (segs.length === 2 && method === 'POST') {
    await handleCustomCreate(req, res);
    return;
  }

  // /api/custom-tanks/:id
  if (segs.length === 3) {
    const id = segs[2];
    if (!isCustomId(id)) {
      jsonRes(res, 400, { error: `invalid custom id: ${id}` });
      return;
    }
    if (method === 'GET') {
      handleCustomGet(id, res);
      return;
    }
    if (method === 'PUT') {
      await handleCustomPut(id, req, res);
      return;
    }
    if (method === 'DELETE') {
      handleCustomDelete(id, res);
      return;
    }
    jsonRes(res, 405, { error: `method ${method} not allowed` });
    return;
  }

  jsonRes(res, 404, { error: 'not found', path });
}

/** GET 单个:读 custom-*.json */
function handleCustomGet(id: string, res: ServerResponse): void {
  const fp = customFilePath(id);
  if (!existsSync(fp)) {
    jsonRes(res, 404, { error: `${id} not found` });
    return;
  }
  const content = readFileSync(fp, 'utf8');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Data-Source', 'editor-dist');
  res.end(content);
}

/** POST 新建:body={name, basedOn?} → 生成 id + 初始 model → 返回 id */
async function handleCustomCreate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: { name?: string; basedOn?: TankVariant };
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonRes(res, 400, { error: 'invalid JSON body' });
    return;
  }
  const name = parsed.name?.trim();
  if (!name) {
    jsonRes(res, 400, { error: 'name required' });
    return;
  }
  // 初始 model:basedOn 指定官方车型复制,否则空白模板
  let model: TankModel;
  try {
    model = parsed.basedOn ? fromOfficial(parsed.basedOn) : blankTemplate(name);
  } catch (e) {
    jsonRes(res, 500, { error: 'template generation failed', message: String(e) });
    return;
  }
  model.name = name;
  model.id = generateCustomId();
  // schema 校验(模板应合法,防御)
  const validated = TankModelSchema.safeParse(model);
  if (!validated.success) {
    jsonRes(res, 500, {
      error: 'template schema invalid',
      issues: validated.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return;
  }
  mkdirSync(EDITOR_DIST_DIR, { recursive: true });
  writeFileSync(customFilePath(model.id), JSON.stringify(validated.data, null, 2) + '\n', 'utf8');
  console.info(`[tank-editor-server] created custom tank ${model.id} (${name})`);
  jsonRes(res, 200, { id: model.id, name });
}

/** PUT 保存:schema 校验后写盘(URL id 不可被 body 篡改) */
async function handleCustomPut(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    jsonRes(res, 400, { error: 'invalid JSON body' });
    return;
  }
  const parsed = TankModelSchema.safeParse(data);
  if (!parsed.success) {
    jsonRes(res, 400, {
      error: 'schema validation failed',
      issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    });
    return;
  }
  const validated = { ...parsed.data, id }; // 强制 id 一致
  mkdirSync(EDITOR_DIST_DIR, { recursive: true });
  writeFileSync(customFilePath(id), JSON.stringify(validated, null, 2) + '\n', 'utf8');
  console.info(`[tank-editor-server] saved custom tank ${id}`);
  jsonRes(res, 200, { ok: true, id });
}

/** DELETE:删 custom-*.json */
function handleCustomDelete(id: string, res: ServerResponse): void {
  const fp = customFilePath(id);
  if (!existsSync(fp)) {
    jsonRes(res, 404, { error: `${id} not found` });
    return;
  }
  unlinkSync(fp);
  console.info(`[tank-editor-server] deleted custom tank ${id}`);
  jsonRes(res, 200, { ok: true, id });
}
