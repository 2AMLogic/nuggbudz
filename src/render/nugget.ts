/**
 * The queue screen's render, as geometry and arithmetic.
 *
 * Deliberately pure: no canvas, no DOM, no clock. A frame is a function of one
 * angle, so it is reproducible and testable in plain Node — the same reason
 * `shared/` is runtime-free. The drawing half lives in
 * `src/components/RenderConsole.tsx` and does nothing but fill the polygons this
 * module hands it, in the order it hands them over.
 *
 * Why 2D canvas and not WebGL: a hundred flat polygons sorted by depth is the
 * entire job, and the 1996 look — hard facet edges, banded light, one blown
 * specular — is what you get when you deliberately stop short of smooth
 * shading. WebGL would add a context-loss path to get wrong and a library to
 * ship, for a picture that is 192 by 128 pixels.
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** One flat-shaded triangle, as indices into a mesh's vertex list. */
export interface Face {
  a: number
  b: number
  c: number
}

export interface Mesh {
  vertices: Vec3[]
  faces: Face[]
}

export interface Point2 {
  x: number
  y: number
}

/** A projected polygon ready to fill, already in the order it should be drawn. */
export interface Polygon {
  /** Screen points, in pixels of the low-resolution backing store. */
  points: Point2[]
  fill: string
}

/** The backing store is this small on purpose: a low-res render, not a picture of one. */
export const FRAME_WIDTH = 192
export const FRAME_HEIGHT = 128

/** Rings around the spin axis. Low on purpose — the facets are the subject. */
export const NUGGET_SLICES = 9
/** Rings from pole to pole. */
export const NUGGET_STACKS = 6

/**
 * The gold ramp, darkest first.
 *
 * Five entries, not a gradient, and the darkest is still a saturated orange
 * rather than a brown: a renderer of this vintage lifted its shadows with a
 * flat ambient term and quantised what was left into a handful of palette
 * slots. The banding is the tell — interpolating here would produce a smooth
 * blob that could have come from any decade.
 */
export const NUGGET_RAMP = ['#b8520f', '#d06d16', '#e2911d', '#f1b129', '#ffd15e'] as const

/** The blown highlight, and the one step short of it. A hotspot clips; that is why it reads hot. */
export const SPECULAR = '#ffffff'
export const SPECULAR_EDGE = '#fff4d0'

/**
 * The sky, zenith first. Indigo to magenta in hard steps.
 *
 * Eleven flat bands rather than a gradient, because 8-bit ramps are the period
 * detail and a smooth sky would quietly undo every other decision here.
 */
export const SKY_BANDS = [
  '#3d38d4',
  '#4a2cc6',
  '#5c23b6',
  '#7220a6',
  '#8a1d97',
  '#a21d89',
  '#b7207b',
  '#cb246c',
] as const

/** The board is pure black and white. A tinted checkerboard stops being a checkerboard. */
export const CHECKER_LIGHT = '#ffffff'
export const CHECKER_DARK = '#000000'
/** What an infinity of half-pixel squares averages to, which is what fills the last sliver. */
export const CHECKER_HAZE = '#7d7d7d'

/** Fraction of the frame height at which the floor plane vanishes. */
export const HORIZON_FRACTION = 0.46

/** How far in front of the camera the nugget's centre sits. */
export const DEPTH = 3.3
/** Focal length in backing-store pixels. */
export const FOCAL = 78
/** The checkerboard plane, in world units below the camera — and the nugget rests on it. */
export const FLOOR_Y = -1
/** Where the board starts, behind the nugget's depth so it runs off the bottom edge. */
const FLOOR_NEAR_Z = -2.25
const FLOOR_CELL = 0.27
/**
 * Rows are drawn well past the point of being a pixel tall.
 *
 * Stopping at one pixel would leave a flat grey slab a fifth of the board deep,
 * because a floor plane approaches its own horizon slowly. Drawing the
 * sub-pixel rows anyway and letting the canvas average them is what a renderer
 * of any era does, and it turns that slab into the fine dither the far half of
 * a checkerboard is supposed to be. It costs nothing at runtime: the board is
 * painted once into an offscreen buffer and blitted from then on.
 */
const FLOOR_MIN_ROW_PIXELS = 0.012
const FLOOR_MAX_ROWS = 200

/** Camera pitch: the board is seen from slightly above, not edge-on. */
const NUGGET_TILT = 0.2
/** A constant lean, applied after the spin. A nugget does not stand to attention. */
const NUGGET_LEAN = -0.62

const LIGHT = normalise({ x: -0.5, y: 0.66, z: -0.56 })
/** The camera looks down +z, so "towards the eye" is -z. */
const EYE: Vec3 = { x: 0, y: 0, z: -1 }
const HALFWAY = normalise(add(LIGHT, EYE))
/** Flat fill light, so the dark side of the nugget stays orange instead of going to mud. */
const AMBIENT = 0.26

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function normalise(v: Vec3): Vec3 {
  const length = Math.hypot(v.x, v.y, v.z)
  if (length === 0) return { x: 0, y: 0, z: 0 }
  return { x: v.x / length, y: v.y / length, z: v.z / length }
}

