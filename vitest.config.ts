import { defineConfig } from 'vitest/config'

// The matchmaking core, settlement math and geo helpers are deliberately pure
// so they test in plain Node without a Workers runtime. End-to-end WebSocket
// pairing is covered by Playwright against `vite dev` instead.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@shared': new URL('./shared', import.meta.url).pathname,
    },
  },
})
