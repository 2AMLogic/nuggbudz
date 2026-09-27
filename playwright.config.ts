import { defineConfig, devices } from '@playwright/test'

// Same port `scripts/smoke.mjs` and the `smoke` CI job already use for a live
// `pnpm dev` -- one convention across both live-server test lanes.
const PORT = 5199
const BASE_URL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  // `NuggPool` is one Durable Object instance per geohash cell, and the specs
  // in this suite drive that same dev server's real Durable Object storage.
  // Two specs running concurrently could land in the same cell and observe
  // each other's queued buyers, so -- like the 311alarm reference config this
  // suite is modelled on -- everything here runs on a single worker rather
  // than Playwright's `fullyParallel` default.
  workers: 1,
  reporter: 'line',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Reuses a `pnpm dev` a developer already has running locally; CI has none,
  // so this boots one itself.
  webServer: {
    command: `pnpm dev --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
})
