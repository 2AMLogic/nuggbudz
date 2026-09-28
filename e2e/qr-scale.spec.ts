import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type Browser,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  test,
} from '@playwright/test'
import jsQR from 'jsqr'
import { FIXTURE_COORDS } from '../scripts/pool-fixtures.mjs'
import { SESSION_COOKIE } from '../shared/auth'
import { qrPayloadFor } from '../shared/handoff'
import {
  pickupQrMatrix,
  QR_MODULE_PIXELS_MAX,
  QR_MODULE_PIXELS_MIN,
  qrModulePixels,
  qrSpanModules,
} from '../shared/qr'

/**
 * How big the pickup QR actually is **on screen**, on the narrowest phone.
 *
 * This spec exists because `e2e/scan.spec.ts` cannot answer that question and
 * never could (#127). It reads `canvas.getImageData(...)` — the *backing store*,
 * which no CSS transform can reach — at Playwright's 1280px default viewport,
 * where the receipt column is wider than the symbol and nothing is clamped. So it
 * proves the symbol is generated correctly and says nothing at all about what is
 * displayed: a change that halved the rendered size left it green. Five defects in
 * this repo now share that shape — a check that cannot fail for the thing it is
 * named after — and the instrument is the whole difference here.
 *
 * What this file does instead: pair two browsers on a **320px viewport**,
 * screenshot the `<canvas>` *element*, and decode that. A screenshot comes off the
 * compositor, so it is the picture after layout, after `max-width`, after
 * `devicePixelRatio` — the same pixels a camera pointed at the phone would see.
 * The size assertions are then against that image rather than against the
 * attributes the app chose for itself.
 *
 * The two claims, kept separate on purpose:
 *
 * 1. **Nothing is resampled.** The composited image is exactly the backing store's
 *    size (times the device pixel ratio), so every module lands on whole pixels.
 *    A browser downscale is worse than a smaller symbol drawn deliberately — it
 *    puts module edges on fractions — and it is invisible from the backing store.
 * 2. **The symbol is still a symbol.** Those composited pixels decode, through the
 *    same `jsQR` the receiver's phone runs, to the handoff link for that code.
 */

const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

/**
 * The narrowest screen anybody browses on, and the one the arithmetic broke at.
 *
 * Passed to `browser.newContext` rather than declared with `test.use({ viewport })`
 * because a context created by hand does not inherit the fixture options —
 * `openAt` below needs its own geolocation per buyer, so the contexts here are
 * built explicitly and a file-level `test.use` would silently not apply.
 */
const NARROW_VIEWPORT = { width: 320, height: 720 }

/** Where the same receipt is measured again with room to spare. */
const WIDE_VIEWPORT = { width: 1280, height: 720 }

/** The frame `PickupQr` draws around the symbol, per side, in CSS pixels. */
const FRAME_PIXELS = 2

/**
 * The longest origin this app is deployed under.
 *
 * These tests run against `localhost`, whose symbol is a version smaller than a
 * `*.workers.dev` stage deploy's. That deploy is the case #127 is actually about,
 * and no browser test can visit it — so what is asserted here is the half a
 * browser can settle: that the column a real 320px phone leaves is wide enough for
 * *that* symbol too, at a pitch above the floor. The arithmetic itself is
 * `test/qr.test.ts`'s.
 */
const LONGEST_ORIGIN = 'https://nuggbudz-staging.2amlogic.workers.dev'

const sessionId = (label: string): string => label.padEnd(43, '0').slice(0, 43)

/** This file's own account-id prefix, so it cannot collide with another spec's. */
const accountId = (n: number): string => `7cae1e00-0000-4000-8000-${String(n).padStart(12, '0')}`

const BUYERS = {
  orderer: {
    sid: sessionId('e2e-narrow-a'),
    userId: accountId(1),
    name: 'Maud',
    at: 'e2eNarrowA',
  },
  receiver: {
    sid: sessionId('e2e-narrow-b'),
    userId: accountId(2),
    name: 'Cass',
    at: 'e2eNarrowB',
  },
} as const

