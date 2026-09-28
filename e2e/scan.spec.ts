import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Browser, type BrowserContext, expect, type Page, test } from '@playwright/test'
import jsQR from 'jsqr'
import { FIXTURE_COORDS } from '../scripts/pool-fixtures.mjs'
import { SESSION_COOKIE } from '../shared/auth'
import { DEFAULT_POOL_CELL_PRECISION, geohash } from '../shared/geo'
import { pickupCodeFromScan, qrPayloadFor } from '../shared/handoff'
import { generatePickupCode } from '../shared/pickup'
import { pickupQrMatrix, QR_QUIET_ZONE_MODULES, qrSpanModules } from '../shared/qr'
import { FAKE_CAMERA_ARGS, type GreyscaleImage, showToFakeCamera } from './fake-camera'

/**
 * The scanned handoff, end to end, with a camera in the loop.
 *
 * The pickup code is never sent to the receiver by the server — that is the
 * invariant that makes the two-sided handshake mean something. A QR preserves it
 * exactly: the code travels through the air on a camera rather than over the
 * network, which is why this feature needed no protocol change, no
 * `PROTOCOL_VERSION` bump and no new message. Nothing in this file sends one.
 *
 * What makes these tests worth their runtime is *where the picture comes from*.
 * Chromium's fake video device is fed a frame built out of the pixels read back
 * off the orderer's own rendered canvas, in the orderer's own browser. So the
 * chain under test is: server issues a code → orderer's receipt draws it →
 * camera sees that drawing → `jsQR` decodes it → the field the receiver would
 * have typed into is filled → `confirm_pickup` validates it unchanged → the
 * match settles and lands in D1. Calling the decoder directly would have proved
 * none of that, and this repo has four shipped defects that all looked like a
 * green unit test on a path nothing called.
 */

test.use({ launchOptions: { args: FAKE_CAMERA_ARGS } })

const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

const sessionId = (label: string): string => label.padEnd(43, '0').slice(0, 43)

/**
 * A seeded account id, shaped like a real one.
 *
 * `users.id` is a `crypto.randomUUID()` and `shared/identity.ts` refuses to book
 * money against an id that could not have come out of a sign-in, so these have to
 * be real UUIDs — these tests settle to the ledger. The prefix is this file's own
 * so it cannot collide with `e2e/pairing.spec.ts`'s accounts.
 */
const accountId = (n: number): string => `5ca27e5c-0000-4000-8000-${String(n).padStart(12, '0')}`

/**
 * Two buyers per scenario, because each scenario owns a market of its own.
 *
 * Coordinates come from `scripts/pool-fixtures.mjs`, the one table every
 * live-pairing lane shares, and `test/fixture-separation.test.ts` is what keeps
 * each of these markets more than a hundred kilometres from every other
 * scenario's — including from `DEMO_ORIGIN`. It matters more here than in most
 * lanes: a stray buyer wandering in from a neighbouring scenario would not add
 * noise, it would pair with the wrong person and take the pickup code with it.
 */
const SCENARIOS = {
  scanned: {
    orderer: { sid: sessionId('e2e-scan-a'), userId: accountId(1), name: 'Sol', at: 'e2eScanA' },
    receiver: { sid: sessionId('e2e-scan-b'), userId: accountId(2), name: 'Wren', at: 'e2eScanB' },
  },
  wrongCode: {
    orderer: {
      sid: sessionId('e2e-wrong-a'),
      userId: accountId(3),
      name: 'Tam',
      at: 'e2eWrongCodeA',
    },
    receiver: {
      sid: sessionId('e2e-wrong-b'),
      userId: accountId(4),
      name: 'Bex',
      at: 'e2eWrongCodeB',
    },
  },
  noCamera: {
    orderer: {
      sid: sessionId('e2e-nocam-a'),
      userId: accountId(5),
      name: 'Juno',
      at: 'e2eNoCameraA',
    },
    receiver: {
      sid: sessionId('e2e-nocam-b'),
      userId: accountId(6),
      name: 'Rilo',
      at: 'e2eNoCameraB',
    },
  },
  unmount: {
    orderer: {
      sid: sessionId('e2e-unmnt-a'),
      userId: accountId(7),
      name: 'Odie',
      at: 'e2eUnmountA',
    },
    receiver: {
      sid: sessionId('e2e-unmnt-b'),
      userId: accountId(8),
      name: 'Pim',
      at: 'e2eUnmountB',
    },
  },
  noChunk: {
    orderer: {
      sid: sessionId('e2e-nochnk-a'),
      userId: accountId(9),
      name: 'Vera',
      at: 'e2eNoChunkA',
    },
    receiver: {
      sid: sessionId('e2e-nochnk-b'),
      userId: accountId(10),
      name: 'Hugo',
      at: 'e2eNoChunkB',
    },
  },
} as const

