import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png"],
      manifest: {
        name: "Sarathy",
        short_name: "Sarathy",
        description: "Sarathy personal AI assistant dashboard",
        start_url: ".",
        scope: ".",
        display: "standalone",
        orientation: "portrait",
        background_color: "#09090b",
        theme_color: "#09090b",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,ico,png,svg,webmanifest}"],
        // The openUI runtime is a LAZY chunk (only fetched when a reply contains
        // a UI block). Precaching it would download it on every install and
        // defeat the split, so keep it out of the precache manifest and cache it
        // on first use instead.
        globIgnores: ["**/openuiRenderer-*.js", "**/openuiRenderer-*.css"],
        runtimeCaching: [
          {
            urlPattern: /\/assets\/openuiRenderer-.*\.(js|css)$/,
            handler: "StaleWhileRevalidate",
            options: { cacheName: "openui-runtime" },
          },
        ],
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/ws/, /^\/mobile/, /^\/mobile\.html/],
        // Web Push handler — lives in public/push-sw.js and is imported into the
        // generated sw.js, so the push logic stays out of the workbox bundle.
        importScripts: ["push-sw.js"],
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "../sarathy/channels/dashboard/static"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: path.resolve(import.meta.dirname, "index.html"),
        mobile: path.resolve(import.meta.dirname, "mobile.html"),
      },
    },
  },
});