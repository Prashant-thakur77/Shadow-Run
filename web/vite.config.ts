import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

declare const process: { env: Record<string, string | undefined> };

// The real backend. Point elsewhere with SHADOWRUN_API=https://... npm run dev
const api = process.env.SHADOWRUN_API ?? 'http://127.0.0.1:8100';

/** Fonts are fingerprinted by the build, so their preload links can only be written once the bundle exists. */
function preloadFonts(): Plugin {
  return {
    name: 'shadow-run-preload-fonts',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        return Object.keys(ctx.bundle ?? {})
          .filter((file) => file.endsWith('.woff2'))
          .map((file) => ({
            tag: 'link',
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', href: `/${file}`, crossorigin: true },
            injectTo: 'head' as const,
          }));
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), preloadFonts()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    chunkSizeWarningLimit: 400,
    // Keep fonts as files. Inlined base64 would not compress and could not be preloaded.
    assetsInlineLimit: 0,
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
