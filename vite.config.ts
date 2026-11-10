import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  worker: { format: 'es' },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: './index.html',
        iconCatalog: './icon-catalog/index.html',
        packageTools: './package-tools/index.html'
      }
    }
  },
  server: {
    port: 3777,
    strictPort: true,
    open: true,
    host: 'localhost'
  },
  preview: {
    port: 3778,
    strictPort: true,
    open: true
  },
  base: '/'
});
