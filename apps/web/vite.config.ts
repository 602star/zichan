import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineBuild } from './offline-build.js';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const target = new URL(env.ZICHAN_DEV_API_TARGET || `http://127.0.0.1:${env.PORT || '8787'}${env.BASE_PATH || '/'}`);
  const basePath = target.pathname.replace(/\/+$/, '');
  return {
  base: './',
  plugins: [react(), offlineBuild()],
  // sql.js is CJS: let Vite pre-bundle it (CJS→ESM). The .wasm is handled
  // separately via `?url` in sqljs-driver.ts and copied to the build output.
  optimizeDeps: { include: ['sql.js'] },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalized = id.replace(/\\/g, '/');
          if (normalized.includes('/node_modules/react') || normalized.includes('/node_modules/react-dom')) return 'react';
          if (normalized.includes('/node_modules/sql.js')) return 'sql';
          if (normalized.includes('/packages/core/') || normalized.includes('/packages/db/') || normalized.includes('/packages/logger/')) return 'ledger';
          return undefined;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0', port: 5173, strictPort: true,
    proxy: {
      '^/api(?:/|$)': {
        target: target.origin,
        // Preserve Host and Origin together: the backend still enforces same-origin cookies.
        changeOrigin: false,
        rewrite: (path) => `${basePath}${path}`,
        cookiePathRewrite: { [`${encodeURI(basePath)}/api/auth`]: '/api/auth' },
      },
    },
  },
  };
});