export function rotateY(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x * c + v.z * s, y: v.y, z: -v.x * s + v.z * c }
}

export function rotateX(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x, y: v.y * c - v.z * s, z: v.y * s + v.z * c }
}

export function rotateZ(v: Vec3, angle: number): Vec3 {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c, z: v.z }
}

/**
 * A nugget, as a deformed low-polygon spheroid.
 *
 * Nine slices by six stacks, which is few enough that every facet is legible at
 * 192 pixels across — the facets are the subject, so a denser mesh would be a
 * worse one. The pinched silhouette comes from `sin(2u)`, and the lumps from a
 * second harmonic that vanishes at the poles, so both ends stay single points
 * and the ring of triangles meeting there does not fan out into spikes. No
 * randomness anywhere: the same call returns the same mesh on every device,
 * which is what lets a test assert on it.
 */
export function buildNugget(slices = NUGGET_SLICES, stacks = NUGGET_STACKS): Mesh {
  const vertices: Vec3[] = []
  for (let j = 0; j <= stacks; j++) {
    const v = (j / stacks) * Math.PI
    for (let i = 0; i < slices; i++) {
      const u = (i / slices) * Math.PI * 2
      const lobe = 1 + 0.2 * Math.sin(2 * u) * Math.sin(v)
      const lump = 1 + 0.08 * Math.sin(3 * u + 1.7) * Math.sin(2 * v)
      vertices.push({
        x: Math.sin(v) * Math.cos(u) * 1.58 * lobe * lump,
        y: Math.cos(v) * 0.96 * lump - 0.04,
        z: Math.sin(v) * Math.sin(u) * 1.02 * lobe * lump,
      })
    }
  }

  const faces: Face[] = []
  for (let j = 0; j < stacks; j++) {
    for (let i = 0; i < slices; i++) {
      const next = (i + 1) % slices
      const a = j * slices + i
      const b = j * slices + next
      const c = (j + 1) * slices + next
      const d = (j + 1) * slices + i
      pushFace(faces, vertices, a, b, c)
      pushFace(faces, vertices, a, c, d)
    }
  }
  return { vertices, faces }
}

/**
 * Add a triangle unless it has no area.
 *
 * The rings at either pole collapse to a single point, so one triangle of each
 * quad there is degenerate. Dropping them keeps the polygon count honest and
 * stops `normalise` being handed a zero vector.
 */
function pushFace(faces: Face[], vertices: Vec3[], a: number, b: number, c: number): void {
  const normal = cross(sub(vertices[b], vertices[a]), sub(vertices[c], vertices[a]))
  if (Math.hypot(normal.x, normal.y, normal.z) < 1e-6) return
  faces.push({ a, b, c })
}

/** World point to backing-store pixel. Null when the point is behind the near plane. */
export function project(v: Vec3, width = FRAME_WIDTH, height = FRAME_HEIGHT): Point2 | null {
  const z = v.z + DEPTH
  if (z <= 0.08) return null
  return {
    x: width / 2 + (v.x * FOCAL) / z,
    y: height * HORIZON_FRACTION - (v.y * FOCAL) / z,
  }
}

/** Where the floor plane vanishes, in backing-store pixels. */
export function horizonY(height = FRAME_HEIGHT): number {
  return height * HORIZON_FRACTION
}

/**
 * Lambert over a flat ambient, then thrown away to a handful of steps.
 *
 * Quantising *after* the dot product, per face rather than per vertex, is what
 * makes a facet one flat colour with a hard edge against its neighbour. Every
 * other decision in this file depends on this one staying stepped.
 */
export function rampIndex(intensity: number, steps: number = NUGGET_RAMP.length): number {
  const clamped = Math.max(0, Math.min(0.9999, intensity))
  return Math.floor(clamped * steps)
}

/**
 * One frame of the nugget, sorted back to front.
 *
 * `bloom` widens the specular: 0 is the searching state's small clipped patch,
 * 1 is the moment a match resolves and the highlight blows out across the lit
 * side.
 */
