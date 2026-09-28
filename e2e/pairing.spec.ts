import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { FIXTURE_COORDS } from '../scripts/pool-fixtures.mjs'
import { findDeal } from '../shared/deals'
import { formatCents, settle } from '../shared/economics'
import {
  DEFAULT_MATCH_RADIUS_METERS,
  distanceMeters,
  formatDistance,
  formatMiles,
} from '../shared/geo'
import { describeLocationSource } from '../shared/location'
import { describeSauceOrder, findSauce, readSauceHoroscope } from '../shared/sauces'

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

/**
 * A seeded account id, shaped like a real one: `users.id` is a
 * `crypto.randomUUID()`, and the ledger refuses to book money against an id that
 * could not have come out of a sign-in (`shared/identity.ts`).
 */
const accountId = (n: number): string => `e2ee2ee2-0000-4000-8000-${String(n).padStart(12, '0')}`

const BUYERS = {
  nova: { sid: sessionId('e2e-nova'), userId: accountId(1), name: 'Nova' },
  remy: { sid: sessionId('e2e-remy'), userId: accountId(2), name: 'Remy' },
  ivy: { sid: sessionId('e2e-ivy'), userId: accountId(3), name: 'Ivy' },
  // Picks a sauce pair in one browser session and expects it back in the next.
  pax: { sid: sessionId('e2e-pax'), userId: accountId(4), name: 'Pax' },
  // The requeue spec: a buyer whose bud walks away mid-conversation, the bud who
  // walks, and the stranger they are matched with next.
  orla: { sid: sessionId('e2e-orla'), userId: accountId(5), name: 'Orla' },
  pace: { sid: sessionId('e2e-pace'), userId: accountId(6), name: 'Pace' },
  quin: { sid: sessionId('e2e-quin'), userId: accountId(7), name: 'Quin' },
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

/**
 * Give the seeded sessions the `users` rows a real sign-in would have created.
 *
 * `user_sauces` hangs off `users` by foreign key (`migrations/0003_sauce_prefs.sql`),
 * so a preference written for a session with no account behind it is refused —
 * correctly. Seeding accounts makes these fixtures resemble signed-in buyers
 * rather than loosening the schema for a test's convenience.
 */
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
 * Where these browsers say they are standing.
 *
 * The coordinates come from `scripts/pool-fixtures.mjs`, the one table every
 * live-pairing lane in this repo shares, and `test/fixture-separation.test.ts`
 * is what keeps each scenario's market more than a hundred kilometres from every
 * other one — including from `DEMO_ORIGIN`, where the promptless spec at the
 * bottom of this file inevitably lands. Since #82 a market is a *distance* (two
 * miles) rather than a geohash cell, so isolation cannot be argued from a cell
 * string any more: it has to be measured, and it is, there rather than here.
 */
const asGeolocation = (id: string) => ({
  latitude: FIXTURE_COORDS[id].lat,
  longitude: FIXTURE_COORDS[id].lng,
})

const BUDDY_A = asGeolocation('e2eBuddyA')
const BUDDY_B = asGeolocation('e2eBuddyB')

/**
 * What the pair's receipts must say the walk is, computed from the fixtures with
 * the app's own formatter.
 *
 * This is the assertion that keeps the geolocation override from going
 * decorative. `App.tsx` no longer prints the shard — it is not a unit anybody
 * reads — so the old "cell 9q8yy1 is on screen" check is gone, and a rung badge
 * alone would be weaker: it says *which* rung answered, not that the coordinates
 * it produced were these ones. Forty metres does: drop back to `edge` or `demo`
 * and both contexts land on one identical server-resolved point, where the walk
 * would be nought.
 */
const expectedWalk = formatDistance(
  distanceMeters(FIXTURE_COORDS.e2eBuddyA, FIXTURE_COORDS.e2eBuddyB),
)

