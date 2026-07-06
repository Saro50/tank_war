import { defineConfig, loadEnv } from 'vite';
import { tankEditorServer } from './vite-plugins/tankEditorServer';

// Rapier compat 包内联了 wasm，对 Vite 基本开箱即用。
// 这里显式预构建，避免首次冷启动时偶发的 CJS 解析警告。
export default defineConfig(({ mode }) => {
  // 从 .env / .env.local 等加载环境变量，使 PORT 可从 .env.local 配置
  const env = loadEnv(mode, process.cwd(), '');
  const port = parseInt(env.PORT || '5198', 10);

  return {
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
