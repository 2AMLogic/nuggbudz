import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'
import jsQR from 'jsqr'
import { SESSION_COOKIE } from '../shared/auth'
import { DEFAULT_POOL_CELL_PRECISION, geohash } from '../shared/geo'
import { handoffUrl, pickupCodeFromScan, qrPayloadFor } from '../shared/handoff'
import { DEMO_ORIGIN } from '../shared/location'

/**
 * The native-camera path: the QR is a link, and the phone's own camera opens it.
 *
 * **What this can and cannot establish, stated plainly.** No physical phone has
 * run any of this, and no test in this repo drives a native camera app at all —
 * that is #98, and it still applies. What a browser *can* prove is the half that
 * actually changed on the server: a second tab of the receiver's own browser,
 * opening the URL the symbol carries, is recognised as the receiver of that
 * match and can complete the handoff from there. Chromium opening the link is
 * the same navigation an iOS camera makes; the sensor reading a real LCD is not
 * covered here and nothing below implies it is.
 *
 * The scenario is driven **promptlessly** — nobody taps "use my exact location"
 * — for a reason that is not convenience. A second tab has no coordinates of its
 * own to send, so the server places it from the edge; pairing the first tabs
 * with precise fixtures would put them in a different shard from the tab the
 * camera opens, and the test would be exercising a configuration no demo runs
 * in. `scripts/pool-fixtures.mjs` records this scenario as owning no coordinates
 * for the same reason.
 */

const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

const sessionId = (label: string): string => label.padEnd(43, '0').slice(0, 43)

/** This file's own account-id prefix, so it cannot collide with another spec's. */
const accountId = (n: number): string => `4a9d0ff0-0000-4000-8000-${String(n).padStart(12, '0')}`

const BUYERS = {
  orderer: { sid: sessionId('e2e-hand-a'), userId: accountId(1), name: 'Ines' },
  receiver: { sid: sessionId('e2e-hand-b'), userId: accountId(2), name: 'Otto' },
  /**
   * In neither the match nor the pair's browser. Stands in for somebody who
   * photographed the symbol across the table and tapped the link.
   */
  bystander: { sid: sessionId('e2e-hand-c'), userId: accountId(3), name: 'Nils' },
} as const

type Buyer = (typeof BUYERS)[keyof typeof BUYERS]

function applyMigrations(): void {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nuggbudz', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

function seedUsers(): void {
  const now = Date.now()
  const values = Object.values(BUYERS)
    .map(
      (buyer) =>
        `('${buyer.userId}', 'e2e-sub-${buyer.userId}', NULL, '${buyer.name}', NULL, ${now}, ${now})`,
    )
    .join(', ')
  execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'nuggbudz',
      '--local',
      '--command',
      `INSERT OR IGNORE INTO users
         (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
       VALUES ${values}`,
    ],
    { stdio: 'pipe', env: WRANGLER_ENV },
  )
}

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
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-handoff-')), 'sessions.json')
  writeFileSync(file, JSON.stringify(entries))
  execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

/**
 * Settled rows in the shard this scenario pairs in.
 *
 * Promptless sockets land on `DEMO_ORIGIN` when the runtime has no usable
 * `request.cf`, and on the edge's guess when it has one — so this counts the
 * demo-origin shard and the assertions below are written as deltas rather than
 * as absolutes, which holds either way on a machine that is online.
 */
function settledRows(): number {
  const cell = geohash(DEMO_ORIGIN.lat, DEMO_ORIGIN.lng, DEFAULT_POOL_CELL_PRECISION)
  const out = execFileSync(
    'npx',
    [
      'wrangler',
      'd1',
      'execute',
      'nuggbudz',
      '--local',
      '--json',
      '--command',
      `SELECT COUNT(*) AS n FROM matches WHERE cell = '${cell}' AND settled_at IS NOT NULL`,
    ],
    { encoding: 'utf8', env: WRANGLER_ENV },
  )
  const parsed = JSON.parse(out) as { results: { n: number }[] }[]
  return parsed[0].results[0].n
}

test.beforeAll(() => {
  seedSessions()
  applyMigrations()
  seedUsers()
})

