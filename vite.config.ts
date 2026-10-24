import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages 是项目子路径（/EzGridApp/）；本地 dev / e2e 保持根路径，
// 部署工作流里设 GITHUB_PAGES=true 才启用子路径 base
const base = process.env.GITHUB_PAGES === 'true' ? '/EzGridApp/' : '/'

export default defineConfig({
  base,
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
        // three.js chunk、库字体一起进预缓存——离线时整站可用
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  server: { port: 5173 },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
})
