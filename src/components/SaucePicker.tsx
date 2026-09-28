import { horoscopeForSelection, type SauceSelection, type SauceSpec } from '@shared/sauces'
import { Line } from './Roll'

/**
 * Pick two, and read what it says about you.
 *
 * The reading is a pure function of the pair (`shared/sauces.ts`), so it is the
 * same two lines on every device and after every reload — a "reading" that
 * changed when you refreshed would teach a buyer the feature is noise.
 */
export function SaucePicker({
  sauces,
  picks,
  selection,
  onTap,
}: {
  /** The menu of the chain whose box is selected — sauces belong to a merchant. */
  sauces: readonly SauceSpec[]
  picks: readonly string[]
  selection: SauceSelection | null
  onTap: (sauceId: string) => void
}) {
  const reading = horoscopeForSelection(selection)

  return (
    <section>
      <div className="grid grid-cols-2 gap-2">
        {sauces.map((sauce) => {
          const count = picks.filter((id) => id === sauce.id).length
          return (
            <button
              key={sauce.id}
              type="button"
              onClick={() => onTap(sauce.id)}
              aria-pressed={count > 0}
              className={`flex items-baseline justify-between gap-1 border-2 px-3 py-2 text-left transition-colors ${
                count > 0 ? 'border-ink bg-nugget/20' : 'border-hairline'
              }`}
            >
              <span className="font-display text-[0.68rem] tracking-[0.08em] uppercase">
                {sauce.label}
              </span>
              {count > 1 && (
                <span className="font-display text-[0.6rem] font-bold text-ketchup tabular-nums">
                  2x
                </span>
              )}
            </button>
          )
        })}
      </div>

      {reading === null ? (
        <p className="mt-3 font-body text-sm leading-snug text-faded">
          Pick two. The same one twice counts — nobody is judging, except the chart.
        </p>
      ) : (
        <>
          <Line label="At the counter" value={reading.counterOrder} />
          <p className="printed mt-2 font-body text-sm leading-snug">{reading.lines[0]}</p>
          <p className="printed font-body text-sm leading-snug text-faded">{reading.lines[1]}</p>
        </>
      )}
    </section>
  )
}
