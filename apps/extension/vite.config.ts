import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  plugins: [react(), nodePolyfills({ include: ['buffer', 'crypto', 'stream', 'util'] })],
  server: { host: '127.0.0.1', port: 7100, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        approval: resolve(__dirname, 'approval.html'),
        background: resolve(__dirname, 'src/background.ts'),
        content: resolve(__dirname, 'src/content.ts'),
        inpage: resolve(__dirname, 'src/inpage.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        manualChunks: {
          'wallet-crypto': ['@swirl/wallet'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
