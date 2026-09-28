import { formatMiles } from '@shared/geo'
import type { CellBuddy } from '@shared/protocol'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'

export interface RadiusMapProps {
  /** Where the server placed you, at full precision — it is already yours to know. */
  you: { lat: number; lng: number }
  /** How far a buddy may be and still be matched, as the server reported it. */
  radiusMeters: number
  /** Everyone else waiting inside that circle, already snapped to a coarse grid. */
  buddies: CellBuddy[]
  /** How the centre was arrived at, e.g. 'your exact location'. */
  centreLabel: string
}

/*
 * Marker and circle colours, read off the console palette rather than the
 * receipt's. Leaflet takes strings, not CSS variables, so these are the one
 * place a token is repeated as a literal — keep them in step with
 * `src/styles/globals.css`.
 */
const CHROME = '#e8ecf7'
const NUGGET = '#ffb02e'
const TUBE = '#080520'
const PHOSPHOR = '#4dffa6'

/** Map height in CSS pixels; `h-48` in Tailwind's default scale. */
const MAP_HEIGHT_PX = 192

/** A plain dot, not Leaflet's default blue pin — receipt ink, not a map app. */
function dot(color: string, label: string): L.DivIcon {
  return L.divIcon({
    className: 'cell-map-dot',
    html: `<span aria-label="${label}" style="display:block;width:12px;height:12px;border-radius:50%;background:${color};border:2px solid ${TUBE};box-shadow:0 0 0 1px ${CHROME};"></span>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })
}

const YOU_ICON = dot(NUGGET, 'You')
const BUDDY_ICON = dot(PHOSPHOR, 'A buddy waiting nearby')

/**
 * The zoom at which a circle of `radiusMeters` fills most of the map's height.
 *
 * Derived rather than fitted, and that is the point: `fitBounds` would mean
 * asking the circle for its bounds, and `circle.getBounds()` projects against the
 * map — it throws if the view is not established yet. Cribbed from 311alarm's
 * `MiniMap`, where that gotcha was already paid for; the arithmetic here differs
 * only in aiming the *diameter* at a fraction of the container rather than
 * assuming a fixed reference radius.
 */
function zoomForRadius(radiusMeters: number, lat: number): number {
  const metersPerPixelAtZoomZero = 156_543.03392 * Math.cos((lat * Math.PI) / 180)
  // 70% of the height, so the circle reads as a circle with room around it.
  const wanted = (2 * radiusMeters) / (MAP_HEIGHT_PX * 0.7)
  const zoom = Math.log2(metersPerPixelAtZoomZero / wanted)
  return Math.max(3, Math.min(17, Math.round(zoom)))
}

/**
 * A read-only sketch of the market you are standing in: your position, the circle
 * a buddy has to be inside, and a dot for everyone already waiting in it.
 *
 * The circle is the whole point. Before #82 this drew the geohash cell's dashed
 * rectangle — a shape with no meaning to the person looking at it, and not the
 * shape that decided anything once matching became a radius. It is drawn at
 * whatever radius the server sent, so the picture cannot disagree with the rule.
 *
 * Buddy markers are already coarse by the time they arrive (see `snapToGrid` in
 * `shared/geo.ts`) and are filtered to this radius server-side; this component
 * draws dots, it does not add or remove precision.
 */
export function RadiusMap({ you, radiusMeters, buddies, centreLabel }: RadiusMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)

  // Map instance lives for the component's lifetime; only the markers churn.
  useEffect(() => {
    const container = containerRef.current
    if (container === null) return

    const map = L.map(container, {
      attributionControl: false,
      zoomControl: false,
      // A glance-and-understand illustration, not a navigable map — nothing
      // here should be able to steal a touch-scroll off the page.
      dragging: false,
      scrollWheelZoom: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
    })
    mapRef.current = map

    // OpenStreetMap's standard tiles, which need no API key. CARTO's basemaps
    // do now, and they fail *silently*: an unkeyed request still answers 200
    // with a valid PNG, so the map renders a watermark rather than an error.
    // The tell is that the placeholder is a constant image — an empty ocean
    // tile and a dense city tile came back byte-identical at 2049 bytes.
    //
    // The console palette does not depend on the basemap: `.cell-map-tiles`
    // re-tones whatever is underneath onto it (see `src/styles/globals.css`), so
    // this swap is a drop-in. OSM's standard style does carry labels, and that
    // filter brings them *up* as pale street context rather than burying them.
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      className: 'cell-map-tiles',
    }).addTo(map)

    layerRef.current = L.layerGroup().addTo(map)

    return () => {
      map.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  // Redraw the circle and dots whenever the centre, the radius or the roster moves.
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (map === null || layer === null || radiusMeters <= 0) return

    layer.clearLayers()

    // setView before anything is added, and never fitBounds: see zoomForRadius.
    map.setView([you.lat, you.lng], zoomForRadius(radiusMeters, you.lat))

    L.circle([you.lat, you.lng], {
      radius: radiusMeters,
      color: CHROME,
      weight: 1.5,
      dashArray: '4 3',
      fillColor: NUGGET,
      fillOpacity: 0.14,
    }).addTo(layer)

    L.marker([you.lat, you.lng], { icon: YOU_ICON, keyboard: false }).addTo(layer)
    for (const buddy of buddies) {
      L.marker([buddy.lat, buddy.lng], { icon: BUDDY_ICON, keyboard: false }).addTo(layer)
    }
  }, [you, radiusMeters, buddies])

  return (
    <div className="mt-4">
      <div
        ref={containerRef}
        className="inset h-48 w-full"
        role="img"
        aria-label={`Map centred on ${centreLabel}, showing everyone you could be paired with within ${formatMiles(
          radiusMeters,
        )}: you and ${buddies.length} other buyer${buddies.length === 1 ? '' : 's'} waiting`}
      />
      <p className="mt-1 text-right font-mono text-[0.58rem] tracking-[0.05em] text-steel uppercase">
        Map data &copy;{' '}
        {/* OSMF asks that attribution link to the copyright page; that link is
            the part that is an actual licensing requirement, not decoration. */}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          className="underline"
        >
          OpenStreetMap contributors
        </a>
      </p>
    </div>
  )
}
