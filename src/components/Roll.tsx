import type { ReactNode } from 'react'

/**
 * The till roll every screen is printed on.
 *
 * Fixed narrow column at every breakpoint — an 80mm receipt does not become a
 * three-column layout on a desktop, it just sits in the middle of the counter.
 */
export function Roll({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[26rem] px-4 pb-16 pt-6">
      <div className="bg-paper px-5 py-6 shadow-[0_1px_0_var(--color-hairline),0_18px_40px_-28px_rgba(23,21,15,0.55)]">
        {children}
      </div>
    </main>
  )
}

export function Perf({ label }: { label?: string }) {
  if (label === undefined) return <div className="perf my-4" />
  return (
    <div className="my-4 flex items-center gap-3">
      <div className="perf flex-1" />
      <span className="font-display text-[0.6rem] tracking-[0.18em] text-faded uppercase">
        {label}
      </span>
      <div className="perf flex-1" />
    </div>
  )
}

/** One itemised line: label on the left, figure right-aligned in the money column. */
export function Line({
  label,
  value,
  emphasis = 'normal',
  delay = 0,
}: {
  label: string
  value: string
  emphasis?: 'normal' | 'total' | 'savings'
  delay?: number
}) {
  const tone =
    emphasis === 'savings' ? 'text-ketchup' : emphasis === 'total' ? 'text-ink' : 'text-faded'
  const weight = emphasis === 'normal' ? 'font-normal' : 'font-bold'

  return (
    <div
      className="printed flex items-baseline justify-between gap-3 py-[0.2rem]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span className={`font-display text-[0.7rem] tracking-[0.1em] uppercase ${tone} ${weight}`}>
        {label}
      </span>
      <span className={`font-display text-sm tabular-nums ${tone} ${weight}`}>{value}</span>
    </div>
  )
}
