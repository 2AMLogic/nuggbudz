interface Bar {
  key: string
  width: number
  ink: boolean
}

/** Widen the code into alternating ink and gap bars, deterministically. */
function toBars(value: string): Bar[] {
  const bars: Bar[] = []
  for (const [index, char] of Array.from(value).entries()) {
    const code = char.charCodeAt(0)
    bars.push({ key: `${index}-ink`, width: 1 + (code % 3), ink: true })
    bars.push({ key: `${index}-gap`, width: 1 + ((code >> 2) % 3), ink: false })
  }
  return bars
}

/**
 * A barcode printed from the pickup code.
 *
 * Not scannable, and not pretending to be: it is the visual full stop a receipt
 * ends with, and it gives the counter something to compare against the code
 * printed beneath it.
 */
export function Barcode({ value }: { value: string }) {
  return (
    <div aria-hidden="true" className="flex h-12 items-stretch gap-px">
      {toBars(value).map((bar) => (
        <span
          key={bar.key}
          className={bar.ink ? 'bg-ink' : 'bg-transparent'}
          style={{ width: `${bar.width * 2}px` }}
        />
      ))}
    </div>
  )
}
