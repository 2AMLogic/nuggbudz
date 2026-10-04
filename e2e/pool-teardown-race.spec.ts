import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'
import { SESSION_COOKIE } from '../shared/auth'

/**
 * #189: a refusal probe that answers after the seat was left (#178), through the
 * real React tree.
 *
 * `usePool` learns a refused upgrade from a plain `fetch` to the socket's own URL
 * (#105), so that answer can land after the buyer has pressed "Sign out" and
 * `pool.leave()` has run, but before `signOut()`'s round trip lets `browse()`
 * reconnect. `test/use-pool.test.ts` guards the generation counter against a
 * hand-rolled stand-in for React; this is the same ordering, observed on the
 * screen.
 *
 * **What is real and what is a double, stated plainly.** Real: the Worker, the
 * session read, React, the hook, the DOM. Doubles, both because the browser
 * offers no other way to make them happen on demand: `window.WebSocket` is
 * replaced by a socket that closes and never opens (the exact `opened === false`
 * close the hook branches on, without tripping the real upgrade limiter), and the
 * probe and the logout are held by `page.route` so the interleaving is ordered by
 * the test rather than by a race. The refusal is *answered* in the browser and
 * never reaches the limiter. The first test is the positive control: the same
 * setup with no sign-out must show the refusal, or the second proves nothing.
 *
 * The seat never reaches a Durable Object, so this scenario owns no coordinates.
 */

const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
const REFUSAL = /too many connection attempts/i

const sessionId = (label: string): string => label.padEnd(43, '0').slice(0, 43)
const accountId = (n: number): string => `7ea4d0e0-0000-4000-8000-${String(n).padStart(12, '0')}`

const BUYERS = {
  control: { sid: sessionId('e2e-race-a'), userId: accountId(1), name: 'Cleo' },
  signOut: { sid: sessionId('e2e-race-b'), userId: accountId(2), name: 'Dov' },
} as const

type Buyer = (typeof BUYERS)[keyof typeof BUYERS]

function wrangler(args: string[]): void {
  execFileSync('npx', ['wrangler', ...args], { stdio: 'pipe', env: WRANGLER_ENV })
}

test.beforeAll(() => {
  const now = Date.now()
  const buyers = Object.values(BUYERS)
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-race-')), 'sessions.json')
  writeFileSync(
    file,
    JSON.stringify(
      buyers.map((buyer) => ({
        key: `session:${buyer.sid}`,
        value: JSON.stringify({
          userId: buyer.userId,
          googleSub: `e2e-sub-${buyer.userId}`,
          displayName: buyer.name,
          email: null,
          avatarUrl: null,
          createdAt: now,
        }),
      })),
    ),
  )
  wrangler(['kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'])
  wrangler(['d1', 'migrations', 'apply', 'nuggbudz', '--local'])
  const values = buyers
    .map((b) => `('${b.userId}', 'e2e-sub-${b.userId}', NULL, '${b.name}', NULL, ${now}, ${now})`)
    .join(', ')
  wrangler([
    'd1',
    'execute',
    'nuggbudz',
    '--local',
    '--command',
    `INSERT OR IGNORE INTO users
       (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
     VALUES ${values}`,
  ])
})

/** A promise with its resolver outside, so the test decides when a held request moves. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

async function seatedThenRefused(page: Page, buyer: Buyer) {
  // Every pool socket closes without ever opening: a refused upgrade, as far as
  // the page can tell.
  await page.addInitScript(() => {
    class RefusedSocket {
      static CONNECTING = 0
      static OPEN = 1
      static CLOSING = 2
      static CLOSED = 3
      readyState = 0
      onopen: (() => void) | null = null
      onclose: (() => void) | null = null
      onmessage: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(_url: string) {
        setTimeout(() => {
          this.readyState = 3
          this.onclose?.()
        }, 0)
      }
      send(): void {}
      close(): void {
        this.readyState = 3
      }
    }
    // @ts-expect-error -- a deliberately partial stand-in
    window.WebSocket = RefusedSocket
  })
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: buyer.sid,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ])

  // The probe is the same URL as the socket, over plain fetch. Held, then
  // answered the way the limiter answers.
  const probeAsked = gate()
  const probeReleased = gate()
  let probeAnswered = false
  await page.route('**/api/pool/ws*', async (route) => {
    probeAsked.open()
    await probeReleased.opened
    await route.fulfill({ status: 429, headers: { 'Retry-After': '30' }, body: 'slow down' })
    probeAnswered = true
  })

  await page.goto('/')
  await expect(page.getByText(buyer.name, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /find a bud/i }).click()
  await probeAsked.opened
  return {
    releaseProbe: probeReleased.open,
    probeAnswered: () => probeAnswered,
  }
}

test('control: a refusal that lands while the seat is still held is shown', async ({ page }) => {
  const probe = await seatedThenRefused(page, BUYERS.control)
  probe.releaseProbe()
  await expect(page.getByText(REFUSAL)).toBeVisible()
})

test('a refusal that lands after "Sign out" was pressed is not written onto the screen', async ({
  page,
}) => {
  const logoutAsked = gate()
  const logoutReleased = gate()
  await page.route('**/api/auth/logout', async (route) => {
    logoutAsked.open()
    await logoutReleased.opened
    await route.fulfill({ status: 204 })
  })

  const probe = await seatedThenRefused(page, BUYERS.signOut)
  await page.getByRole('button', { name: /sign out/i }).click()
  await logoutAsked.opened

  // `leave()` has run and `browse()` has not: this is the window.
  probe.releaseProbe()
  await expect.poll(probe.probeAnswered).toBe(true)
  // Let the response reach the page's promise chain and any resulting render.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)))
  await expect(page.getByText(REFUSAL)).toHaveCount(0)

  logoutReleased.open()
  await expect(page.getByRole('button', { name: /sign in with google/i })).toBeVisible()
  await expect(page.getByText(REFUSAL)).toHaveCount(0)
})
