import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type BrowserContext, expect, type Page, test } from '@playwright/test'
import { FIXTURE_COORDS } from '../scripts/pool-fixtures.mjs'
import { findDeal } from '../shared/deals'
import { formatCents, settle } from '../shared/economics'
import { DEFAULT_MATCH_RADIUS_METERS, formatMiles } from '../shared/geo'
import { parseSauceSelection, saucesForMerchant } from '../shared/sauces'

/**
 * #150: sign-in moved from the socket to the seat, driven through the real UI.
 *
 * A signed-out page used to meet a 401 at the socket before it had seen
 * anything. Now it sees the count waiting within its radius and the map, taps
 * for a seat, is refused *on the wire*, and is shown a sign-in interstitial — and
 * after the round trip it is seated with the deal and sauces it had chosen,
 * rather than dropped back on a blank landing screen. `scripts/smoke.mjs` proves
 * the refusal and the roster privacy at the protocol level; this proves the
 * screen a person actually meets.
 *
 * The Google round trip itself cannot run unattended, so `/api/auth/google/start`
 * is answered in the browser the way a completed sign-in ends: a session cookie
 * set and a redirect back to `/`. Everything after that — the session read, the
 * stashed seat, the join — is the app's own code.
 */

const SESSION_COOKIE = 'nb_session'
const DEAL_ID = 'mcd-nuggets-20'
const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

const sessionId = (label: string): string => label.padEnd(43, '0').slice(0, 43)
const accountId = (n: number): string => `e2ee2ee2-0000-4000-8000-${String(n).padStart(12, '0')}`

const BUYERS = {
  // Already queued in the Tulsa market: the one the signed-out page counts.
  lark: { sid: sessionId('e2e-lark'), userId: accountId(20), name: 'Lark' },
  // The account the signed-out page signs in *as*, which already has a
  // different sauce pair stored from some earlier visit.
  wren: { sid: sessionId('e2e-wren'), userId: accountId(21), name: 'Wren' },
} as const

const deal = findDeal(DEAL_ID)
if (deal === undefined) throw new Error(`fixture deal missing: ${DEAL_ID}`)
const half = formatCents(settle(deal, 2).shares[1].payCents)

// Off the catalogue, never typed: the pair chosen signed-out, and a different
// pair the account already holds. The resumed seat must carry the first.
const menu = saucesForMerchant(deal.merchant)
const [first, second, third] = menu
if (first === undefined || second === undefined || third === undefined) {
  throw new Error('the fixture deal needs three sauces on its menu')
}
const CHOSEN = [first, second] as const
const STORED = parseSauceSelection([third.id, third.id])
const CHOSEN_SELECTION = parseSauceSelection([first.id, second.id])

function wrangler(args: string[]): void {
  execFileSync('npx', ['wrangler', ...args], { stdio: 'pipe', env: WRANGLER_ENV })
}

test.beforeAll(() => {
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
  wrangler(['kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'])
  wrangler(['d1', 'migrations', 'apply', 'nuggbudz', '--local'])
  const now = Date.now()
  const users = Object.values(BUYERS)
    .map(
      (buyer) =>
        `('${buyer.userId}', 'e2e-sub-${buyer.userId}', NULL, '${buyer.name}', NULL, ${now}, ${now})`,
    )
    .join(', ')
  if (STORED === null) throw new Error('stored fixture pair is not a selection')
  wrangler([
    'd1',
    'execute',
    'nuggbudz',
    '--local',
    '--command',
    `INSERT OR IGNORE INTO users
       (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
     VALUES ${users};
     INSERT OR REPLACE INTO user_sauces (user_id, first_sauce_id, second_sauce_id, updated_at)
     VALUES ('${BUYERS.wren.userId}', '${STORED[0]}', '${STORED[1]}', ${now});`,
  ])
})

