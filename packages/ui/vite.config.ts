import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';

// The Midnight ledger and Compact runtime ship as WebAssembly and initialise
// with a top-level await, so the wasm plugin is load-bearing and the build has
// to target a baseline that supports top-level await natively.
export default defineConfig({
  base: './',
  plugins: [react(), wasm()],
  resolve: {
    alias: {
      'isomorphic-ws': fileURLToPath(new URL('./src/shims/isomorphic-ws.ts', import.meta.url)),
    },
  },
  build: {
    target: 'esnext',
    outDir: 'dist',
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    esbuildOptions: { target: 'esnext' },
  },
});