/** A second market, for the requeue spec below. */
const REQUEUE_AT = [
  asGeolocation('e2eOrla'),
  asGeolocation('e2ePace'),
  asGeolocation('e2eQuin'),
] as const

const deal = findDeal(DEAL_ID)
if (deal === undefined) throw new Error(`fixture deal missing: ${DEAL_ID}`)
const settlement = settle(deal, 2)
// Both shares are equal here (an even split with no remainder), so either index works.
const expectedHalf = formatCents(settlement.shares[0].payCents)
const expectedSavings = formatCents(settlement.shares[0].savingsCents)

/**
 * The pairs these buyers pick, resolved from the catalogue rather than typed out:
 * a sauce leaving the menu has to fail here, not render a blank card. One pair and
 * one double, because a double order of a single sauce is a selection too.
 */
function sauce(id: string) {
  const found = findSauce(id)
  if (found === undefined) throw new Error(`fixture sauce missing: ${id}`)
  return found
}

const NOVA_SAUCES = [sauce('mcd-hot-mustard'), sauce('mcd-ketchup')] as const
const REMY_SAUCES = [sauce('mcd-sweet-n-sour'), sauce('mcd-sweet-n-sour')] as const
const NOVA_ORDER = describeSauceOrder(NOVA_SAUCES[0], NOVA_SAUCES[1])
const REMY_ORDER = describeSauceOrder(REMY_SAUCES[0], REMY_SAUCES[1])

/** Tap a pair on the sauce chart. The same sauce twice is a double order. */
async function pickSauces(
  page: import('@playwright/test').Page,
  pair: readonly [{ label: string }, { label: string }],
): Promise<void> {
  for (const picked of pair) {
    await page.getByRole('button', { name: picked.label }).first().click()
  }
}