async function signIn(context: BrowserContext, buyer: { sid: string }): Promise<void> {
  await context.addCookies([
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
}

/** Every frame this page's sockets send and receive, parsed. */
function recordFrames(page: Page) {
  const received: Record<string, unknown>[] = []
  const sent: Record<string, unknown>[] = []
  const parse = (payload: string | Buffer) => {
    try {
      return JSON.parse(String(payload)) as Record<string, unknown>
    } catch {
      return null
    }
  }
  page.on('websocket', (ws) => {
    ws.on('framereceived', (event) => {
      const message = parse(event.payload)
      if (message !== null) received.push(message)
    })
    ws.on('framesent', (event) => {
      const message = parse(event.payload)
      if (message !== null) sent.push(message)
    })
  })
  return { received, sent }
}

test('a signed-out visitor sees the market, is asked to sign in for a seat, and comes back to it', async ({
  browser,
}) => {
  const seatedCtx = await browser.newContext({
    geolocation: {
      latitude: FIXTURE_COORDS.e2eBrowseSeated.lat,
      longitude: FIXTURE_COORDS.e2eBrowseSeated.lng,
    },
    permissions: ['geolocation'],
  })
  const anonCtx = await browser.newContext({
    geolocation: {
      latitude: FIXTURE_COORDS.e2eBrowseAnon.lat,
      longitude: FIXTURE_COORDS.e2eBrowseAnon.lng,
    },
    permissions: ['geolocation'],
  })

  try {
    // --- someone nearby is already waiting ---
    await signIn(seatedCtx, BUYERS.lark)
    const seated = await seatedCtx.newPage()
    await seated.goto('/')
    await seated.getByRole('button', { name: /use my exact location/i }).click()
    await expect(seated.getByText(/exact location on/i)).toBeVisible()
    await seated.getByRole('button', { name: /find a bud/i }).click()
    await expect(seated.getByText(/looking for a bud/i)).toBeVisible()

    // --- a signed-out page, before it is asked for anything ---
    const page = await anonCtx.newPage()
    const frames = recordFrames(page)
    await page.goto('/')
    await page.getByRole('button', { name: /use my exact location/i }).click()
    await expect(page.getByText(/exact location on/i)).toBeVisible()

    // The count is the argument, and it is on screen with no account and no seat.
    const within = formatMiles(DEFAULT_MATCH_RADIUS_METERS)
    await expect(page.getByText(`1 waiting within ${within} right now.`)).toBeVisible()
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 })
    // And the privacy half: the page was sent counts, never the roster.
    expect(frames.received.some((m) => m.type === 'market')).toBe(true)
    expect(frames.received.every((m) => m.type !== 'waiting' && !('buddies' in m))).toBe(true)

    // --- the seat ---
    for (const picked of CHOSEN) {
      await page.getByRole('button', { name: picked.label }).first().click()
    }
    await page.getByRole('button', { name: /find a bud/i }).click()

    await expect(page.getByText(/sign in to take it/i)).toBeVisible()
    // Shown after the deal, the half and the market — and restating them.
    await expect(page.getByText(deal.label).first()).toBeVisible()
    await expect(page.getByText(half, { exact: true })).toBeVisible()
    await expect(page.getByText(`1 waiting within ${within} right now.`)).toBeVisible()
    // Refused by the server, on the wire — not merely hidden by the client.
    await expect
      .poll(() => frames.received.find((m) => m.type === 'error')?.code)
      .toBe('sign_in_required')
    expect(frames.received.some((m) => m.type === 'waiting')).toBe(false)
    // And nobody was paired with a seat that was never granted.
    await expect(seated.getByText(/looking for a bud/i)).toBeVisible()
    await expect(seated.getByText('Matched')).toHaveCount(0)

    // --- the round trip ---
    // What a completed Google sign-in amounts to: a session cookie, and `/`.
    await page.route('**/api/auth/google/start', async (route) => {
      await signIn(anonCtx, BUYERS.wren)
      await route.fulfill({ status: 302, headers: { location: '/' } })
    })
    await page.getByRole('button', { name: /sign in with google/i }).click()

    // Seated on return, without choosing again.
    await expect(page.getByText(/looking for a bud|standing in line/i).first()).toBeVisible()
    await expect
      .poll(() => frames.sent.filter((m) => m.type === 'join').at(-1))
      .toMatchObject({ type: 'join', dealId: DEAL_ID, sauces: CHOSEN_SELECTION })

    // The pick made signed-out won over the pair the account already held, and
    // is now the account's pair.
    await expect
      .poll(async () => {
        const response = await page.request.get('/api/me/sauces')
        return ((await response.json()) as { sauces?: unknown }).sauces
      })
      .toEqual(CHOSEN_SELECTION)
  } finally {
    await seatedCtx.close()
    await anonCtx.close()
  }
})
