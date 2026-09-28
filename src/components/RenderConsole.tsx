import { formatMiles } from '@shared/geo'
import { useEffect, useRef, useState } from 'react'
import {
  backgroundFrame,
  buildNugget,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  nuggetFrame,
  type Polygon,
} from '../render/nugget'

/**
 * Frames per second, and the whole point of this component.
 *
 * 1996 hardware did not do sixty, and a smoothly interpolated turn would read as
 * a modern animation of a retro object rather than as the object. The judder is
 * the period detail, so the angle steps in twelfths of a second and nothing
 * between two steps is ever drawn.
 */
const FPS = 12
const FRAME_MS = 1000 / FPS
/** Frames in one revolution: eight seconds, slow enough to read the facets. */
const FRAMES_PER_TURN = 96
/** The three-quarter pose the render settles into once a match resolves. */
const RESOLVED_ANGLE = -0.62
/** How many stepped frames the deceleration takes. */
const RESOLVE_FRAMES = 9

/** The mesh never changes, so it is built once for the life of the tab. */
const MESH = buildNugget()

function angleAt(frame: number): number {
  return ((frame % FRAMES_PER_TURN) / FRAMES_PER_TURN) * Math.PI * 2
}

/** Shortest way round from one angle to another, so the settle never takes the long path. */
function easeTowards(from: number, to: number, t: number): number {
  const delta = ((to - from + Math.PI) % (Math.PI * 2)) - Math.PI
  return from + delta * (1 - (1 - t) ** 3)
}

function fill(context: CanvasRenderingContext2D, polygons: Polygon[], seal = false): void {
  for (const polygon of polygons) {
    context.fillStyle = polygon.fill
    context.beginPath()
    context.moveTo(polygon.points[0].x, polygon.points[0].y)
    for (const point of polygon.points.slice(1)) context.lineTo(point.x, point.y)
    context.closePath()
    context.fill()
    // Canvas antialiases every polygon edge, so two facets that share an edge
    // leave a hairline of whatever was underneath. Stroking each face in its
    // own colour closes the seam without softening the facet boundary, which is
    // the one thing this render cannot afford to lose.
    if (!seal) continue
    context.strokeStyle = polygon.fill
    context.lineWidth = 0.7
    context.stroke()
  }
}

/**
 * Sky and board, painted once.
 *
 * Neither moves — only the nugget turns — so the expensive half of the picture
 * is rendered into an offscreen buffer at first use and blitted after that. It
 * is what lets the checkerboard run at full density right up to the horizon
 * while a frame still costs about seventy polygons.
 */
let backdrop: HTMLCanvasElement | null = null

function backdropCanvas(): HTMLCanvasElement | null {
  if (backdrop !== null) return backdrop
  const canvas = document.createElement('canvas')
  canvas.width = FRAME_WIDTH
  canvas.height = FRAME_HEIGHT
  const context = canvas.getContext('2d')
  if (context === null) return null
  fill(context, backgroundFrame())
  backdrop = canvas
  return backdrop
}

/**
 * One frame: the painted backdrop, then the nugget on top of it.
 *
 * Two layers rather than one depth-sorted soup. The nugget rests on the board
 * at its own depth, so every square the board draws over it would be behind it
 * anyway — there is no case where a nearer square should occlude the nugget.
 */
function paint(context: CanvasRenderingContext2D, angle: number, bloom: number): void {
  const backing = backdropCanvas()
  if (backing === null) return
  context.drawImage(backing, 0, 0)
  fill(context, nuggetFrame(MESH, angle, FRAME_WIDTH, FRAME_HEIGHT, bloom), true)
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const update = () => setReduced(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return reduced
}

/**
 * The render itself.
 *
 * The backing store is 192x128 and the element is upscaled by CSS with
 * `image-rendering: pixelated`, so what a phone shows really is a low-resolution
 * render rather than a high-resolution picture of one — the pixels are the
 * render's own.
 */
function NuggetRender({ resolved }: { resolved: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  // Survives the effect re-running when `resolved` flips, so the settle starts
  // from wherever the turn had got to rather than snapping back to frame zero.
  const frameRef = useRef(0)
  const reduced = usePrefersReducedMotion()

  useEffect(() => {
    const context = canvasRef.current?.getContext('2d')
    if (context === undefined || context === null) return

    // A deliberate judder is exactly the kind of motion that has to be
    // switchable off, so this draws one frame and never starts a loop at all.
    if (reduced) {
      paint(context, RESOLVED_ANGLE, resolved ? 1 : 0)
      return
    }

    const from = angleAt(frameRef.current)
    let settle = 0
    let last = Number.NEGATIVE_INFINITY
    let handle = 0

    const step = (now: number) => {
      if (now - last >= FRAME_MS) {
        last = now
        if (resolved) {
          const t = Math.min(1, settle / RESOLVE_FRAMES)
          paint(context, easeTowards(from, RESOLVED_ANGLE, t), t)
          settle += 1
          // Resolved means resolved: the loop ends rather than idling on a
          // still frame it would otherwise redraw twelve times a second.
          if (t >= 1) return
        } else {
          frameRef.current += 1
          paint(context, angleAt(frameRef.current), 0)
        }
      }
      handle = requestAnimationFrame(step)
    }

    handle = requestAnimationFrame(step)
    return () => cancelAnimationFrame(handle)
  }, [resolved, reduced])

  return (
    <canvas
      ref={canvasRef}
      width={FRAME_WIDTH}
      height={FRAME_HEIGHT}
      role="img"
      aria-label={
        resolved
          ? 'Render resolved: the nugget is lit and still'
          : 'A nugget turning over a checkerboard while the pool is searched'
      }
      className="render-frame"
    />
  )
}

function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}

/**
 * The signature screen: a render in progress, with the queue's real state beside
 * it on a phosphor readout.
 *
 * Every figure here is the server's, not a decoration — `buyers` is the count
 * inside the radius the server is matching in, `radiusMeters` is that radius,
 * and the clock is how long this browser has actually been in line. When a match
 * lands the render resolves rather than being replaced: the rotation decelerates
 * into a pose, the specular blows out, and the readout stops counting.
 */
export function RenderConsole({
  resolved,
  buyers,
  queuedAhead,
  radiusMeters,
}: {
  /** True from the moment the server pairs you. */
  resolved: boolean
  /** Buyers waiting inside your radius, as the server last reported it. */
  buyers: number
  queuedAhead: number
  /** The market in force; null until `welcome` has landed. */
  radiusMeters: number | null
}) {
  const [startedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (resolved) return
    const tick = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(tick)
  }, [resolved])

  const queued = elapsed(now - startedAt)

  return (
    <div className="console">
      <NuggetRender resolved={resolved} />
      <dl className="readout">
        {resolved ? (
          <>
            <Readout label="Pair resolved" value={queued} />
            <Readout label="Render pass" value="Complete" />
          </>
        ) : (
          <>
            <Readout label="Buyers near" value={String(buyers)} />
            <Readout
              label="Match radius"
              value={radiusMeters === null ? '—' : formatMiles(radiusMeters)}
            />
            <Readout label="Ahead of you" value={String(queuedAhead)} />
            <Readout label="In queue" value={queued} />
          </>
        )}
      </dl>
    </div>
  )
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="readout-row">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  )
}
