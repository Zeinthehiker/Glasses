import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset paths so the packed .ehpk works when loaded from disk.
  base: './',
  server: { host: true, port: 5173 },
  build: { target: 'es2022' },
})
