#!/usr/bin/env node
/**
 * Verifies whichever pairing mode the target server is actually in.
 *
 * `scripts/smoke.mjs` covers the authenticated path by seeding sessions into KV.
 * This checks the mode boundary instead, reading `/api/health` to find out which
 * side of it the server sits on:
 *
 *   demoPairing false ⇒ an unauthenticated upgrade must be refused (401).
 *   demoPairing true  ⇒ two unauthenticated clients must pair with each other,
 *                       under the names they proposed, with `demo:` identities.
 *
 * Both directions matter: the flag existing is not evidence that turning it off
 * still closes the door.
 *
 * Usage:  BASE=http://localhost:5199 node scripts/demo-pairing-check.mjs
 */

const BASE = process.env.BASE ?? 'http://localhost:5199'
const WS = BASE.replace('http', 'ws')

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
const demo = health.demoPairing === true
console.log(`server reports demoPairing=${health.demoPairing} (protocol ${health.protocol})\n`)

function open(name, lat, lng) {
  const params = new URLSearchParams({ lat: String(lat), lng: String(lng), name })
  const ws = new WebSocket(`${WS}/api/pool/ws?${params}`)
  const inbox = []
  const waiters = []
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data)
    inbox.push(msg)
    const w = waiters.find((x) => x.type === msg.type)
    if (w) {
      waiters.splice(waiters.indexOf(w), 1)
      w.resolve(msg)
    }
  })
  return {
    ws,
    inbox,
    opened: new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    }),
    expect(type, ms = 5000) {
      const found = inbox.find((m) => m.type === type)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve })
        setTimeout(() => reject(new Error(`${name}: timed out waiting for ${type}`)), ms)
      })
    },
    join(dealId = 'mcd-nuggets-20') {
      ws.send(JSON.stringify({ type: 'join', dealId, lat, lng }))
    },
  }
}

if (!demo) {
  // Strict mode: the identity gate runs before the upgrade check, so a plain GET
  // exercises it. (undici forbids setting Upgrade/Connection on a fetch, and a
  // real socket would only surface the refusal as an opaque connection error.)
  const res = await fetch(`${BASE}/api/pool/ws?lat=37.7955&lng=-122.3937`)
  check('unauthenticated upgrade refused', res.status === 401, `status ${res.status}`)
  const body = await res.json().catch(() => ({}))
  check('refusal says why', body.error === 'sign in required', JSON.stringify(body))
} else {
  const a = open('Robb', 37.7955, -122.3937)
  const b = open('Dana', 37.7958, -122.394)
  await Promise.all([a.opened, b.opened])

  const welcome = await a.expect('welcome')
  check(
    'demo socket is welcomed',
    typeof welcome.cell === 'string' && welcome.cell.length === 6,
    welcome.cell,
  )
  check(
    'welcome carries a demo identity',
    typeof welcome.user?.id === 'string' && welcome.user.id.startsWith('demo:'),
    JSON.stringify(welcome.user),
  )

  a.join()
  await a.expect('waiting')
  b.join()
  const [ma, mb] = await Promise.all([a.expect('matched'), b.expect('matched')])

  check(
    'both unauthenticated clients matched',
    ma.matchId === mb.matchId,
    `${ma.matchId} / ${mb.matchId}`,
  )
  check(
    'roles are complementary',
    ma.role === 'orderer' && mb.role === 'receiver',
    `${ma.role}/${mb.role}`,
  )
  check(
    'proposed names crossed over',
    ma.buddy.name === 'Dana' && mb.buddy.name === 'Robb',
    `${ma.buddy.name}/${mb.buddy.name}`,
  )
  check('settlement still splits to $4.49', ma.share.payCents === 449 && mb.share.payCents === 449)
  check('each saves $2.50', ma.share.savingsCents === 250)

  for (const s of [a, b]) s.ws.close()
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
