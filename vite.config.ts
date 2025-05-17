import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  build: {
    lib: {
      entry: path.resolve(__dirname, 'src/bin.ts'),
      name: 'Lens Node',
      fileName: (format) => `bin.${format === 'es' ? 'mjs' : 'js'}`,
      formats: ['cjs'],
    },
    rollupOptions: {
      external: [
        /^yargs(\/.*)?$/, 
        /^node:/
      ],
    },
    outDir: 'dist',
    sourcemap: true, 
    minify: false,
    target: 'node20',
  },
  resolve: {
    alias: {
      '/@': path.resolve(__dirname, 'src'),
    },
  },
});