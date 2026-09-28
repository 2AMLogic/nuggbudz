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
      // The one thing standing between `worker/pool.ts` and a Node import: the
      // Durable Object base class. See `test/stubs/cloudflare-workers.ts` for
      // why a test is allowed to load the object at all.
      'cloudflare:workers': new URL('./test/stubs/cloudflare-workers.ts', import.meta.url).pathname,
    },
  },
})
