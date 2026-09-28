import { formatCents } from '@shared/economics'
import type { PaymentRequiredMessage } from '@shared/protocol'
import { useEffect, useRef, useState } from 'react'

/**
 * Collect the buyer's half.
 *
 * Stripe.js is loaded from js.stripe.com rather than bundled — Stripe requires
 * it, and it is what keeps card data out of this origin entirely. The amount
 * shown and charged is the one the server put in `payment_required`, which is
 * `share.payCents` off the settlement; nothing here computes a price.
 *
 * Confirmation happens between the browser and Stripe. This component never
 * tells the server the payment succeeded — the server believes the signed
 * webhook and nothing else, so a buyer who fakes success here simply waits.
 */

const STRIPE_JS = 'https://js.stripe.com/v3'

interface StripeElement {
  mount(target: HTMLElement): void
  unmount(): void
}
interface StripeElements {
  create(type: 'payment'): StripeElement
}
interface StripeJs {
  elements(options: { clientSecret: string }): StripeElements
  confirmPayment(options: {
    elements: StripeElements
    confirmParams: { return_url: string }
    redirect: 'if_required'
  }): Promise<{ error?: { message?: string } }>
}

declare global {
  interface Window {
    Stripe?: (publishableKey: string) => StripeJs
  }
}

/**
 * Baked into the bundle at build time, so `pnpm run deploy` has to be run with
 * it set. It is a publishable key: public by design, unlike the two Worker
 * secrets. See the README runbook.
 */
const PUBLISHABLE_KEY: string = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY ?? ''

let loader: Promise<void> | null = null

function loadStripeJs(): Promise<void> {
  if (window.Stripe !== undefined) return Promise.resolve()
  if (loader !== null) return loader
  loader = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = STRIPE_JS
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('could not load Stripe.js'))
    document.head.appendChild(script)
  })
  return loader
}

export function PaymentPanel({ payment }: { payment: PaymentRequiredMessage }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const elementsRef = useRef<StripeElements | null>(null)
  const stripeRef = useRef<StripeJs | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'submitting' | 'submitted'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (PUBLISHABLE_KEY.length === 0) {
      setError('This build has no Stripe publishable key. See the README runbook.')
      return
    }

    let cancelled = false
    let element: StripeElement | null = null

    loadStripeJs()
      .then(() => {
        if (cancelled || mountRef.current === null || window.Stripe === undefined) return
        const stripe = window.Stripe(PUBLISHABLE_KEY)
        const elements = stripe.elements({ clientSecret: payment.clientSecret })
        element = elements.create('payment')
        element.mount(mountRef.current)
        stripeRef.current = stripe
        elementsRef.current = elements
        setStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setError('Could not reach Stripe. Check your connection.')
      })

    return () => {
      cancelled = true
      element?.unmount()
    }
  }, [payment.clientSecret])

  const pay = async () => {
    const stripe = stripeRef.current
    const elements = elementsRef.current
    if (stripe === null || elements === null) return
    setStatus('submitting')
    setError(null)
    const result = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.href },
      redirect: 'if_required',
    })
    if (result.error !== undefined) {
      setError(result.error.message ?? 'That card was declined.')
      setStatus('ready')
      return
    }
    // Deliberately not 'paid': the receipt unlocks on the server's
    // payment_cleared, which only arrives once the buddy has paid too.
    setStatus('submitted')
  }

  return (
    <div className="printed mt-5" style={{ animationDelay: '760ms' }}>
      <p className="font-display text-[0.65rem] tracking-[0.15em] text-faded uppercase">
        Your half — {formatCents(payment.amountCents)}
      </p>

      {status === 'submitted' ? (
        <p className="mt-3 font-body text-sm leading-snug">
          Paid. Waiting on your bud's half before the pickup code prints.
        </p>
      ) : (
        <>
          <div ref={mountRef} className="mt-3" />
          {error !== null && <p className="mt-3 font-body text-sm text-ketchup">{error}</p>}
          <button
            type="button"
            onClick={pay}
            disabled={status !== 'ready'}
            className="mt-4 w-full bg-ink px-4 py-4 font-display text-sm font-bold tracking-[0.15em] text-paper uppercase transition-transform active:translate-y-px disabled:opacity-35"
          >
            {status === 'submitting' ? 'Charging…' : `Pay ${formatCents(payment.amountCents)}`}
          </button>
        </>
      )}
    </div>
  )
}