type Buyer = (typeof BUYERS)[keyof typeof BUYERS]

function applyMigrations(): void {
  // Same reason as every other lane: without the ledger tables `worker/pool.ts`
  // swallows its write by design, and a pairing that never reaches a receipt
  // would leave nothing on screen to measure.
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
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-qr-scale-')), 'sessions.json')
  writeFileSync(file, JSON.stringify(entries))
  execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
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

/** A signed-in browser standing on a fixture, at a viewport this file chose. */
async function openAt(
  browser: Browser,
  buyer: Buyer,
  viewport: { width: number; height: number },
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    viewport,
    geolocation: asGeolocation(buyer.at),
    permissions: ['geolocation'],
  })
  const page = await context.newPage()
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
  await page.goto('/')
  await expect(page.getByRole('button', { name: /find a bud/i })).toBeEnabled()
  await page.getByRole('button', { name: /use my exact location/i }).click()
  await expect(page.getByText(/exact location on/i)).toBeVisible()
  return { context, page }
}

/** The QR element on the orderer's receipt. */
const qrOf = (page: Page) => page.getByRole('img', { name: /pickup code/i })

/** What the canvas says about itself: its backing store, and its used layout size. */
async function measure(page: Page): Promise<{
  backingPixels: number
  contentPixels: number
  borderBoxPixels: number
  columnPixels: number
  devicePixelRatio: number
}> {
  return await qrOf(page).evaluate((node) => {
    const canvas = node as HTMLCanvasElement
    const column = canvas.parentElement
    if (column === null) throw new Error('the pickup QR is not inside a measured column')
    const style = getComputedStyle(canvas)
    return {
      backingPixels: canvas.width,
      // The *used* width of the content box, which is where the backing store is
      // painted. `box-sizing: content-box` is what keeps the frame out of it.
      contentPixels: Number.parseFloat(style.width),
      borderBoxPixels: canvas.getBoundingClientRect().width,
      columnPixels: column.getBoundingClientRect().width,
      devicePixelRatio: window.devicePixelRatio,
    }
  })
}

/**
 * The element's pixels as the compositor produced them, decoded back to greyscale.
 *
 * `locator.screenshot()` is the whole point of this file: it captures the element
 * after layout and after any CSS scaling, which `getImageData` on the canvas
 * cannot see. Turning that PNG back into pixels is done in the page rather than in
 * Node so no image-decoding dependency has to be added for one assertion — the
 * browser already has a PNG decoder, and it is not the thing under test.
 */
async function compositedPixels(
  page: Page,
  element: Locator,
): Promise<{ width: number; height: number; luma: Buffer }> {
  // `animations: 'disabled'` fast-forwards the receipt's `print-line` keyframes to
  // their end state. Not cosmetic: that animation is an opacity fade and a 4px
  // slide, so a screenshot caught mid-print is a faded, half-shifted symbol — which
  // would make this check flaky for a reason that has nothing to do with scale.
  // `scale: 'device'` is the default and is what makes the numbers here device
  // pixels rather than CSS ones.
  const png = (
    await element.screenshot({ type: 'png', animations: 'disabled', scale: 'device' })
  ).toString('base64')
  const shot = await page.evaluate(async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('no 2d context to decode the screenshot into')
    context.drawImage(image, 0, 0)
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let luma = ''
    // The symbol is black on white, so the red channel is the whole picture.
    for (let at = 0; at < data.length; at += 4) luma += String.fromCharCode(data[at])
    return { width: canvas.width, height: canvas.height, luma: btoa(luma) }
  }, png)
  return { width: shot.width, height: shot.height, luma: Buffer.from(shot.luma, 'base64') }
}

/**
 * What a decoder makes of those composited pixels, geometry included.
 *
 * The `location` is the part that matters here and not in any other lane: the
 * decoder's own estimate of where the finder patterns landed *in the screenshot*
 * is a measurement of how big the symbol is on screen, taken from the picture
 * rather than from the attributes the app set on itself.
 */
