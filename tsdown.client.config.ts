/**
 * client 半面构建配置 —— 复刻 dsh 闭包工厂格式（方案 §3.5「唯一硬骨头」）。
 *
 * 格式契约照 deepseek-harness/packages/client/tsdown.client.ts 的 clientConfig 复刻：
 * - CJS 单文件：banner 开启 window.__ModuleLoader__.load({ id, factory: (require) => {，
 *   intro 注入 module/exports 垫片，footer 以 return module.exports; } }); 收口；
 * - externals 只走模块表基线（PLATFORM_MODULES，见
 *   deepseek-harness/packages/client/web/src/platform.ts）——require 由加载器解析，
 *   其余依赖一律内联；
 * - clean 必须为 false：lib/ 同时是 Host 半面（tsdown.config.ts）的输出目录。
 *
 * 格式若随 dsh 版本漂移（R1），对照 tsdown.client.ts 的 outputOptions 修这里的
 * banner/intro/footer 与 external 清单即可。
 */
import { defineConfig } from 'tsdown'

/** 模块表基线（PLATFORM_MODULES，精确匹配，勿凭感觉增删）。 */
const PLATFORM_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

const PLUGIN_ID = 'dsh-astock-workbench'

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  external: [...PLATFORM_EXTERNALS],
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
