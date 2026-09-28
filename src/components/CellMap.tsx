import { decodeCell } from '@shared/geo'
import type { CellBuddy } from '@shared/protocol'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { useEffect, useRef } from 'react'

export interface CellMapProps {
  /** The geohash cell this connection was routed to. */
  cell: string
  /** Your own position, at full precision — it is already yours to know. */
  you: { lat: number; lng: number }
  /** Everyone else waiting in the cell, already snapped to a coarse grid server-side. */
  buddies: CellBuddy[]
}

const INK = '#17150f'
const NUGGET = '#e8a33d'
const PAPER = '#faf8f5'

/** A plain dot, not Leaflet's default blue pin — receipt ink, not a map app. */
function dot(color: string, label: string): L.DivIcon {
  return L.divIcon({
    className: 'cell-map-dot',
    html: `<span aria-label="${label}" style="display:block;width:12px;height:12px;border-radius:50%;background:${color};border:2px solid ${PAPER};box-shadow:0 0 0 1px ${INK};"></span>`,
    iconSize: [12, 12],
    iconAnchor: [6, 6],
  })
}

const YOU_ICON = dot(NUGGET, 'You')
const BUDDY_ICON = dot(INK, 'A buddy waiting nearby')

/**
 * A read-only sketch of the matching market you are standing in.
 *
 * The cell boundary comes from `decodeCell`, the inverse of the encoder the
 * server used to route this connection — the client never receives raw
 * coordinates for anyone but itself. Buddy markers are already coarse by the
 * time they arrive (see `snapToGrid` in `shared/geo.ts`); this component just
 * draws dots, it does not add or remove precision.
 */
export function CellMap({ cell, you, buddies }: CellMapProps) {
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
    // The receipt palette does not depend on the basemap: `.cell-map-tiles`
    // desaturates whatever is underneath, so this swap is a drop-in. OSM's
    // standard style does carry labels, which read as faint street context
    // under that filter.
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

  // Redraw the boundary and dots whenever the roster or the cell changes.
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (map === null || layer === null || cell.length === 0) return

    layer.clearLayers()

    const box = decodeCell(cell)
    const bounds = L.latLngBounds([box.latMin, box.lngMin], [box.latMax, box.lngMax])
    L.rectangle(bounds, {
      color: INK,
      weight: 1.5,
      fillOpacity: 0,
      dashArray: '4 3',
    }).addTo(layer)

    L.marker([you.lat, you.lng], { icon: YOU_ICON, keyboard: false }).addTo(layer)
    for (const buddy of buddies) {
      L.marker([buddy.lat, buddy.lng], { icon: BUDDY_ICON, keyboard: false }).addTo(layer)
    }

    map.fitBounds(bounds, { padding: [10, 10] })
  }, [cell, you, buddies])

  return (
    <div className="mt-4">
      <div
        ref={containerRef}
        className="h-48 w-full border-2 border-ink"
        role="img"
        aria-label={`Map of your cell, showing your position and ${buddies.length} other buyer${
          buddies.length === 1 ? '' : 's'
        } waiting nearby`}
      />
      <p className="mt-1 text-right font-display text-[0.55rem] tracking-[0.05em] text-faded uppercase">
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
