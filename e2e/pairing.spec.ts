import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { findDeal } from '../shared/deals'
import { formatCents, settle } from '../shared/economics'

/**
 * Drives the real UI (`src/App.tsx`) end to end through two browser contexts,
 * the way `scripts/smoke.mjs` drives the raw WebSocket protocol. That script
 * proves the pairing rule; this proves the screen a person actually looks at
 * renders it correctly.
 *
 * `/api/pool/ws` requires a signed-in session (`worker/index.ts`), and signing
 * in for real means a Google OAuth round trip nothing here can complete
 * unattended. Rather than add a test-only login route -- which would weaken
 * the Worker for a path that only exists in tests -- this suite seeds
 * sessions straight into the dev server's local KV namespace, exactly the way
 * `scripts/smoke.mjs` already does, and hands the browser the resulting
 * cookie directly.
 */

const SESSION_COOKIE = 'nb_session'
const DEAL_ID = 'mcd-nuggets-20'

/** Session ids are 43-char base64url strings; padded so every test run reuses the same keys. */
const sessionId = (label: string): string => label.padEnd(43, '0').slice(0, 43)

const BUYERS = {
  nova: { sid: sessionId('e2e-nova'), userId: 'e2e-user-nova', name: 'Nova' },
  remy: { sid: sessionId('e2e-remy'), userId: 'e2e-user-remy', name: 'Remy' },
  ivy: { sid: sessionId('e2e-ivy'), userId: 'e2e-user-ivy', name: 'Ivy' },
} as const

type Buyer = (typeof BUYERS)[keyof typeof BUYERS]

const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

/**
 * The ledger tables have to exist before a settled split can be booked. Without
 * this, `worker/pool.ts`'s ledger write throws "no such table: matches" on a
 * fresh local D1 and swallows the error (by design -- a ledger outage must not
 * strand two buddies who already swapped nuggets), so the completed-handoff
 * assertion below would pass even though nothing was actually booked.
 */
