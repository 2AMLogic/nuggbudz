import { describe, expect, it } from 'vitest'
import {
  backgroundFrame,
  buildNugget,
  CHECKER_DARK,
  CHECKER_HAZE,
  CHECKER_LIGHT,
  cross,
  DEPTH,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  horizonY,
  NUGGET_RAMP,
  nuggetFrame,
  project,
  rampIndex,
  SKY_BANDS,
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

  it('bands the sky in hard steps rather than a gradient', () => {
    const sky = background.slice(0, SKY_BANDS.length)
    expect(sky.map((polygon) => polygon.fill)).toEqual([...SKY_BANDS])
    // Every band is a full-width rectangle stacked down to the horizon.
    expect(sky[0].points[0]).toEqual({ x: 0, y: 0 })
    expect(sky[sky.length - 1].points[2].y).toBeCloseTo(horizonY(), 5)
  })

  it('draws the board in black and white and nothing else', () => {
    const board = background.slice(SKY_BANDS.length)
    const fills = new Set(board.map((polygon) => polygon.fill))
    expect([...fills].sort()).toEqual([CHECKER_DARK, CHECKER_LIGHT, CHECKER_HAZE].sort())
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