type Buyer = { sid: string; userId: string; name: string; at: string }

const everyBuyer: Buyer[] = Object.values(SCENARIOS).flatMap((pair) => [
  pair.orderer,
  pair.receiver,
])

function applyMigrations(): void {
  // Without the ledger tables, `worker/pool.ts`'s write throws "no such table:
  // matches" and swallows it by design — a ledger outage must not strand two
  // buddies who already swapped nuggets — so the settled-row assertion below
  // would quietly be checking nothing.
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nuggbudz', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

function seedUsers(): void {
  const now = Date.now()
  const values = everyBuyer
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
  const entries = everyBuyer.map((buyer) => ({
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
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-scan-')), 'sessions.json')
  writeFileSync(file, JSON.stringify(entries))
  execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

/** Settled rows the ledger holds for one market's shard. */
function settledRows(at: string): number {
  const coord = FIXTURE_COORDS[at]
  const cell = geohash(coord.lat, coord.lng, DEFAULT_POOL_CELL_PRECISION)
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

const asGeolocation = (id: string) => ({
  latitude: FIXTURE_COORDS[id].lat,
  longitude: FIXTURE_COORDS[id].lng,
})

async function signIn(page: Page, buyer: Buyer): Promise<void> {
  await page.context().addCookies([
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

/** A signed-in browser standing on a fixture, with the exact-location opt-in taken. */
async function openAt(
  browser: Browser,
  buyer: Buyer,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    geolocation: asGeolocation(buyer.at),
    permissions: ['geolocation', 'camera'],
  })
  const page = await context.newPage()
  await signIn(page, buyer)
  await page.goto('/')
  await expect(page.getByRole('button', { name: /find a bud/i })).toBeEnabled()
  // `App.tsx` never asks the device for a position on its own, so the override
  // above only routes anybody if the opt-in is tapped the way a buyer wanting an
  // accurate walk would. Skip it and both contexts land on one server-resolved
  // point in a market this table has reserved for exactly that.
  await page.getByRole('button', { name: /use my exact location/i }).click()
  await expect(page.getByText(/exact location on/i)).toBeVisible()
  return { context, page }
}

/**
 * Pair two browsers and stop at the handoff, with the orderer's code in hand.
 *
 * The orderer queues first, so `findMatch`'s fairness rule (the longest waiter
 * places the order) makes the roles deterministic rather than a coin toss.
 */
async function pairUp(
  browser: Browser,
  pair: { orderer: Buyer; receiver: Buyer },
): Promise<{
  contexts: BrowserContext[]
  orderer: Page
  receiver: Page
  code: string
}> {
  const first = await openAt(browser, pair.orderer)
  const second = await openAt(browser, pair.receiver)
  const contexts = [first.context, second.context]

  await first.page.getByRole('button', { name: /find a bud/i }).click()
  await expect(first.page.getByText(/looking for a bud/i)).toBeVisible()
  await second.page.getByRole('button', { name: /find a bud/i }).click()

  await expect(
    first.page.getByText(`You order the box. ${pair.receiver.name} comes to you.`),
  ).toBeVisible()
  await expect(
    second.page.getByText(`${pair.orderer.name} orders the box. Go meet them.`),
  ).toBeVisible()

  const code = await first.page.getByText(/^[A-Z0-9]{6}$/).innerText()
  expect(code).toMatch(/^[A-Z0-9]{6}$/)
  return { contexts, orderer: first.page, receiver: second.page, code }
}

/** The QR element on the orderer's receipt. */
const qrOf = (page: Page) => page.getByRole('img', { name: /pickup code/i })

/**
 * Read the orderer's QR back out of their own browser as greyscale pixels.
 *
 * This is why `PickupQr` draws to a canvas rather than an SVG. What goes into the
 * synthetic camera is the picture this browser actually rendered — not a second
 * render of the same matrix in the test, which would only have proved the two
 * halves of the test agree with each other.
 */
async function photograph(page: Page): Promise<GreyscaleImage> {
  return await qrOf(page).evaluate((node) => {
    const canvas = node as HTMLCanvasElement
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('the pickup QR has no 2d context')
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let luma = ''
    // The symbol is black on white, so the red channel is the whole picture.
    for (let at = 0; at < data.length; at += 4) luma += String.fromCharCode(data[at])
    return { width: canvas.width, height: canvas.height, luma: btoa(luma) }
  })
}

/**
 * A QR of `code` as greyscale pixels, drawn here rather than by a browser.
 *
 * Only used by the wrong-code scenario, where the picture is a prop and the thing
 * under test is the server's refusal. `origin` is the page's own, so the forged
 * symbol is indistinguishable from a real receipt's apart from the code in it.
 */
function greyscaleQr(code: string, origin: string, scale = 8): GreyscaleImage {
  const matrix = pickupQrMatrix(code, origin)
  const span = qrSpanModules(matrix) * scale
  const luma = Buffer.alloc(span * span, 255)
  for (const [row, cells] of matrix.entries()) {
    for (const [column, dark] of cells.entries()) {
      if (!dark) continue
      for (let dy = 0; dy < scale; dy += 1) {
        const y = (row + QR_QUIET_ZONE_MODULES) * scale + dy
        const x = (column + QR_QUIET_ZONE_MODULES) * scale
        luma.fill(0, y * span + x, y * span + x + scale)
      }
    }
  }
  return { width: span, height: span, luma: luma.toString('base64') }
}

/** What a decoder makes of that picture, before any camera is involved. */
function decode(image: GreyscaleImage): string | null {
  const luma = Buffer.from(image.luma, 'base64')
  const rgba = new Uint8ClampedArray(image.width * image.height * 4)
  for (let pixel = 0; pixel < luma.length; pixel += 1) {
    rgba[pixel * 4] = luma[pixel]
    rgba[pixel * 4 + 1] = luma[pixel]
    rgba[pixel * 4 + 2] = luma[pixel]
    rgba[pixel * 4 + 3] = 255
  }
  return jsQR(rgba, image.width, image.height)?.data ?? null
}

/**
 * Record every camera track the page is handed, so a test can check they were
 * given back.
 *
 * Instrumentation, not a product hook: the app has no reason to publish its
 * `MediaStream`s, and a `data-` attribute saying "the camera is off" would be the
 * app's own claim about itself rather than the browser's.
 */
async function watchCameraTracks(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const devices = navigator.mediaDevices
    const real = devices.getUserMedia.bind(devices)
    const handed: MediaStreamTrack[] = []
    Object.defineProperty(window, '__nbCameraTracks', { get: () => handed })
    devices.getUserMedia = async (constraints) => {
      const stream = await real(constraints)
      handed.push(...stream.getTracks())
      return stream
    }
  })
}

const trackStates = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    (window as unknown as { __nbCameraTracks: MediaStreamTrack[] }).__nbCameraTracks.map(
      (track) => track.readyState,
    ),
  )

test('a code read off the orderer’s screen by a camera settles the match', async ({ browser }) => {
  const pair = SCENARIOS.scanned
  const before = settledRows(pair.orderer.at)
  const { contexts, orderer, receiver, code } = await pairUp(browser, pair)

  try {
    // Only the orderer is issued a code, so only the orderer has a symbol to
    // show. `pool.ts` fills `pickupCode` for them alone, and the receipt's
    // non-null gate is the same gate the QR is behind.
    await expect(qrOf(orderer)).toBeVisible()
    await expect(qrOf(receiver)).toHaveCount(0)
    await expect(receiver.getByText(/^[A-Z0-9]{6}$/)).toHaveCount(0)

    // What the orderer's screen is actually showing, and what it says. Since
    // #101 that is a handoff link for this code — and nothing beside it: no
    // match id, no user id, no session token.
    const shown = await photograph(orderer)
    const origin = new URL(orderer.url()).origin
    expect(decode(shown), 'the rendered QR must carry the handoff link and nothing else').toBe(
      qrPayloadFor(origin, code),
    )
    expect(pickupCodeFromScan(decode(shown) ?? '')).toBe(code)

    // Point the synthetic camera at that picture, then let the receiver tap.
    showToFakeCamera(shown)
    const field = receiver.getByPlaceholder('------')
    await expect(field).toHaveValue('')
    await receiver.getByRole('button', { name: /scan their code/i }).click()

    // The whole claim of the feature, in one assertion: this test never typed
    // into that field, and the code the server issued is now in it.
    await expect(field).toHaveValue(code)
    await expect(receiver.getByText(/scanned\./i)).toBeVisible()

    // And a scan is not a confirmation. Nothing has settled at this point.
    await expect(receiver.getByText(/both of you confirmed the handoff/i)).toHaveCount(0)
    await expect(receiver.getByRole('button', { name: /got the box/i })).toBeEnabled()

    await receiver.getByRole('button', { name: /got the box/i }).click()
    await expect(receiver.getByText(/waiting on/i)).toBeVisible()
    await orderer.getByRole('button', { name: /handed it over/i }).click()

    await expect(orderer.getByText(/both of you confirmed the handoff/i)).toBeVisible()
    await expect(receiver.getByText(/both of you confirmed the handoff/i)).toBeVisible()

    // The settled screen is the server's word, not the client's: it arrives as
    // `pickup_settled` over the socket. The ledger row is the durable half.
    expect(settledRows(pair.orderer.at)).toBe(before + 1)

    // The camera is handed back the instant the code is read, not when the match
    // ends — a viewfinder left running through a handoff is a battery bug and a
    // privacy bug at once.
    await expect(receiver.getByRole('button', { name: /stop the camera/i })).toHaveCount(0)
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
})

test('a scanned QR from another match is refused, and typing still settles it', async ({
  browser,
}) => {
  const pair = SCENARIOS.wrongCode
  const { contexts, orderer, receiver, code } = await pairUp(browser, pair)

  try {
    // A well-formed pickup code for a match these two are not in. Shaped exactly
    // like the real thing, which is the point: the client cannot tell, and must
    // not try to — the server owns that answer.
    let stranger = generatePickupCode()
    while (stranger === code) stranger = generatePickupCode()

    // Drawn in Node rather than by the orderer's browser, and deliberately so:
    // the picture in the first test has to come off a real receipt because the
    // claim there is about what the receipt renders. The claim here is about what
    // the *server* does with a foreign code, so all this picture has to be is a
    // valid QR of one.
    const forged = greyscaleQr(stranger, new URL(receiver.url()).origin)

    showToFakeCamera(forged)
    const field = receiver.getByPlaceholder('------')
    await receiver.getByRole('button', { name: /scan their code/i }).click()
    await expect(field).toHaveValue(stranger)

    // A refusal, in as many words, from the server — not a silent no-op and not a
    // client-side guess about whose code this is.
    await receiver.getByRole('button', { name: /got the box/i }).click()
    await expect(receiver.getByText(/that is not your bud's pickup code/i)).toBeVisible()
    await expect(receiver.getByText(/both of you confirmed the handoff/i)).toHaveCount(0)
    await expect(receiver.getByText(/waiting on/i)).toHaveCount(0)
    // And the orderer's side is untouched: nothing was confirmed on their behalf.
    await expect(orderer.getByRole('button', { name: /handed it over/i })).toBeEnabled()

    // The typed path still works after a refusal, which is what keeps a bad scan
    // from being a dead end.
    await field.fill(code)
    await receiver.getByRole('button', { name: /got the box/i }).click()
    await expect(receiver.getByText(/waiting on/i)).toBeVisible()
    await orderer.getByRole('button', { name: /handed it over/i }).click()
    await expect(receiver.getByText(/both of you confirmed the handoff/i)).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
})

test('a refused camera still completes the handoff by typing', async ({ browser }) => {
  // `--use-fake-ui-for-media-stream` auto-accepts the prompt for the whole
  // browser, so a refusal cannot be staged by withholding a permission. Rejecting
  // `getUserMedia` with the exact `DOMException` a denied prompt produces
  // exercises the same branch, and is the one a buyer who taps "Don't allow"
  // takes.
  const context = await browser.newContext({
    geolocation: asGeolocation(SCENARIOS.noCamera.receiver.at),
    permissions: ['geolocation'],
  })
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () =>
      Promise.reject(new DOMException('Permission denied', 'NotAllowedError'))
  })

  const orderer = await openAt(browser, SCENARIOS.noCamera.orderer)
  const receiver = await context.newPage()
  const contexts = [orderer.context, context]

  try {
    await signIn(receiver, SCENARIOS.noCamera.receiver)
    await receiver.goto('/')
    await receiver.getByRole('button', { name: /use my exact location/i }).click()
    await expect(receiver.getByText(/exact location on/i)).toBeVisible()

    await orderer.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(orderer.page.getByText(/looking for a bud/i)).toBeVisible()
    await receiver.getByRole('button', { name: /find a bud/i }).click()
    await expect(
      orderer.page.getByText(`${SCENARIOS.noCamera.receiver.name} comes to you.`),
    ).toBeVisible()
    const code = await orderer.page.getByText(/^[A-Z0-9]{6}$/).innerText()

    await receiver.getByRole('button', { name: /scan their code/i }).click()
    await expect(receiver.getByText(/camera access was refused/i)).toBeVisible()
    // Not a dead end, and it says so: the refusal notice itself points at the
    // path that still works.
    await expect(receiver.getByText(/type it/i).first()).toBeVisible()
    await expect(receiver.getByRole('button', { name: /stop the camera/i })).toHaveCount(0)

    await receiver.getByPlaceholder('------').fill(code)
    await receiver.getByRole('button', { name: /got the box/i }).click()
    await expect(receiver.getByText(/waiting on/i)).toBeVisible()
    await orderer.page.getByRole('button', { name: /handed it over/i }).click()
    await expect(receiver.getByText(/both of you confirmed the handoff/i)).toBeVisible()
  } finally {
    await Promise.all(contexts.map((each) => each.close().catch(() => {})))
  }
})

test('the camera stream is stopped when the receipt holding it goes away', async ({ browser }) => {
  const pair = SCENARIOS.unmount
  const first = await openAt(browser, pair.orderer)
  // The instrumentation has to be installed before the page loads, so this
  // context is built by hand rather than through `openAt`.
  const context = await browser.newContext({
    geolocation: asGeolocation(pair.receiver.at),
    permissions: ['geolocation', 'camera'],
  })
  await watchCameraTracks(context)
  const receiver = await context.newPage()
  const contexts = [first.context, context]

  try {
    await signIn(receiver, pair.receiver)
    await receiver.goto('/')
    await receiver.getByRole('button', { name: /use my exact location/i }).click()
    await expect(receiver.getByText(/exact location on/i)).toBeVisible()

    await first.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(first.page.getByText(/looking for a bud/i)).toBeVisible()
    await receiver.getByRole('button', { name: /find a bud/i }).click()
    await expect(first.page.getByText(`${pair.receiver.name} comes to you.`)).toBeVisible()

    // A picture with no QR in it, so the loop keeps running and the stream stays
    // open until something else stops it. That something is the unmount.
    showToFakeCamera({ width: 8, height: 8, luma: btoa('ÿ'.repeat(64)) })
    await receiver.getByRole('button', { name: /scan their code/i }).click()
    await expect(receiver.getByRole('button', { name: /stop the camera/i })).toBeVisible()
    // Polled rather than read once: the stop button appears the moment the tap is
    // registered, which is before `getUserMedia` has resolved.
    await expect(receiver.getByText(/point it at the qr/i)).toBeVisible()
    await expect
      .poll(() => trackStates(receiver), { message: 'the camera never started' })
      .toContain('live')

    // Walk away. The receipt is replaced wholesale, and nothing on that path taps
    // the scanner's own cancel button — which is exactly why `CodeScanner` stops
    // the stream from a cleanup effect rather than only from that handler.
    await receiver.getByRole('button', { name: /leave this match/i }).click()
    await expect(receiver.getByRole('button', { name: /find a bud/i })).toBeVisible()
    await expect
      .poll(() => trackStates(receiver), {
        message: 'the camera was left running after the receipt was unmounted',
      })
      .not.toContain('live')
  } finally {
    await Promise.all(contexts.map((each) => each.close().catch(() => {})))
  }
})

test('a decoder chunk that will not load is reported, and typing still settles', async ({
  browser,
}) => {
  // The one camera-failure branch nothing covered. `CodeScanner` fetches `jsqr`
  // on the tap rather than with the app — 55 kB nobody looking at a nugget deal
  // should download — which means a flaky network, an ad blocker or a stale
  // service worker can leave the receiver tapping a button that silently does
  // nothing. Aborting the chunk at the network is exactly that, and what it has
  // to produce is a refusal in the same register as a denied camera: say what
  // happened, and point at the path that still works.
  const pair = SCENARIOS.noChunk
  const { contexts, orderer, receiver, code } = await pairUp(browser, pair)

  try {
    await receiver.route(/jsqr/i, (route) => route.abort())

    await receiver.getByRole('button', { name: /scan their code/i }).click()
    await expect(receiver.getByText(/could not load the scanner/i)).toBeVisible()
    // Not a dead end, and it says so in the same words every other refusal does.
    await expect(receiver.getByText(/type it/i).first()).toBeVisible()
    // And no viewfinder was opened to fail in: the chunk is fetched before
    // `getUserMedia`, on purpose, so a decoder that cannot load never becomes a
    // permission prompt the buyer answers for nothing.
    await expect(receiver.getByRole('button', { name: /stop the camera/i })).toHaveCount(0)
    await expect(receiver.locator('video')).toBeHidden()

    await receiver.getByPlaceholder('------').fill(code)
    await receiver.getByRole('button', { name: /got the box/i }).click()
    await expect(receiver.getByText(/waiting on/i)).toBeVisible()
    await orderer.getByRole('button', { name: /handed it over/i }).click()
    await expect(receiver.getByText(/both of you confirmed the handoff/i)).toBeVisible()
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
})
