import { describe, expect, it } from 'vitest'
import { resolveD1Target } from '../scripts/demo-pairing-check.mjs'

/**
 * The seam issue #118 found: `ledgerQuery` hardcoded `--local`, so pointing
 * `BASE` at a deployment still silently read the local Miniflare D1 store —
 * the three ledger-exclusion assertions ("writes no match row", "books no
 * money rows", "row count unchanged") passed no matter what the deployment
 * actually booked, because they were never reading it.
 *
 * `resolveD1Target` is what `BASE` now drives instead, the same way it already
 * drives the pool socket URL (`WS`). This is the offline half of the
 * verification — no `wrangler`, no server — so it runs in `pnpm test` rather
 * than only in `pnpm demo-check`, which only ever exercises the local branch
 * (CI always points it at `localhost`). The PR that shipped this file also
 * records a reproduction of the defect itself against two divergent local D1
 * persist paths, standing in for "local" vs. "a deployment" without needing
 * real Cloudflare credentials.
 */
describe('resolveD1Target', () => {
  const local = [
    ['bare localhost', 'http://localhost:5199'],
    ['a different local port, e.g. CI’s demo-check job', 'http://localhost:5211'],
    ['loopback IPv4', 'http://127.0.0.1:5199'],
    ['loopback IPv4, https', 'https://127.0.0.1:8787'],
    ['loopback IPv6', 'http://[::1]:5199'],
  ] as const

  for (const [what, url] of local) {
    it(`reads --local for ${what}`, () => {
      expect(resolveD1Target(url)).toEqual({ local: true, flag: '--local', label: 'local' })
    })
  }

  const remote = [
    ['the production domain', 'https://nuggbudz.com'],
    ['a workers.dev preview', 'https://nuggbudz.personal-account-251.workers.dev'],
    ['a hostname that merely contains "localhost"', 'https://notlocalhost.example.com'],
    ['a LAN IP, which is not loopback', 'http://192.168.1.50:5199'],
  ] as const

  for (const [what, url] of remote) {
    it(`reads --remote for ${what}`, () => {
      expect(resolveD1Target(url)).toEqual({ local: false, flag: '--remote', label: 'remote' })
    })
  }
})
