import { defineConfig } from 'vite';

// Rapier compat 包内联了 wasm，对 Vite 基本开箱即用。
// 这里显式预构建，避免首次冷启动时偶发的 CJS 解析警告。
export default defineConfig({
  server: {
    host: true,
    port: 5173,
  },
  optimizeDeps: {
    include: ['@dimforge/rapier3d-compat'],
  },
});
