import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { offlineBuild } from './offline-build.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const target = new URL(env.ZICHAN_DEV_API_TARGET || `http://127.0.0.1:${env.PORT || '8787'}${env.BASE_PATH || '/'}`);
  const basePath = target.pathname.replace(/\/+$/, '');
  const appVersion = (JSON.parse(readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8')) as { version?: string }).version ?? 'dev';
  return {
  base: './',
  // Reported to the sync server in a header, so an operator can tell an old build apart
  // from a broken one. `dev` outside a release build is deliberate: a dev server is not
  // a released build, and claiming a version would make the diagnostics wrong.
  define: { __ZICHAN_APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [react(), offlineBuild()],
  // sql.js is CJS: let Vite pre-bundle it (CJS→ESM). The .wasm is handled
  // separately via `?url` in sqljs-driver.ts and copied to the build output.
  optimizeDeps: { include: ['sql.js'] },
  worker: { format: 'es' },
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
    // Vite rejects any Host that is not localhost, an IP literal, or listed
    // here. A tunnel or reverse proxy presents its public hostname, so a
    // deployment reached that way has to declare it (comma-separated, e.g.
    // "ledger.example.com").
    //
    // Opt-in through the environment on purpose. Allowing a host re-opens the
    // dev server to the DNS-rebinding requests Vite's default check blocks, and
    // this server has no authentication of its own - it serves the whole source
    // tree. Never set this on an untrusted network.
    allowedHosts: (env.ZICHAN_DEV_ALLOWED_HOSTS ?? '').split(',').map((host) => host.trim()).filter(Boolean),
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
