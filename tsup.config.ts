import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  outDir: 'dist',
  target: 'es2024',
  platform: 'node',
  dts: { resolve: true },
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  tsconfig: './tsconfig.build.json',
});
