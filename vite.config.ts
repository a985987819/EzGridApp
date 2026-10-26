import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { type Plugin } from 'vite'

// GitHub Pages 是项目子路径（/EzGridApp/）；本地 dev / e2e 保持根路径，
// 部署工作流里设 GITHUB_PAGES=true 才启用子路径 base
const base = process.env.GITHUB_PAGES === 'true' ? '/EzGridApp/' : '/'

/**
 * V9.60 加载性能：animal-island-ui 自带的 Noto Sans SC 中文 500 字重一档就 ~1.1MB，
 * 而全站没有真正需要中文 500 的文字（500 与 400 在这套设计里几乎不可分辨，剥掉后
 * 零星的 font-weight:500 按 CSS 字体匹配规则自动落到 400 渲染）。构建/开发时把这条
 * @font-face 从库样式里剥掉：首屏少下载 1.1MB，文件不再被引用、不进产物、不进预缓存。
 */
function stripChineseFont500(): Plugin {
  const re = /@font-face\{[^{}]*noto-sans-sc-chinese-simplified-500[^{}]*\}/g
  return {
    name: 'strip-chinese-font-500',
    // enforce: 'pre' 是关键——vite:css 的 transform 会把 url() 换成资产占位符并发射字体文件，
    // 轮到普通插件的 transform 时资产已经生成了，必须在它之前把规则剥掉
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('animal-island-ui') || !id.endsWith('.css')) return null
      if (!code.includes('noto-sans-sc-chinese-simplified-500')) return null
      return code.replace(re, '')
    },
  }
}

export default defineConfig({
  base,
  plugins: [react(), stripChineseFont500(), VitePWA({
    // V9.40：改 prompt——新版本只提示、不自动 reload；用户手动刷新页面才生效
    registerType: 'prompt',
    includeAssets: ['pwa-192.png', 'pwa-512.png'],
    manifest: {
      name: '网格交易管理',
      short_name: '网格交易',
      description: '本地网格交易台账：明细 · 挂单 · 统计 · 价格树',
      theme_color: '#f6efdc',
      background_color: '#f6efdc',
      display: 'standalone',
      orientation: 'portrait',
      start_url: '.',
      scope: '.',
      icons: [
        { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
        { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
        { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      // 库字体一起进预缓存——离线时整站可用（中文 500 字重已被上面的插件剥掉）
      globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
      navigateFallback: 'index.html',
    },
  })],
  build: {
    rollupOptions: {
      output: {
        /**
         * V9.60：vendor 与业务代码拆开——升级部署时业务 chunk 变了、vendor 块内容不变，
         * HTTP 缓存 / PWA revision 都不重下，更新包更小；首次加载几个块并行下载。
         */
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-dexie': ['dexie'],
          'vendor-ui': ['animal-island-ui'],
        },
      },
    },
  },
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
})