async function signIn(context: BrowserContext, buyer: Buyer): Promise<void> {
  await context.addCookies([
    {
      name: SESSION_COOKIE,
      value: buyer.sid,
      domain: 'localhost',
      path: '/',
      httpOnly: true,
      // `pnpm dev` serves plain http locally; a `secure` cookie would never be sent.
      secure: false,
      sameSite: 'Lax',
    },
  ])
}

/** A signed-in browser that never answers a location prompt. */
async function openPromptless(
  browser: Browser,
  buyer: Buyer,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext()
  await signIn(context, buyer)
  const page = await context.newPage()
  await page.goto('/')
  await expect(page.getByRole('button', { name: /find a bud/i })).toBeEnabled()
  return { context, page }
}

/** The QR element on the orderer's receipt. */
const qrOf = (page: Page) => page.getByRole('img', { name: /pickup code/i })

/** What the orderer's canvas actually says, read back out of their own browser. */
async function decodeRenderedQr(page: Page): Promise<string> {
  const shot = await qrOf(page).evaluate((node) => {
    const canvas = node as HTMLCanvasElement
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('the pickup QR has no 2d context')
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let luma = ''
    for (let at = 0; at < data.length; at += 4) luma += String.fromCharCode(data[at])
    return { width: canvas.width, height: canvas.height, luma: btoa(luma) }
  })
  const luma = Buffer.from(shot.luma, 'base64')
  const rgba = new Uint8ClampedArray(shot.width * shot.height * 4)
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    rgba[pixel * 4] = luma[pixel]
    rgba[pixel * 4 + 1] = luma[pixel]
    rgba[pixel * 4 + 2] = luma[pixel]
    rgba[pixel * 4 + 3] = 255
  }
  const found = jsQR(rgba, shot.width, shot.height)
  if (found === null) throw new Error('the rendered pickup QR did not decode')
  return found.data
}

