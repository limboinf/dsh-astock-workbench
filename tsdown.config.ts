import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  outDir: 'lib',
  platform: 'node',
  dts: false,
  // lib/ 同时是 client 半面（tsdown.client.config.ts）的输出目录，不能整目录清理
  clean: false,
  sourcemap: false,
})
