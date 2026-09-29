import { describe, expect, it } from 'vitest'
import { assessClientKey, detectPublishableKey, parseBuildInfo } from '../scripts/build-info.mjs'

describe('detectPublishableKey', () => {
  it('reads none, test and live off the bundle text', () => {
    expect(detectPublishableKey(['var a="has no Stripe publishable key"'])).toBe('none')
    expect(detectPublishableKey(['x="pk_test_abcdefgh12345"'])).toBe('test')
    expect(detectPublishableKey(['x="pk_live_abcdefgh12345"'])).toBe('live')
  })
  it('does not let a test key mask a live one in another chunk', () => {
    expect(detectPublishableKey(['pk_test_abcdefgh12345', 'pk_live_abcdefgh12345'])).toBe('live')
  })
})

describe('parseBuildInfo', () => {
  it('rejects anything that is not a known mode', () => {
    expect(parseBuildInfo(null)).toBeNull()
    expect(parseBuildInfo({ stripePublishableKey: 'sk_live' })).toBeNull()
    expect(parseBuildInfo({ stripePublishableKey: 'live' })).toEqual({
      stripePublishableKey: 'live',
    })
  })
})

describe('assessClientKey', () => {
  it('fails when payments are live and the bundle has no key', () => {
    expect(assessClientKey('live', { stripePublishableKey: 'none' }).ok).toBe(false)
  })
  it('fails closed when payments are live and build info is unreadable', () => {
    expect(assessClientKey('live', null).ok).toBe(false)
  })
  it('passes live with a key, and does not add failures to non-live modes', () => {
    expect(assessClientKey('live', { stripePublishableKey: 'live' }).ok).toBe(true)
    expect(assessClientKey('unconfigured', { stripePublishableKey: 'none' }).ok).toBe(true)
    expect(assessClientKey('unconfigured', null).ok).toBe(true)
  })
})
