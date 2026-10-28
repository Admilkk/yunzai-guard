import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { fileURLToPath } from "node:url"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "../dist/panel",
    emptyOutDir: true,
    target: "es2022",
    manifest: true,
    license: { fileName: "licenses.txt" },
    rolldownOptions: {
      output: {
        // 第三方依赖按库拆分，业务代码更新时浏览器可继续使用缓存的依赖包。
        codeSplitting: {
          groups: [
            {
              name: "react",
              test: /node_modules[\\/](react|react-dom|scheduler)[\\/]/,
              priority: 30,
            },
            {
              name: "motion",
              test: /node_modules[\\/](motion|framer-motion|motion-dom|motion-utils)[\\/]/,
              priority: 20,
            },
          ],
        },
      },
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:21733", changeOrigin: false } },
  },
})