test.beforeAll(() => {
  seedSessions()
  applyMigrations()
  seedUsers()
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

    // The overridden geolocation above only routes anyone if the page asks the
    // device for it, and `App.tsx` deliberately never does that on its own --
    // pairing must not produce a permission prompt. So this suite has to tap the
    // opt-in control the way a buyer who wants an accurate walk would. Skip it
    // and both contexts join with no coordinates, the server places both from
    // its own `edge`/`demo` rung, and they pair in one shared fallback cell
    // having never used the overrides at all.
    await pageA.getByRole('button', { name: /use my exact location/i }).click()
    await pageB.getByRole('button', { name: /use my exact location/i }).click()
    // The control is replaced by this line once a fix is in hand, so it doubles
    // as the signal that the browser actually answered.
    await expect(pageA.getByText(/exact location on/i)).toBeVisible()
    await expect(pageB.getByText(/exact location on/i)).toBeVisible()

    // The sauce chart, before anyone queues. The reading is a pure function of the
    // pair (`shared/sauces.ts`), so the expected lines are computed here from the
    // same catalogue the page renders from — not pasted in.
    await pickSauces(pageA, NOVA_SAUCES)
    await pickSauces(pageB, REMY_SAUCES)
    const novaReading = readSauceHoroscope(NOVA_SAUCES[0], NOVA_SAUCES[1])
    await expect(pageA.getByText(novaReading.lines[0])).toBeVisible()
    await expect(pageA.getByText(novaReading.lines[1])).toBeVisible()
    await expect(pageA.getByText(NOVA_ORDER, { exact: true })).toBeVisible()

    // Nova joins first and waits, so `findMatch`'s fairness rule (the longest
    // waiter orders) makes her the deterministic orderer once Remy joins.
    await pageA.getByRole('button', { name: /find a bud/i }).click()
    await expect(pageA.getByText(/looking for a bud/i)).toBeVisible()

    // The market is named as a distance, never as a shard: "within 2 mi", with
    // the figure coming from the server over the protocol rather than from any
    // literal in the client.
    await expect(
      pageA.getByText(`within ${formatMiles(DEFAULT_MATCH_RADIUS_METERS)}`).first(),
    ).toBeVisible()
    await expect(pageA.getByText(/cell/i)).toHaveCount(0)

    // Now the part the override is for. The header names the market in force and
    // the rung that produced this socket's position, and the map is drawn from
    // both -- on every rung, which is what #82 changed: this used to appear only
    // for a buyer who had answered a permission prompt.
    const clientBadge = describeLocationSource('client').label
    // `.first()` only because the badge text is also inside its wrapper's text
    // content; a miss still fails, since an empty locator is never visible.
    await expect(pageA.getByText(clientBadge).first()).toBeVisible()
    // The map, with the circle in it, on the screen of the buyer who is waiting.
    // Nova is the only one who can be asserted on here: Remy is matched the
    // instant she joins, and a matched buyer is looking at a receipt.
    await expect(pageA.locator('.leaflet-container')).toBeVisible()
    await expect(pageA.locator('path.leaflet-interactive')).toBeVisible()
    await expect(pageA.getByText(describeLocationSource('client').detail)).toBeVisible()

    await pageB.getByRole('button', { name: /find a bud/i }).click()

    await expect(pageB.getByText(clientBadge).first()).toBeVisible()

    await expect(pageA.getByText('Matched')).toBeVisible()
    await expect(pageB.getByText('Matched')).toBeVisible()

    // Complementary roles: whoever waited longer places the order.
    await expect(
      pageA.getByText(`You order the box. ${BUYERS.remy.name} comes to you.`),
    ).toBeVisible()
    await expect(pageB.getByText(`${BUYERS.nova.name} orders the box. Go meet them.`)).toBeVisible()

    // The walk between them, computed from the fixtures with the app's own
    // formatter. This is what makes the geolocation override load-bearing: if
    // either context had fallen back to a server-resolved position, both would
    // be standing on the same point and this distance would not be on screen.
    // It is also where the units changed in #82 -- feet and miles, because the
    // radius on the header is quoted in miles and a buddy card answering in
    // kilometres would be a second system to translate between.
    await expect(pageA.getByText(expectedWalk)).toBeVisible()
    await expect(pageB.getByText(expectedWalk)).toBeVisible()

    // Both receipts show the real settlement for this deal, computed by
    // `shared/economics.ts` rather than assumed here.
    await expect(pageA.getByText(expectedHalf, { exact: true })).toBeVisible()
    await expect(pageA.getByText(expectedSavings, { exact: true })).toBeVisible()
    await expect(pageB.getByText(expectedHalf, { exact: true })).toBeVisible()
    await expect(pageB.getByText(expectedSavings, { exact: true })).toBeVisible()

    // Both receipts carry both pairs, because the practical point of the feature is
    // that one of these two is about to be standing at a counter ordering for both
    // of them. Each buddy's pair arrives over the socket as validated ids and is
    // resolved to a label through the catalogue.
    await expect(pageA.getByText(NOVA_ORDER, { exact: true })).toBeVisible()
    await expect(pageA.getByText(REMY_ORDER, { exact: true })).toBeVisible()
    await expect(pageB.getByText(NOVA_ORDER, { exact: true })).toBeVisible()
    await expect(pageB.getByText(REMY_ORDER, { exact: true })).toBeVisible()

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

    // Nuggchat. Two strangers who have never met need to find each other at a
    // counter, and this is the channel for it: relayed between the two matched
    // buddies and stored nowhere. `scripts/smoke.mjs` proves the "stored
    // nowhere" half by scanning D1 and the Durable Object's own files; this
    // proves the half a person experiences — the message arrives on the other
    // screen, the promise about it is on screen too, and both are gone when the
    // match is.
    const novaSays = 'by the drinks in a grey hoodie'
    await pageA.getByLabel(`Message ${BUYERS.remy.name}`).fill(novaSays)
    await pageA.getByRole('button', { name: /^send$/i }).click()
    await expect(pageB.getByText(novaSays)).toBeVisible()
    // Echoed back to the sender, so both are reading the same sanitized line
    // rather than the sender reading their own draft.
    await expect(pageA.getByText(novaSays)).toBeVisible()
    // Attributed off the connection, so the sender sees their own line as theirs.
    await expect(pageA.getByRole('listitem').last()).toContainText('You')

    // The honest-tone requirement, in the same register as the location notices
    // in `src/hooks/useCoords.ts` and the demo-mode notice: say plainly what the
    // software does, including when what it does is nothing.
    await expect(pageA.getByText(/nothing here is saved/i)).toBeVisible()
    await expect(pageB.getByText(/disappears the moment this match is done/i)).toBeVisible()

    const remySays = 'two minutes out'
    await pageB.getByLabel(`Message ${BUYERS.nova.name}`).fill(remySays)
    await pageB.getByRole('button', { name: /^send$/i }).click()
    await expect(pageA.getByText(remySays)).toBeVisible()

    // Hostile text typed into the real input: a zero-width space and a
    // right-to-left override, the primitive that makes a string render
    // differently from its bytes. The server cleans it on the way through, so
    // what the other buddy is shown is the stripped form -- never the original.
    await pageA.getByLabel(`Message ${BUYERS.remy.name}`).fill('look​for‮the hat')
    await pageA.getByRole('button', { name: /^send$/i }).click()
    const smuggledLine = pageB.getByRole('listitem').last()
    await expect(smuggledLine).toContainText('lookforthe hat')
    // Read the bytes the browser actually rendered rather than trusting a text
    // matcher that might normalize invisible characters away for us.
    const rendered = await smuggledLine.innerText()
    expect(rendered).not.toContain('​')
    expect(rendered).not.toContain('‮')

    await pageB.getByPlaceholder('------').fill(code)
    await pageB.getByRole('button', { name: /got the box/i }).click()
    await expect(pageB.getByText(/waiting on/i)).toBeVisible()

    await pageA.getByRole('button', { name: /handed it over/i }).click()
    await expect(pageA.getByText(/both of you confirmed the handoff/i)).toBeVisible()
    await expect(pageB.getByText(/both of you confirmed the handoff/i)).toBeVisible()

    // Settled, and the conversation is gone from both screens along with the
    // means to continue it. The receipt stays; the chat does not.
    //
    // This is the *screen* claim only. It holds because the settled receipt does
    // not render the chat at all, so it would keep holding even if the hook
    // forgot to empty its state — which is why the spec below exercises the
    // state directly, and why `scripts/smoke.mjs` refuses a message sent after
    // this point on the server rather than trusting the client to stop asking.
    await expect(pageA.getByText(novaSays)).toHaveCount(0)
    await expect(pageA.getByText(remySays)).toHaveCount(0)
    await expect(pageB.getByText(novaSays)).toHaveCount(0)
    await expect(pageB.getByText(remySays)).toHaveCount(0)
    await expect(pageA.getByText(/nothing here is saved/i)).toHaveCount(0)
    await expect(pageA.getByLabel(`Message ${BUYERS.remy.name}`)).toHaveCount(0)
  } finally {
    await contextA.close()
    await contextB.close()
  }
})

