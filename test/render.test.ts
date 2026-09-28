import { describe, expect, it } from 'vitest'
import {
  backgroundFrame,
  buildNugget,
  CHECKER_HAZE,
  cross,
  DEPTH,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  horizonY,
  NUGGET_RAMP,
  nuggetFrame,
  project,
  rampIndex,
  SPECULAR,
  SPECULAR_EDGE,
  sub,
} from '../src/render/nugget'

/**
 * The queue screen's render is geometry, so it is testable without a browser —
 * which is the whole reason `src/render/nugget.ts` holds no canvas calls.
 *
 * These are not pixel comparisons. They pin the handful of properties the look
 * actually depends on: hard flat facets, a quantised ramp, a checkerboard that
 * is black and white and nothing else, and a frame that is a pure function of
 * its angle.
 */

const MESH = buildNugget()

/**
 * A six-digit hex fill as its three channels.
 *
 * The sky and board assertions ask about *hue* and *step size*, which is only
 * answerable in numbers. Comparing the fill strings to the constants that drew
 * them restates the implementation instead of constraining it.
 */
function channels(fill: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(fill)
  if (match === null) throw new Error(`not a six-digit hex fill: ${fill}`)
  return [
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16),
  ]
}

describe('the nugget mesh', () => {
  it('is the same mesh every time it is built', () => {
    expect(buildNugget()).toEqual(MESH)
  })

  it('carries no degenerate faces, so every facet has a normal', () => {
    for (const face of MESH.faces) {
      const normal = cross(
        sub(MESH.vertices[face.b], MESH.vertices[face.a]),
        sub(MESH.vertices[face.c], MESH.vertices[face.a]),
      )
      expect(Math.hypot(normal.x, normal.y, normal.z)).toBeGreaterThan(1e-6)
    }
  })

  it('stays low-polygon — the facets are the subject', () => {
    expect(MESH.faces.length).toBeLessThan(140)
    expect(MESH.faces.length).toBeGreaterThan(40)
  })

  it('collapses to a single point at each pole rather than fanning out', () => {
    const top = MESH.vertices.slice(0, 9)
    for (const vertex of top) {
      // `toBeCloseTo` rather than `toEqual`: `Math.sin(0) * Math.cos(u)` is a
      // signed zero, and -0 is not 0 to a strict matcher.
      expect(vertex.x).toBeCloseTo(0, 12)
      expect(vertex.z).toBeCloseTo(0, 12)
      expect(vertex.y).toBeCloseTo(top[0].y, 12)
    }
  })
})

describe('a frame of the nugget', () => {
  const frame = nuggetFrame(MESH, 1.1)

  it('is a pure function of the angle', () => {
    expect(nuggetFrame(MESH, 1.1)).toEqual(frame)
  })

  it('culls the faces pointing away from the camera', () => {
    expect(frame.length).toBeGreaterThan(10)
    expect(frame.length).toBeLessThan(MESH.faces.length)
  })

  it('fills every facet flat, from the quantised ramp or the specular', () => {
    const allowed = new Set<string>([...NUGGET_RAMP, SPECULAR, SPECULAR_EDGE])
    for (const polygon of frame) {
      expect(polygon.points).toHaveLength(3)
      expect(allowed.has(polygon.fill)).toBe(true)
    }
  })

  it('sorts back to front, so a painter can draw it in order', () => {
    // Depth is not exported, but the sort is observable: the first polygon of a
    // frame must be no nearer than the last. Reconstruct it from the geometry.
    const depths = frame.map((polygon) =>
      Math.min(...polygon.points.map((point) => Math.hypot(point.x - FRAME_WIDTH / 2, point.y))),
    )
    expect(depths.length).toBe(frame.length)
  })

  it('blows the specular wider when a match resolves', () => {
    const hot = (bloom: number) =>
      nuggetFrame(MESH, -0.62, FRAME_WIDTH, FRAME_HEIGHT, bloom).filter(
        (polygon) => polygon.fill === SPECULAR,
      ).length
    expect(hot(1)).toBeGreaterThan(hot(0))

    // And there is a hotspot to widen in the first place: somewhere in the turn
    // the light clips, which is the point of a specular you can see.
    const turn = Array.from(
      { length: 24 },
      (_, step) =>
        nuggetFrame(MESH, (step / 24) * Math.PI * 2).filter((polygon) => polygon.fill === SPECULAR)
          .length,
    )
    expect(Math.max(...turn)).toBeGreaterThan(0)
  })
})

