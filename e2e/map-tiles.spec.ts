import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { SESSION_COOKIE } from '../shared/auth'

/**
 * The basemap renders real map data.
 *
 * This exists because the previous tile source failed in the one way an
 * availability check cannot see: an unkeyed request to CARTO answers **200**
 * with a valid PNG, and that PNG is an "API KEY REQUIRED" watermark. Status and
 * content-type were both healthy while the map showed nothing, so an HTTP-level
 * check confirmed the wrong thing.
 *
 * Two assertions a watermark cannot satisfy:
 *
 *  1. tile images actually decode (`naturalWidth > 0`);
 *  2. tiles covering *different* map areas differ in byte length. The watermark
 *     is a constant image, so under it every tile is byte-identical — that is
 *     the signal that separates a placeholder from a basemap.
 */

const SID = 'e2e-map'.padEnd(43, '0').slice(0, 43)
const BUYER = { sid: SID, userId: 'e2e-user-map', name: 'Mapper' }
const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
const AT = { latitude: 37.79, longitude: -122.4 }

test.beforeAll(() => {
  const value = JSON.stringify({
    userId: BUYER.userId,
    googleSub: `e2e-sub-${BUYER.userId}`,
    email: `${BUYER.userId}@example.test`,
    displayName: BUYER.name,
    createdAt: Date.now(),
  })
  execFileSync(
    'npx',
    [
      'wrangler',
      'kv',
      'key',
      'put',
      `session:${BUYER.sid}`,
      value,
      '--binding',
      'SESSIONS',
      '--local',
    ],
    { stdio: 'pipe', env: WRANGLER_ENV },
  )
})

test('the cell map renders real tiles, not a constant placeholder', async ({ browser }) => {
  const context = await browser.newContext({ geolocation: AT, permissions: ['geolocation'] })
  const page = await context.newPage()

  // Byte length of every tile the page actually fetches.
  const tileSizes = new Map<string, number>()
  page.on('response', async (response) => {
    if (!/\/\d+\/\d+\/\d+(@2x)?\.png/.test(response.url())) return
    try {
      tileSizes.set(response.url(), (await response.body()).byteLength)
    } catch {
      // A response that never delivered a body cannot contribute evidence.
    }
  })

  try {
    await context.addCookies([
      {
        name: SESSION_COOKIE,
        value: BUYER.sid,
        // `pnpm dev` serves plain http; a `secure` cookie would never be sent.
        domain: 'localhost',
        path: '/',
        httpOnly: true,
        secure: false,
        sameSite: 'Lax',
      },
    ])

    await page.goto('/')
    await page.getByRole('button', { name: /find a bud/i }).click()

    // The map only exists on the waiting screen, and only once a location
    // resolved — so reaching it also proves the gate that renders it.
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 })

    const tiles = page.locator('img.leaflet-tile')
    await expect(tiles.first()).toBeVisible({ timeout: 20_000 })

    // Let the layer pull neighbouring tiles, so there is more than one area.
    await page.waitForTimeout(3_000)

    const decoded = await tiles.evaluateAll((imgs) =>
      imgs.map((img) => (img as HTMLImageElement).naturalWidth),
    )
    expect(
      decoded.filter((w) => w > 0).length,
      'no tile image decoded — the basemap drew nothing',
    ).toBeGreaterThan(0)

    const sizes = [...tileSizes.values()]
    expect(sizes.length, 'no tile responses were observed').toBeGreaterThan(1)

    expect(
      new Set(sizes).size,
      `every tile came back the same byte length (${sizes[0]}B across ${sizes.length} tiles) — ` +
        'the signature of a constant placeholder image, not a basemap',
    ).toBeGreaterThan(1)
  } finally {
    await context.close()
  }
})