test('a new match starts with an empty conversation, never the last one', async ({ browser }) => {
  // The claim this spec exists for, and the one the settled screen above cannot
  // make: the transcript is client state, and it has to be emptied rather than
  // merely hidden. A buyer whose bud walks away mid-conversation is requeued on
  // the *same socket* and matched with somebody else -- so if the hook keeps the
  // old lines, a stranger is shown what the previous stranger typed. Two
  // independent clears guard this (`buddy_left` and `matched` in
  // `src/hooks/useCoords.ts`'s neighbour `usePool.ts`); this asserts the outcome,
  // so it fails if both of them go.
  const contexts = await Promise.all(
    REQUEUE_AT.map((geolocation) =>
      browser.newContext({ geolocation, permissions: ['geolocation'] }),
    ),
  )
  const [orlaCtx, paceCtx, quinCtx] = contexts
  const orla = await orlaCtx.newPage()
  const pace = await paceCtx.newPage()
  const quin = await quinCtx.newPage()

  try {
    await signIn(orla, BUYERS.orla)
    await signIn(pace, BUYERS.pace)
    await signIn(quin, BUYERS.quin)
    for (const page of [orla, pace, quin]) {
      await page.goto('/')
      await page.getByRole('button', { name: /use my exact location/i }).click()
      await expect(page.getByText(/exact location on/i)).toBeVisible()
    }

    // Orla waits, so she is the deterministic orderer of both matches below.
    await orla.getByRole('button', { name: /find a bud/i }).click()
    await expect(orla.getByText(describeLocationSource('client').label).first()).toBeVisible()
    await pace.getByRole('button', { name: /find a bud/i }).click()
    await expect(orla.getByText(`${BUYERS.pace.name} comes to you.`)).toBeVisible()

    const toPace = 'wearing a red scarf, by the till'
    await orla.getByLabel(`Message ${BUYERS.pace.name}`).fill(toPace)
    await orla.getByRole('button', { name: /^send$/i }).click()
    await expect(pace.getByText(toPace)).toBeVisible()

    // Pace closes the tab and walks off. Orla goes back to the queue.
    await paceCtx.close()
    await expect(orla.getByText(/your bud dropped out/i)).toBeVisible()

    // A different stranger arrives and is matched with her.
    await quin.getByRole('button', { name: /find a bud/i }).click()
    await expect(orla.getByText(`${BUYERS.quin.name} comes to you.`)).toBeVisible()

    // The discriminating assertion: what Orla told Pace must not be on the screen
    // she now shares with Quin, and the transcript must read as untouched.
    await expect(orla.getByText(toPace)).toHaveCount(0)
    await expect(
      orla.getByText(`Say where you are standing. ${BUYERS.quin.name} sees it straight away.`),
    ).toBeVisible()
    await expect(orla.getByRole('listitem')).toHaveCount(0)

    // And the channel really is live again on that same socket, not just blank.
    const toQuin = 'still here, still red scarf'
    await orla.getByLabel(`Message ${BUYERS.quin.name}`).fill(toQuin)
    await orla.getByRole('button', { name: /^send$/i }).click()
    await expect(quin.getByText(toQuin)).toBeVisible()
    // Quin never sees the conversation he was not part of.
    await expect(quin.getByText(toPace)).toHaveCount(0)
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
})

test('leaving the queue does not immediately rejoin, and a refused prompt still pairs', async ({
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

    // Ask for precise location and get refused. Nothing about pairing depends on
    // this succeeding -- the point is that a refusal leaves the flow intact
    // rather than dead-ending it, which is only worth asserting if something
    // actually did the asking.
    await page.getByRole('button', { name: /use my exact location/i }).click()
    const refusalNotice = page.getByText(
      'Location is off. Pairing still works — you are placed by your connection.',
    )
    await expect(refusalNotice).toBeVisible()

    await findButton.click()

    // Queued anyway. The server placed this socket from its own location --
    // `edge` when the runtime has a usable `request.cf`, `demo` when it does
    // not -- so the rung is one of those two and never `client`, because this
    // page has no coordinates to send. Which point the `demo` rung lands on is
    // not asserted here on purpose; that is 2am-nuggbudz#45.
    await expect(page.getByText(/looking for a bud/i)).toBeVisible()
    await expect(page.getByText(describeLocationSource('client').label)).toHaveCount(0)
    await expect(
      page
        .getByText(
          new RegExp(
            `${describeLocationSource('edge').label}|${describeLocationSource('demo').label}`,
            'i',
          ),
        )
        .first(),
    ).toBeVisible()

    // The map is here too, which is the other half of #82: the server always
    // knows where it placed a socket, so a buyer who refused the prompt gets the
    // same picture as one who accepted it -- and a line saying, in as many words,
    // which rung that centre came from. A buyer on the demo origin is told it is
    // not their position.
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('path.leaflet-interactive')).toBeVisible()
    // Whichever of the two promptless rungs answered, it has to say so in words.
    // Matched as plain text rather than a regex: this copy carries an em dash and
    // a colon, and escaping it by hand is how a check quietly stops matching
    // anything (it did, once, in this very spec).
    await expect(
      page
        .getByText(describeLocationSource('edge').detail)
        .or(page.getByText(describeLocationSource('demo').detail)),
    ).toBeVisible()
    await expect(page.getByText(/cell/i)).toHaveCount(0)

    // This was a real bug: leaving must not re-run the join because location
    // and deal state are still set (see the comment on `start` in `App.tsx`).
    await page.getByRole('button', { name: /leave the queue/i }).click()
    await expect(findButton).toBeVisible()
    await page.waitForTimeout(500)
    await expect(page.getByText(/looking for a bud|standing in line/i)).toHaveCount(0)

    // Back on the idle screen, the refusal notice is still there -- the on-screen
    // record that the buyer was placed without a fix of their own.
    await expect(refusalNotice).toBeVisible()
  } finally {
    await context.close()
  }
})

