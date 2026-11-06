import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
        target: 'https://45-76-245-71.sslip.io',
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
