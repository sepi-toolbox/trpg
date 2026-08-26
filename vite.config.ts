/// <reference types="vitest/config" />
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// GitHub Pages는 https://<org>.github.io/<repo>/ 아래로 서빙되므로 base가 필요하다.
// CI에서 BASE_PATH=/trpg/ 를 주입하고, 로컬 dev에서는 '/' 를 쓴다.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