test('a sauce pair is remembered, and reads the same every time', async ({ browser }) => {
  const reading = readSauceHoroscope(NOVA_SAUCES[0], NOVA_SAUCES[1])
  const first = await browser.newContext()
  const page = await first.newPage()

  try {
    await signIn(page, BUYERS.pax)
    await page.goto('/')

    // Wait for the write to reach the account, rather than racing the reload
    // below against it.
    const stored = page.waitForResponse(
      (response) =>
        response.url().includes('/api/me/sauces') && response.request().method() === 'PUT',
    )
    await pickSauces(page, NOVA_SAUCES)
    expect((await stored).ok()).toBe(true)

    await expect(page.getByText(NOVA_ORDER, { exact: true })).toBeVisible()
    await expect(page.getByText(reading.lines[0])).toBeVisible()
    await expect(page.getByText(reading.lines[1])).toBeVisible()

    // The pair is in `localStorage` too, which is the *only* home a demo buyer has
    // — they deliberately have no account (`shared/demo.ts`), so this is the thing
    // that makes their pair survive a reload. Asserted here because this dev server
    // runs with demo pairing off, so no browser test can sign in as one.
    const remembered = await page.evaluate(() => localStorage.getItem('nuggbudz.sauces'))
    expect(JSON.parse(remembered ?? 'null')).toEqual([NOVA_SAUCES[0].id, NOVA_SAUCES[1].id])

    // A reload must not reroll the reading. This is the assertion the whole
    // "derived, never random" rule exists for: a buyer who refreshes and reads
    // something new has learned the feature is noise.
    await page.reload()
    await expect(page.getByText(NOVA_ORDER, { exact: true })).toBeVisible()
    await expect(page.getByText(reading.lines[0])).toBeVisible()
    await expect(page.getByText(reading.lines[1])).toBeVisible()
  } finally {
    await first.close()
  }

  // A brand-new context: empty localStorage, same account. Only the row written
  // by `PUT /api/me/sauces` can put the pair back on this screen, which is what
  // "survives a sign-out and a sign-in" means for a signed-in buyer.
  const second = await browser.newContext()
  const laterPage = await second.newPage()
  try {
    await signIn(laterPage, BUYERS.pax)
    await laterPage.goto('/')
    await expect(laterPage.getByText(NOVA_ORDER, { exact: true })).toBeVisible()
    await expect(laterPage.getByText(reading.lines[0])).toBeVisible()
  } finally {
    await second.close()
  }
})
