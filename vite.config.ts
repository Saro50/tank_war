import { defineConfig } from 'vite';

// Rapier compat 包内联了 wasm，对 Vite 基本开箱即用。
// 这里显式预构建，避免首次冷启动时偶发的 CJS 解析警告。
export default defineConfig({
  server: {
    host: true,
    port: 5199,
    strictPort: true, // 固定 5199：端口被占用时直接报错退出，不自动顺延到其他端口
  },
  optimizeDeps: {
    include: ['@dimforge/rapier3d-compat'],
  },
});
