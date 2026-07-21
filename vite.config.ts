import { defineConfig, loadEnv } from 'vite';
import { tankEditorServer } from './vite-plugins/tankEditorServer';

// Rapier compat 包内联了 wasm，对 Vite 基本开箱即用。
// 这里显式预构建，避免首次冷启动时偶发的 CJS 解析警告。
export default defineConfig(({ mode }) => {
  // 从 .env / .env.local 等加载环境变量，使 PORT / VITE_BASE 可从环境配置
  const env = loadEnv(mode, process.cwd(), '');
  const port = parseInt(env.PORT || '5198', 10);

  // 部署路径(base):决定所有静态资源(JS/音频/glb/json)的 URL 前缀。
  // ------------------------------------------------------------
  // 默认 '/' = 域名根路径部署(https://xxx.com/)
  // 子路径部署设为对应路径(https://xxx.com/tank-war/ → VITE_BASE=/tank-war/)
  // 配置方式(任选其一):
  //   ① .env / .env.production 写:  VITE_BASE=/tank-war/
  //   ② 构建命令临时指定:            VITE_BASE=/tank-war/ npm run build
  // 要求首尾带 '/'。配后 import.meta.env.BASE_URL 自动同步,
  // AssetLoader/AudioAssets/TankDataStore 的资源加载代码无需任何改动。
  const base = env.VITE_BASE || '/';

  return {
    base,
    plugins: [tankEditorServer()], // 编辑器后台(仅 dev:读写 editor-dist/tanks/*.json)
    server: {
      host: true,
      port,
      strictPort: true, // 端口被占用时直接报错退出，不自动顺延到其他端口
    },
    optimizeDeps: {
      include: ['@dimforge/rapier3d-compat'],
    },
  };
});
