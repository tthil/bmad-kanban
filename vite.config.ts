import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  plugins: [preact()],
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: { proxy: { '/api': 'http://127.0.0.1:4310' } },
});
