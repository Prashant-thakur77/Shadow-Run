import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

declare const process: { env: Record<string, string | undefined> };

// The real backend. Point elsewhere with SHADOWRUN_API=https://... npm run dev
const api = process.env.SHADOWRUN_API ?? 'http://127.0.0.1:8100';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 400,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: api,
        changeOrigin: true,
        secure: api.startsWith('https'),
      },
    },
  },
});