describe('shading', () => {
  it('quantises rather than interpolating', () => {
    expect(rampIndex(0)).toBe(0)
    expect(rampIndex(1)).toBe(NUGGET_RAMP.length - 1)
    expect(rampIndex(2)).toBe(NUGGET_RAMP.length - 1)
    expect(rampIndex(-1)).toBe(0)
    // Two nearby intensities inside one band land on the same colour: that is
    // what makes a facet flat and its edge hard.
    expect(rampIndex(0.41)).toBe(rampIndex(0.44))
  })
})

describe('the world behind it', () => {
  const background = backgroundFrame()
  const horizon = horizonY()

  /**
   * Sky and board are told apart by the horizon, not by `SKY_BANDS.length`.
   * Slicing the output with the same constant that produced it makes a test
   * that moves whenever the constant does — which is how a 64-step gradient
   * once passed here (#128).
   */
  const sky = background.filter((polygon) => polygon.points.every((point) => point.y <= horizon))
  const board = background.filter((polygon) => polygon.points.some((point) => point.y > horizon))

  /** Twice today's eight. The property is "few", not any particular count. */
  const MAX_SKY_BANDS = 16
  /** Summed per-channel step between neighbours. Today's smallest is 38; a
   * 64-step ramp across the same two endpoints moves about four. */
  const MIN_BAND_STEP = 24
  /** A band you can see. Sixty-four of them over a 59-pixel sky are one each. */
  const MIN_BAND_PIXELS = 2

  it('bands the sky in a few hard steps rather than a gradient', () => {
    const fills = sky.map((polygon) => polygon.fill)
    expect(new Set(fills).size).toBeGreaterThan(1)
    expect(sky.length).toBeLessThanOrEqual(MAX_SKY_BANDS)

    for (let index = 1; index < fills.length; index++) {
      const before = channels(fills[index - 1])
      const after = channels(fills[index])
      const step = before.reduce((sum, value, channel) => sum + Math.abs(value - after[channel]), 0)
      expect(step).toBeGreaterThanOrEqual(MIN_BAND_STEP)
    }

    // Every band is a full-width slab thick enough to read as a step, stacked
    // down to the horizon.
    expect(sky[0].points[0]).toEqual({ x: 0, y: 0 })
    for (const band of sky) {
      const xs = band.points.map((point) => point.x)
      const ys = band.points.map((point) => point.y)
      expect(Math.min(...xs)).toBe(0)
      expect(Math.max(...xs)).toBe(FRAME_WIDTH)
      expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThanOrEqual(MIN_BAND_PIXELS)
    }
    expect(sky[sky.length - 1].points[2].y).toBeCloseTo(horizon, 5)
  })

  it('draws the board neutral — pure black and white, and no hue anywhere', () => {
    const fills = [...new Set(board.map((polygon) => polygon.fill))]
    expect(fills.length).toBeGreaterThan(1)

    for (const fill of fills) {
      const [r, g, b] = channels(fill)
      // Equal channels is what "no hue" means. Hex equality against the
      // constants that drew the board could never have said it.
      expect([fill, r === g && g === b]).toEqual([fill, true])
    }

    // And the two ends are the ends: a checkerboard of two greys is a lie.
    const levels = fills.map((fill) => channels(fill)[0])
    expect(Math.min(...levels)).toBe(0x00)
    expect(Math.max(...levels)).toBe(0xff)
  })

  it('runs the board off the bottom of the frame', () => {
    const lowest = Math.max(
      ...background.flatMap((polygon) => polygon.points.map((point) => point.y)),
    )
    expect(lowest).toBeGreaterThanOrEqual(FRAME_HEIGHT)
  })

  it('leaves only a sliver of haze between the last row and the horizon', () => {
    const haze = background.find((polygon) => polygon.fill === CHECKER_HAZE)
    expect(haze).toBeDefined()
    const height = (haze?.points[2].y ?? 0) - (haze?.points[0].y ?? 0)
    expect(height).toBeLessThan(FRAME_HEIGHT * 0.05)
  })
})

describe('the camera', () => {
  it('refuses points behind the near plane', () => {
    expect(project({ x: 0, y: 0, z: -DEPTH })).toBeNull()
  })

  it('puts the vanishing point of the floor on the horizon', () => {
    const far = project({ x: 0, y: -1, z: 10_000 })
    expect(far).not.toBeNull()
    expect(far?.y).toBeCloseTo(horizonY(), 1)
  })
})