function decode(image: { width: number; height: number; luma: Buffer }) {
  const rgba = new Uint8ClampedArray(image.width * image.height * 4)
  for (let pixel = 0; pixel < image.luma.length; pixel += 1) {
    rgba[pixel * 4] = image.luma[pixel]
    rgba[pixel * 4 + 1] = image.luma[pixel]
    rgba[pixel * 4 + 2] = image.luma[pixel]
    rgba[pixel * 4 + 3] = 255
  }
  return jsQR(rgba, image.width, image.height)
}

/**
 * The gap between the two top finder-pattern centres, in modules.
 *
 * A QR's finder patterns are 7 modules square and sit flush in opposite corners of
 * the data area, so their centres are 3.5 modules in from each edge. Everything in
 * this expression is spec, not a measurement: `dataModules` is the data area alone
 * (`matrix.length`), **not** `qrSpanModules`, which would add the quiet zone that
 * lies outside the finder patterns entirely — the very conflation #127 was filed
 * for.
 */
const finderGapModules = (dataModules: number): number => dataModules - 7

/**
 * Assert the composited symbol at whatever viewport the page is currently at.
 *
 * Returns the pitch it was drawn at, so the caller can compare two viewports
 * against each other rather than against a number typed here.
 */
async function assertNotResampled(page: Page, code: string): Promise<number> {
  const seen = await measure(page)
  const origin = new URL(page.url()).origin
  const matrix = pickupQrMatrix(code, origin)
  const spanModules = qrSpanModules(matrix)

  // The pitch is derived from the column that actually exists, not fixed — so the
  // check is that it is a whole number of pixels in range, and that it is the
  // widest one that fits. Both halves matter: a pitch that merely fits could be 1.
  const pitch = seen.backingPixels / spanModules
  expect(pitch, 'the symbol is not a whole number of pixels per module').toBe(Math.round(pitch))
  expect(pitch).toBeGreaterThanOrEqual(QR_MODULE_PIXELS_MIN)
  expect(pitch).toBeLessThanOrEqual(QR_MODULE_PIXELS_MAX)
  expect(pitch, 'the symbol is smaller than the column it was given').toBe(
    qrModulePixels(spanModules, seen.columnPixels - FRAME_PIXELS * 2),
  )

  // Claim 1, at the layout level: the content box is exactly the backing store, so
  // `max-width` never engaged and the browser has nothing to resample.
  expect(seen.contentPixels, 'the canvas is CSS-scaled away from its backing store').toBe(
    seen.backingPixels,
  )
  expect(seen.borderBoxPixels).toBe(seen.backingPixels + FRAME_PIXELS * 2)
  // ...and the symbol plus its frame fits the column, rather than being clipped.
  expect(seen.borderBoxPixels).toBeLessThanOrEqual(seen.columnPixels)

  // Claim 1, at the compositor level, which is the assertion this file exists for.
  // `getImageData` on the canvas would report `backingPixels` here whatever CSS
  // did to the element; a screenshot cannot.
  const shot = await compositedPixels(page, qrOf(page))
  const expectedDevicePixels = (seen.backingPixels + FRAME_PIXELS * 2) * seen.devicePixelRatio
  // A one-pixel tolerance, and only that: Playwright rounds an element's clip
  // rectangle outward, so an element sitting at a fractional offset — everything on
  // this receipt does, the rows above it are `rem`-sized — comes back a pixel
  // taller or wider. The defect this guards against was 0.73x to 0.81x, tens of
  // pixels, so a pixel of rounding costs the check nothing.
  for (const [axis, got] of [
    ['width', shot.width],
    ['height', shot.height],
  ] as const) {
    expect(got, `the QR is downscaled on the way to the screen (${axis})`).toBeGreaterThanOrEqual(
      Math.floor(expectedDevicePixels),
    )
    expect(got, `the QR overflows its own element (${axis})`).toBeLessThanOrEqual(
      Math.ceil(expectedDevicePixels) + 1,
    )
  }

  // Claim 2: those same composited pixels are still a readable symbol, through the
  // decoder the receiver's phone runs...
  const found = decode(shot)
  expect(found?.data, 'the symbol on screen did not decode').toBe(qrPayloadFor(origin, code))

  // ...and its modules are the size they were drawn at, measured off the picture.
  // This is the assertion that does not depend on the element's own box at all: the
  // decoder says where it found the finder patterns in the screenshot, so the pitch
  // comes out of the composited pixels rather than out of anything the app claimed.
  const finders = found?.location
  if (finders === undefined) throw new Error('the decoder reported no geometry')
  const gap = Math.hypot(
    finders.topRightFinderPattern.x - finders.topLeftFinderPattern.x,
    finders.topRightFinderPattern.y - finders.topLeftFinderPattern.y,
  )
  expect(
    gap / finderGapModules(matrix.length),
    'the modules on screen are not the size they were drawn at',
  ).toBeCloseTo(pitch * seen.devicePixelRatio, 0)

  return pitch
}