function applyMigrations(): void {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nuggbudz', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

/** Write the seeded sessions into the dev server's local KV in one CLI call. */
function seedSessions(): void {
  const entries = Object.values(BUYERS).map((buyer) => ({
    key: `session:${buyer.sid}`,
    value: JSON.stringify({
      userId: buyer.userId,
      googleSub: `e2e-sub-${buyer.userId}`,
      displayName: buyer.name,
      email: null,
      avatarUrl: null,
      createdAt: Date.now(),
    }),
  }))
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-e2e-')), 'sessions.json')
  writeFileSync(file, JSON.stringify(entries))
  execFileSync(
    'npx',
    ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'],
    // The running dev server's local KV is the same store wrangler writes to,
    // so this lands live without restarting anything.
    { stdio: 'pipe', env: WRANGLER_ENV },
  )
}

/**
 * A geohash-6 cell is roughly city-block sized (~1.2km x 0.6km), and these two
 * points sit ~40m apart -- close enough to pair, and nowhere near the demo
 * origin `useCoords.ts` falls back to, so this test's queue never shares a
 * Durable Object instance with the denied-geolocation spec below.
 */
const BUDDY_A = { latitude: 37.79, longitude: -122.4 }
const BUDDY_B = { latitude: 37.7903, longitude: -122.4003 }

const deal = findDeal(DEAL_ID)
if (deal === undefined) throw new Error(`fixture deal missing: ${DEAL_ID}`)
const settlement = settle(deal, 2)
// Both shares are equal here (an even split with no remainder), so either index works.
const expectedHalf = formatCents(settlement.shares[0].payCents)
const expectedSavings = formatCents(settlement.shares[0].savingsCents)

test.beforeAll(() => {
  seedSessions()
  applyMigrations()
})

/** Sign a page in by handing its context the session cookie a real callback would set. */
async function signIn(page: import('@playwright/test').Page, buyer: Buyer): Promise<void> {
  await page.context().addCookies([
    {
      name: SESSION_COOKIE,
      value: buyer.sid,
      // `pnpm dev` serves plain http locally; a `secure` cookie would never be sent to it.
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    },
  ])
}

test('two nearby buds pair, split the box evenly, and see complementary roles', async ({
  browser,
}) => {
  const contextA = await browser.newContext({ geolocation: BUDDY_A, permissions: ['geolocation'] })
  const contextB = await browser.newContext({ geolocation: BUDDY_B, permissions: ['geolocation'] })
  const pageA = await contextA.newPage()
  const pageB = await contextB.newPage()

  try {
    await signIn(pageA, BUYERS.nova)
    await signIn(pageB, BUYERS.remy)

    await pageA.goto('/')
    await pageB.goto('/')

    // The default deal (`deals[0]`, mcd-nuggets-20) is pre-selected, so signing
    // in is the only thing standing between the idle screen and "Find a bud".
    await expect(pageA.getByRole('button', { name: /find a bud/i })).toBeEnabled()
    await expect(pageB.getByRole('button', { name: /find a bud/i })).toBeEnabled()

    // Nova joins first and waits, so `findMatch`'s fairness rule (the longest
    // waiter orders) makes her the deterministic orderer once Remy joins.
    await pageA.getByRole('button', { name: /find a bud/i }).click()
    await expect(pageA.getByText(/looking for a bud/i)).toBeVisible()

    await pageB.getByRole('button', { name: /find a bud/i }).click()

    await expect(pageA.getByText('Matched')).toBeVisible()
    await expect(pageB.getByText('Matched')).toBeVisible()

    // Complementary roles: whoever waited longer places the order.
    await expect(
      pageA.getByText(`You order the box. ${BUYERS.remy.name} comes to you.`),
    ).toBeVisible()
    await expect(pageB.getByText(`${BUYERS.nova.name} orders the box. Go meet them.`)).toBeVisible()

    // Both receipts show the real settlement for this deal, computed by
    // `shared/economics.ts` rather than assumed here.
    await expect(pageA.getByText(expectedHalf, { exact: true })).toBeVisible()
    await expect(pageA.getByText(expectedSavings, { exact: true })).toBeVisible()
    await expect(pageB.getByText(expectedHalf, { exact: true })).toBeVisible()
    await expect(pageB.getByText(expectedSavings, { exact: true })).toBeVisible()

    // The pickup code is not "the same code shown on both screens" -- CLAUDE.md
    // is explicit that it is "never sent to the receiver," and `pool.ts` only
    // ever fills `pickupCode` for the orderer (Nova here). Assert that
    // invariant directly, then prove it is the *same* match by typing Nova's
    // exact code into Remy's input and completing the real handoff -- a
    // stronger check than comparing two on-screen strings would have been.
    const code = await pageA.getByText(/^[A-Z0-9]{6}$/).innerText()
    expect(code).toMatch(/^[A-Z0-9]{6}$/)
    await expect(pageB.getByText(/^[A-Z0-9]{6}$/)).toHaveCount(0)
    await expect(pageB.getByText(`The code on ${BUYERS.nova.name}'s receipt`)).toBeVisible()

    await pageB.getByPlaceholder('------').fill(code)
    await pageB.getByRole('button', { name: /got the box/i }).click()
    await expect(pageB.getByText(/waiting on/i)).toBeVisible()

    await pageA.getByRole('button', { name: /handed it over/i }).click()
    await expect(pageA.getByText(/both of you confirmed the handoff/i)).toBeVisible()
    await expect(pageB.getByText(/both of you confirmed the handoff/i)).toBeVisible()
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('leaving the queue does not immediately rejoin, and a denied location falls back to the demo cell', async ({
  browser,
}) => {
  // No `permissions: ['geolocation']` here: the browser denies the prompt on
  // its own, exercising the same path a real refusal would.
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await signIn(page, BUYERS.ivy)
    await page.goto('/')

    const findButton = page.getByRole('button', { name: /find a bud/i })
    await expect(findButton).toBeEnabled()
    await findButton.click()

    // Queued, at the demo cell rather than rejected -- a denied fix downgrades
    // to `DEMO_ORIGIN` (`useCoords.ts`) instead of dead-ending the flow.
    await expect(page.getByText(/looking for a bud/i)).toBeVisible()

    // This was a real bug: leaving must not re-run the join because location
    // and deal state are still set (see the comment on `start` in `App.tsx`).
    await page.getByRole('button', { name: /leave the queue/i }).click()
    await expect(findButton).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.getByText(/looking for a bud|standing in line/i)).toHaveCount(0)

    // Back on the idle screen, the notice `coords.locate()` set on the way in
    // is still visible -- the on-screen record that the demo cell was used.
    await expect(
      page.getByText('Location is off. Using the demo cell so you can still pair.'),
    ).toBeVisible()
  } finally {
    await context.close()
  }
})
