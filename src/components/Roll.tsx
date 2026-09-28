import type { ReactNode } from 'react'

/**
 * The console every screen is bolted to.
 *
 * Fixed narrow column at every breakpoint — a workstation panel does not become
 * a three-column layout on a desktop, it just sits in the middle of the bench.
 * The gutter is 16px and the panel's own is another 16, so the usable width on a
 * 320px phone is 256: everything inside is measured against that, not against
 * the viewport.
 */
export function Roll({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-[26rem] px-4 pb-16 pt-5">
      <div className="console-shell px-4 py-5">{children}</div>
    </main>
  )
}

/** An engraved rule across the panel, optionally with a label set into it. */
export function Perf({ label }: { label?: string }) {
  if (label === undefined) return <div className="perf my-4" />
  return (
    <div className="my-4 flex items-center gap-3">
      <div className="perf flex-1" />
      <span className="tag">{label}</span>
      <div className="perf flex-1" />
    </div>
  )
}

/**
 * One itemised line: label on the left, figure right-aligned in the money
 * column.
 *
 * Money is gold, because the box of nuggets is the only warm thing in this
 * interface and the price of it is the same fact. Savings keep their own colour
 * so the two figures never blur into one number.
 */
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
    emphasis === 'savings' ? 'text-ketchup' : emphasis === 'total' ? 'text-nugget' : 'text-steel'
  const weight = emphasis === 'normal' ? 'font-normal' : 'font-bold'

  return (
    <div
      className="printed flex items-baseline justify-between gap-3 py-[0.2rem]"
      style={{ animationDelay: `${delay}ms` }}
    >
      <span
        className={`font-mono text-[0.68rem] tracking-[0.1em] whitespace-nowrap uppercase ${tone} ${weight}`}
      >
        {label}
      </span>
      <span className={`font-mono text-sm tabular-nums ${tone} ${weight}`}>{value}</span>
    </div>
  )
}
