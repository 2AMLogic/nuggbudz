import { execFileSync } from 'node:child_process'
import { expect, test } from '@playwright/test'
import { FIXTURE_COORDS } from '../scripts/pool-fixtures.mjs'
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
// A market of this spec's own, from the one table every live-pairing lane shares
// (`scripts/pool-fixtures.mjs`). It is more than a hundred kilometres from every
// other scenario's fixtures, which is what keeps this buyer from being matched
// with somebody another spec left queued — since #82 that isolation is a
// distance, not a geohash cell, because the cell is now ~156 km wide.
const AT = {
  latitude: FIXTURE_COORDS.e2eMapper.lat,
  longitude: FIXTURE_COORDS.e2eMapper.lng,
}

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

test('the map renders real tiles, not a constant placeholder', async ({ browser }) => {
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

    // The tap is still here, but for a different reason than it used to be.
    //
    // Before #82 the map was *gated* on it: the client only had a centre once the
    // buyer opted into precise location, so without this the waiting screen drew
    // no map and this spec failed on a missing container rather than on tiles.
    // That gate is gone — `welcome` now carries the position the server placed the
    // socket at, on every rung — and the promptless spec in `pairing.spec.ts`
    // asserts the map renders without any of this. What the tap buys *here* is
    // market isolation: a page that sends no coordinates is placed on the shared
    // server-resolved point, where another spec's buyer could be queued, and being
    // matched would leave the waiting screen mid-measurement.
    await page.getByRole('button', { name: /use my exact location/i }).click()
    await expect(page.getByText(/exact location on/i)).toBeVisible()

    await page.getByRole('button', { name: /find a bud/i }).click()

    // The map exists on the waiting screen, on every rung — so reaching it
    // without answering a prompt is itself the check that the gate is gone.
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 })

    // Tiles are only fetched for the area the view settles on, and the view is
    // derived from the radius the server sent (see `zoomForRadius` in
    // `src/components/RadiusMap.tsx`). A circle drawn with `fitBounds` would have
    // thrown before any of them were requested, which is why there is no
    // `getBounds()` anywhere in that component.
    await expect(page.locator('.leaflet-interactive')).toBeVisible()

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