export function nuggetFrame(
  mesh: Mesh,
  angle: number,
  width = FRAME_WIDTH,
  height = FRAME_HEIGHT,
  bloom = 0,
): Polygon[] {
  const view = mesh.vertices.map((vertex) =>
    rotateX(rotateZ(rotateY(vertex, angle), NUGGET_LEAN), NUGGET_TILT),
  )
  const drawn: { polygon: Polygon; depth: number }[] = []
  const specularCut = 0.72 - bloom * 0.38

  for (const face of mesh.faces) {
    const a = view[face.a]
    const b = view[face.b]
    const c = view[face.c]
    const centre = {
      x: (a.x + b.x + c.x) / 3,
      y: (a.y + b.y + c.y) / 3,
      z: (a.z + b.z + c.z) / 3 + DEPTH,
    }
    const normal = normalise(cross(sub(b, a), sub(c, a)))
    // Backface cull: a face whose normal agrees with the line of sight is the
    // inside of the nugget. Painter's order alone would still draw it.
    if (dot(normal, centre) >= 0) continue

    const pa = project(a, width, height)
    const pb = project(b, width, height)
    const pc = project(c, width, height)
    if (pa === null || pb === null || pc === null) continue

    const lit = AMBIENT + (1 - AMBIENT) * Math.max(0, dot(normal, LIGHT))
    const specular = Math.max(0, dot(normal, HALFWAY)) ** 9
    // Two tiers, not a falloff: the hotspot clips to white and the facets
    // around it step once on the way down.
    const fill =
      specular > specularCut
        ? SPECULAR
        : specular > specularCut * 0.72
          ? SPECULAR_EDGE
          : NUGGET_RAMP[rampIndex(lit)]
    drawn.push({
      polygon: { points: [pa, pb, pc], fill },
      depth: Math.hypot(centre.x, centre.y, centre.z),
    })
  }

  drawn.sort((one, two) => two.depth - one.depth)
  return drawn.map((entry) => entry.polygon)
}

/**
 * The sky and the infinite checkerboard, in draw order.
 *
 * Nothing here depends on the angle, so the component paints it once into an
 * offscreen buffer and blits it — which is what lets the board be drawn at full
 * density right up to the horizon while a frame still costs about seventy
 * polygons.
 *
 * The board is pure black and white, with no fade towards the horizon: the
 * compression of the squares is what makes it read as infinite, and tinting the
 * far rows would only make it read as fog.
 */
export function backgroundFrame(width = FRAME_WIDTH, height = FRAME_HEIGHT): Polygon[] {
  const polygons: Polygon[] = []
  const horizon = horizonY(height)
  const band = horizon / SKY_BANDS.length

  for (const [index, colour] of SKY_BANDS.entries()) {
    const top = Math.floor(index * band)
    const bottom = index === SKY_BANDS.length - 1 ? horizon : Math.floor((index + 1) * band)
    polygons.push({ points: box(0, top, width, bottom), fill: colour })
  }

  // The dark half of the board goes down in one fill; the white squares are
  // then laid on top of it, which halves the polygon count and means an
  // antialiased seam between two squares shows black rather than sky.
  polygons.push({ points: box(0, horizon, width, height), fill: CHECKER_DARK })

  const rows: { near: number; far: number; index: number }[] = []
  let hazeBottom = horizon
  for (let index = 0; index < FLOOR_MAX_ROWS; index++) {
    const near = FLOOR_NEAR_Z + index * FLOOR_CELL
    const far = near + FLOOR_CELL
    const nearEdge = project({ x: 0, y: FLOOR_Y, z: near }, width, height)
    const farEdge = project({ x: 0, y: FLOOR_Y, z: far }, width, height)
    if (nearEdge === null || farEdge === null) continue
    if (nearEdge.y - farEdge.y < FLOOR_MIN_ROW_PIXELS) break
    rows.push({ near, far, index })
    hazeBottom = farEdge.y
  }

  if (hazeBottom > horizon) {
    polygons.push({ points: box(0, horizon, width, hazeBottom + 0.5), fill: CHECKER_HAZE })
  }

  for (let row = rows.length - 1; row >= 0; row--) {
    const { near, far, index } = rows[row]
    // The far edge is the wider of the two, so it decides how many cells it
    // takes to reach both sides of the frame.
    const halfWorld = ((width / 2) * (far + DEPTH)) / FOCAL
    const span = Math.ceil(halfWorld / FLOOR_CELL) + 1
    for (let column = -span; column < span; column++) {
      if ((index + column) % 2 !== 0) continue
      const left = column * FLOOR_CELL
      const right = left + FLOOR_CELL
      const corners = [
        project({ x: left, y: FLOOR_Y, z: far }, width, height),
        project({ x: right, y: FLOOR_Y, z: far }, width, height),
        project({ x: right, y: FLOOR_Y, z: near }, width, height),
        project({ x: left, y: FLOOR_Y, z: near }, width, height),
      ]
      if (corners.some((corner) => corner === null)) continue
      polygons.push({ points: corners as Point2[], fill: CHECKER_LIGHT })
    }
  }
  return polygons
}

function box(left: number, top: number, right: number, bottom: number): Point2[] {
  return [
    { x: left, y: top },
    { x: right, y: top },
    { x: right, y: bottom },
    { x: left, y: bottom },
  ]
}
