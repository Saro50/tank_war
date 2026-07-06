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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import type { IncomingMessage, ServerResponse } from 'http';
import { TANK_VARIANTS, TankSchemaByVariant, type TankVariant } from '../src/data/TankSchema';

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
        // 只处理 /api/tanks 开头的请求,其他放行
        if (path !== '/api/tanks' && !path.startsWith('/api/tanks/')) {
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
