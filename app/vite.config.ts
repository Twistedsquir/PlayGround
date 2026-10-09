import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { defineConfig } from 'vite'

// PWA + offline app shell for iPhone Safari Add to Home Screen.
// See SPEC.md section 12: service worker caches shell, data lives in IndexedDB.
export default defineConfig({
  // Allow the controller's public tunnel (rotating *.trycloudflare.com host)
  // to reach the local preview server; loopback-only serving stays in start.sh.
  preview: { allowedHosts: ['.trycloudflare.com'] },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'apple-touch-icon.svg'],
      manifest: {
        name: 'Family Meals',
        short_name: 'Meals',
        description: 'Private shared meal planning and grocery budget for our household.',
        start_url: '.',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#16a34a',
        icons: [
          { src: 'pwa-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: 'pwa-512.svg', sizes: '512x512', type: 'image/svg+xml' },
          { src: 'pwa-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App-shell offline: cache pages, fall back to index for navigation.
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            urlPattern: ({ request }) => request.destination === 'document',
            handler: 'NetworkFirst',
            options: { cacheName: 'pages' },
          },
        ],
      },
    }),
  ],
})