test('a handoff link opened in a second tab carries the receiver into the match', async ({
  browser,
}) => {
  const before = settledRows()
  const first = await openPromptless(browser, BUYERS.orderer)
  const second = await openPromptless(browser, BUYERS.receiver)
  const outsider = await openPromptless(browser, BUYERS.bystander)
  const contexts = [first.context, second.context, outsider.context]

  try {
    // The orderer queues first, so the fairness rule makes the roles
    // deterministic rather than a coin toss.
    await first.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(first.page.getByText(/looking for a bud/i)).toBeVisible()
    await second.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(
      first.page.getByText(`You order the box. ${BUYERS.receiver.name} comes to you.`),
    ).toBeVisible()
    await expect(
      second.page.getByText(`${BUYERS.orderer.name} orders the box. Go meet them.`),
    ).toBeVisible()

    const code = await first.page.getByText(/^[A-Z0-9]{6}$/).innerText()
    expect(code).toMatch(/^[A-Z0-9]{6}$/)

    // What the symbol on the orderer's screen actually carries: the link, and
    // the link alone. Read back out of the rendered canvas rather than
    // re-derived here, so this is the picture a camera would see.
    const payload = await decodeRenderedQr(first.page)
    const origin = new URL(first.page.url()).origin
    expect(
      payload,
      'the rendered QR must carry the handoff link for this code and nothing else — no match ' +
        'id, no user id, no session token',
    ).toBe(qrPayloadFor(origin, code))
    expect(pickupCodeFromScan(payload)).toBe(code)
    // The receiver still has no code of their own on screen: the link is a way
    // of carrying it the last few feet, not a second delivery channel.
    await expect(qrOf(second.page)).toHaveCount(0)
    await expect(second.page.getByText(/^[A-Z0-9]{6}$/)).toHaveCount(0)

    // --- a bystander who photographs the symbol gets six characters, not a match ---
    // A different account, a different browser, the same URL — and, because this
    // whole scenario is promptless, a socket in the pair's *own* Durable Object.
    // So the refusal is about who they are, not about the match being somewhere
    // else. This is the shape of the attack the link creates and the answer to
    // it: the server takes a confirmation only from the socket that *is* the
    // receiver of that match, so what is left for this screen is the code, which
    // was never secret from anyone standing near you anyway.
    const strangerPage = outsider.page
    await strangerPage.goto(handoffUrl(origin, code))
    await expect(strangerPage.getByText(code)).toBeVisible()
    await expect(
      strangerPage.getByText(/this device is not the one holding that match/i),
    ).toBeVisible()
    await expect(strangerPage.getByRole('button', { name: /got the box/i })).toHaveCount(0)
    await expect(strangerPage.getByRole('button', { name: /handed it over/i })).toHaveCount(0)

    // --- the receiver's own second tab: what the camera app opens ---
    const scanned = await second.context.newPage()
    await scanned.goto(handoffUrl(origin, code))

    // The receipt, in the new tab, for the same match — and the field the
    // receiver would otherwise have typed into, already filled.
    await expect(
      scanned.getByText(`${BUYERS.orderer.name} orders the box. Go meet them.`),
    ).toBeVisible()
    await expect(scanned.getByPlaceholder('------')).toHaveValue(code)

    // The code is out of the address bar. A pickup code is single-use proof that
    // two people met; the back stack is a worse home for it than the screen.
    await expect.poll(() => new URL(scanned.url()).pathname, { timeout: 5_000 }).toBe('/')

    // **Opening the link settled nothing.** Both sides are still waiting to be
    // tapped, nothing is on the books, and the orderer's screen has not moved.
    await expect(scanned.getByText(/both of you confirmed the handoff/i)).toHaveCount(0)
    await expect(scanned.getByText(/waiting on/i)).toHaveCount(0)
    await expect(first.page.getByRole('button', { name: /handed it over/i })).toBeEnabled()
    await expect(first.page.getByText(/waiting on/i)).toHaveCount(0)
    expect(settledRows()).toBe(before)

    // The tap is still the receiver's, and it is this tab that makes it.
    await scanned.getByRole('button', { name: /got the box/i }).click()
    await expect(scanned.getByText(/waiting on/i)).toBeVisible()
    // Both of this person's tabs are on the same match, so the one they left
    // behind hears about it too.
    await expect(second.page.getByText(/waiting on/i)).toBeVisible()

    await first.page.getByRole('button', { name: /handed it over/i }).click()
    await expect(first.page.getByText(/both of you confirmed the handoff/i)).toBeVisible()
    await expect(scanned.getByText(/both of you confirmed the handoff/i)).toBeVisible()
    await expect(second.page.getByText(/both of you confirmed the handoff/i)).toBeVisible()

    expect(settledRows()).toBe(before + 1)
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
})

test('closing the tab the link opened does not tear the match down', async ({ browser }) => {
  // The other half of the same change. A browser can now hold two sockets on one
  // side of a match, and a disconnect used to mean "my buddy walked away" —
  // unconditionally. Closing the tab a camera opened would have requeued the
  // orderer, or disputed the match outright once somebody had confirmed.
  const first = await openPromptless(browser, BUYERS.orderer)
  const second = await openPromptless(browser, BUYERS.receiver)
  const contexts = [first.context, second.context]

  try {
    await first.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(first.page.getByText(/looking for a bud/i)).toBeVisible()
    await second.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(
      first.page.getByText(`You order the box. ${BUYERS.receiver.name} comes to you.`),
    ).toBeVisible()

    const code = await first.page.getByText(/^[A-Z0-9]{6}$/).innerText()
    const origin = new URL(first.page.url()).origin

    const scanned = await second.context.newPage()
    await scanned.goto(handoffUrl(origin, code))
    await expect(scanned.getByPlaceholder('------')).toHaveValue(code)
    await scanned.close()

    // Nothing happened to anybody. The orderer is still in the match, the
    // receiver's original tab is still in it, and it is still confirmable.
    await first.page.waitForTimeout(500)
    await expect(first.page.getByText(/your bud dropped out/i)).toHaveCount(0)
    await expect(first.page.getByText(/flagged for review/i)).toHaveCount(0)
    await expect(first.page.getByRole('button', { name: /handed it over/i })).toBeEnabled()

    await second.page.getByPlaceholder('------').fill(code)
    await second.page.getByRole('button', { name: /got the box/i }).click()
    await expect(second.page.getByText(/waiting on/i)).toBeVisible()
    await first.page.getByRole('button', { name: /handed it over/i }).click()
    await expect(second.page.getByText(/both of you confirmed the handoff/i)).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
})
