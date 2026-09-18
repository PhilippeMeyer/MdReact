import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.VITE_PDF_SERVER || 'http://localhost:4000'

  return {
    plugins: [react()],
    server: {
      // The app calls /api/... on its own origin; the dev server forwards that
      // to the PDF backend, so there is no hardcoded host and no CORS in dev.
      proxy: {
        '/api': { target, changeOrigin: true }
      }
    }
  }
})
