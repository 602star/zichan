import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
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
  server: { port: 5173, strictPort: true },
});