test('the pickup QR is never resampled, on a 320px phone or a desktop', async ({ browser }) => {
  const first = await openAt(browser, BUYERS.orderer, NARROW_VIEWPORT)
  const second = await openAt(browser, BUYERS.receiver, NARROW_VIEWPORT)
  const contexts = [first.context, second.context]

  try {
    // The orderer queues first, so `findMatch`'s fairness rule makes the roles
    // deterministic and the code lands on the page this test measures.
    await first.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(first.page.getByText(/looking for a bud/i)).toBeVisible()
    await second.page.getByRole('button', { name: /find a bud/i }).click()
    await expect(
      first.page.getByText(`You order the box. ${BUYERS.receiver.name} comes to you.`),
    ).toBeVisible()

    const code = await first.page.getByText(/^[A-Z0-9]{6}$/).innerText()
    await expect(qrOf(first.page)).toBeVisible()

    const narrowPitch = await assertNotResampled(first.page, code)

    // The column a real 320px phone leaves, measured rather than reasoned about —
    // the comment in `globals.css` that claimed this figure was wrong twice over,
    // and the symbol it was compared against omitted the quiet zone. What has to
    // hold is that the *longest* origin's symbol also clears the floor in this
    // column, since no browser test can visit that deployment.
    const { columnPixels } = await measure(first.page)
    const longestSpan = qrSpanModules(pickupQrMatrix(code, LONGEST_ORIGIN))
    expect(
      columnPixels - FRAME_PIXELS * 2,
      `a ${longestSpan}-module symbol does not clear the floor in a ${columnPixels}px column`,
    ).toBeGreaterThanOrEqual(longestSpan * QR_MODULE_PIXELS_MIN)

    // And the narrow case is genuinely the constrained one: widening the viewport
    // must give the symbol more pixels per module, not the same. If this ever comes
    // out equal, 320px stopped being a tight fit and the check above stopped
    // measuring anything.
    await first.page.setViewportSize(WIDE_VIEWPORT)
    await expect
      .poll(async () => (await measure(first.page)).columnPixels)
      .toBeGreaterThan(columnPixels)
    const widePitch = await assertNotResampled(first.page, code)
    expect(widePitch).toBe(QR_MODULE_PIXELS_MAX)
    expect(narrowPitch).toBeLessThan(widePitch)

    // Back to the phone, because a rotation is the ordinary way this happens and a
    // symbol that only adapts in one direction overflows the moment it is turned.
    await first.page.setViewportSize(NARROW_VIEWPORT)
    await expect.poll(async () => (await measure(first.page)).columnPixels).toBe(columnPixels)
    expect(await assertNotResampled(first.page, code)).toBe(narrowPitch)
  } finally {
    await Promise.all(contexts.map((context) => context.close().catch(() => {})))
  }
})
