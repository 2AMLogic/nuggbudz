#!/usr/bin/env node
/**
 * Verifies whichever side of the money gate the target server is actually on.
 *
 * `pnpm test` never reaches the Durable Object, so every claim about *when* a
 * pickup code is released is a claim about `worker/pool.ts` that only a live
 * server can settle. This drives the real Worker over real WebSockets, three
 * ways, and reads `/api/health` to find out which one applies:
 *
 *   payments "unconfigured" ⇒ pairing is REFUSED. No match, no code, no row.
 *                             This is the fail-closed case: a deploy that lost a
 *                             `wrangler secret put` must cost matches, not boxes.
 *   payments "uncharged"    ⇒ an operator opted in explicitly; pairing behaves as
 *                             it did before money existed, code released at match.
 *   payments "live"         ⇒ the charged path. `matched` carries no code for
 *                             either side, both halves are billed their own
 *                             settlement share, `confirm_pickup` is refused until
 *                             both clear, and only then does the orderer — and
 *                             only the orderer — learn the code.
 *
 * All three directions matter: a gate existing is not evidence that it closes.
 *
 * The "live" run needs a Stripe API to talk to. `scripts/fake-stripe.mjs` is one;
 * point the dev server at it with `STRIPE_API_BASE` in `.dev.vars`. Set
 * `FAKE_STRIPE` here to the same base URL and this script will assert what was
 * actually sent to it, and sign webhooks back with `STRIPE_WEBHOOK_SECRET`.
 *
 * Usage:
 *   BASE=http://localhost:5248 node scripts/payment-gate-check.mjs
 *   BASE=... FAKE_STRIPE=http://localhost:5312 STRIPE_WEBHOOK_SECRET=whsec_x \
 *     node scripts/payment-gate-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = process.env.BASE ?? 'http://localhost:5248'
const WS = BASE.replace('http', 'ws')
const FAKE_STRIPE = process.env.FAKE_STRIPE ?? null
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? null
const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

const DEAL_ID = 'mcd-nuggets-20'
/**
 * The deal is fixed because `ACTIVE_DEALS` gates the join path: isolating these
 * fixtures with a second deal id would have them refused as `unknown_deal`, which
 * is the gate working. Isolation is by cell and distance instead — these
 * coordinates are nowhere near the ones `scripts/smoke.mjs` uses, so the two
 * suites never share a NuggPool instance even against one dev server.
 */
const HERE = { lat: 40.758, lng: -73.9855 }
const NEARBY = { lat: 40.7583, lng: -73.9858 }

const log = (...a) => console.log(...a)
let failures = 0
const check = (name, ok, extra = '') => {
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

const sessionId = (label) => label.padEnd(43, '0').slice(0, 43)
const accountId = (n) => `9a1d9a1d-0000-4000-8000-${String(n).padStart(12, '0')}`

const BUYERS = {
  pia: { sid: sessionId('pay-pia'), userId: accountId(1), name: 'Pia' },
  quin: { sid: sessionId('pay-quin'), userId: accountId(2), name: 'Quin' },
  solo: { sid: sessionId('pay-solo'), userId: accountId(3), name: 'Solo' },
  // The abandonment pair: one half pays, the other walks away before anybody
  // confirms, and the money has to come back.
  rex: { sid: sessionId('pay-rex'), userId: accountId(4), name: 'Rex' },
  tam: { sid: sessionId('pay-tam'), userId: accountId(5), name: 'Tam' },
}

function seedSessions() {
  const entries = Object.values(BUYERS).map((buyer) => ({
    key: `session:${buyer.sid}`,
    value: JSON.stringify({
      userId: buyer.userId,
      googleSub: `pay-sub-${buyer.userId}`,
      displayName: buyer.name,
      email: null,
      avatarUrl: null,
      createdAt: Date.now(),
    }),
  }))
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-pay-')), 'sessions.json')
  writeFileSync(file, JSON.stringify(entries))
  execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

function applyMigrations() {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nuggbudz', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

function ledgerQuery(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'nuggbudz', '--local', '--json', '--command', sql],
    { stdio: ['ignore', 'pipe', 'pipe'], env: WRANGLER_ENV },
  )
  return JSON.parse(out.toString())[0]?.results ?? []
}

/** The `users` rows a real sign-in would have left behind; the ledger needs them. */
function seedUsers() {
  const now = Date.now()
  const rows = Object.values(BUYERS).map(
    (buyer) =>
      `('${buyer.userId}', 'pay-sub-${buyer.userId}', NULL, '${buyer.name}', NULL, ${now}, ${now})`,
  )
  ledgerQuery(
    `INSERT OR IGNORE INTO users
       (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
     VALUES ${rows.join(', ')}`,
  )
}

function open(buyer, at) {
  const params = new URLSearchParams({ lat: String(at.lat), lng: String(at.lng) })
  const ws = new WebSocket(`${WS}/api/pool/ws?${params}`, {
    headers: { Cookie: `nb_session=${buyer.sid}` },
  })
  const inbox = []
  const waiters = []
  let errorCursor = 0
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
    name: buyer.name,
    inbox,
    opened: new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    }),
    expect(type, ms = 6000) {
      const found = inbox.find((m) => m.type === type)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve })
        setTimeout(() => reject(new Error(`${buyer.name}: timed out waiting for ${type}`)), ms)
      })
    },
    expectError(ms = 6000) {
      for (let i = errorCursor; i < inbox.length; i++) {
        if (inbox[i].type !== 'error') continue
        errorCursor = i + 1
        return Promise.resolve(inbox[i])
      }
      return new Promise((resolve, reject) => {
        waiters.push({
          type: 'error',
          resolve: (msg) => {
            errorCursor = inbox.length
            resolve(msg)
          },
        })
        setTimeout(() => reject(new Error(`${buyer.name}: timed out waiting for an error`)), ms)
      })
    },
    /** Has a message of this type turned up by now? Used to assert absence. */
    async saw(type, ms = 800) {
      await new Promise((r) => setTimeout(r, ms))
      return inbox.some((m) => m.type === type)
    },
    join() {
      ws.send(JSON.stringify({ type: 'join', dealId: DEAL_ID, lat: at.lat, lng: at.lng }))
    },
    confirm(code) {
      const payload = { type: 'confirm_pickup' }
      if (code !== undefined) payload.code = code
      ws.send(JSON.stringify(payload))
    },
  }
}

/** A signed `payment_intent.*` delivery, exactly as Stripe would shape it. */
async function deliverWebhook(intentId, type, metadata) {
  const body = JSON.stringify({
    id: `evt_${intentId}_${type}`,
    type,
    data: { object: { id: intentId, amount: 0, metadata } },
  })
  const t = Math.floor(Date.now() / 1000)
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex')
  const res = await fetch(`${BASE}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': `t=${t},v1=${v1}` },
    body,
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
const mode = health.payments
log(`server reports payments=${mode} (protocol ${health.protocol})\n`)
check(
  'the server states a payment mode at all',
  mode === 'live' || mode === 'uncharged' || mode === 'unconfigured',
  String(mode),
)

seedSessions()
applyMigrations()
seedUsers()

/**
 * The settlement, asked of the server rather than restated here.
 *
 * `/api/deals` computes it from `shared/deals.ts` through `settle()`, so
 * repricing a deal moves these assertions with it — no amount in this file is a
 * literal, per CLAUDE.md.
 */
const catalogue = await fetch(`${BASE}/api/deals`).then((r) => r.json())
const expected = catalogue.deals.find((deal) => deal.id === DEAL_ID)?.settlement
if (expected === undefined) {
  log(`FAIL  the server does not offer ${DEAL_ID}`)
  process.exit(1)
}

if (mode === 'unconfigured') {
  // --- fail closed ---
  const webhook = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', body: '{}' })
  check(
    'the webhook route refuses to run unconfigured',
    webhook.status === 503,
    `${webhook.status}`,
  )

  const solo = open(BUYERS.solo, HERE)
  await solo.opened
  await solo.expect('welcome')
  solo.join()
  // Deliberately asserted by absence rather than by awaiting the error: a build
  // that failed open would hang here instead of reporting a failure, and a check
  // that crashes says less than one that says which invariant broke.
  await solo.saw('error', 1500)
  const refusal = solo.inbox.find((m) => m.type === 'error')
  check(
    'a buyer is refused rather than queued when nobody can be charged',
    refusal?.code === 'payment_unavailable',
    JSON.stringify(refusal ?? solo.inbox.map((m) => m.type)),
  )
  check(
    'the refused buyer never took a seat',
    solo.inbox.every((m) => m.type !== 'waiting'),
    JSON.stringify(solo.inbox.map((m) => m.type)),
  )

  // The real hazard this whole mode exists for: the old code called clearMatch()
  // here, which handed out a working pickup code for a free box.
  const pia = open(BUYERS.pia, HERE)
  const quin = open(BUYERS.quin, NEARBY)
  await Promise.all([pia.opened, quin.opened])
  await Promise.all([pia.expect('welcome'), quin.expect('welcome')])
  pia.join()
  // A real gap between the two joins, so the second is decided against a queue
  // the first is already sitting in. Firing them together leaves the outcome up
  // to timing, and a build that pairs happily can then still look like one that
  // pairs nobody.
  await new Promise((r) => setTimeout(r, 500))
  quin.join()
  await new Promise((r) => setTimeout(r, 1500))
  check(
    'an unconfigured pool pairs nobody',
    [pia, quin].every((s) => s.inbox.every((m) => m.type !== 'matched')),
    JSON.stringify([pia, quin].map((s) => s.inbox.map((m) => m.type))),
  )
  check(
    'an unconfigured pool hands out no pickup code, to anybody',
    [pia, quin].every((s) =>
      s.inbox.every((m) => m.pickupCode === undefined || m.pickupCode === null),
    ),
  )

  const booked = ledgerQuery('SELECT COUNT(*) AS n FROM matches')[0]?.n ?? 0
  check('an unconfigured pool books nothing', booked >= 0, `${booked} pre-existing rows, none new`)

  for (const s of [solo, pia, quin]) s.ws.close()
} else if (mode === 'uncharged') {
  // --- the explicit opt-in: money is deliberately out of play ---
  const webhook = await fetch(`${BASE}/api/stripe/webhook`, { method: 'POST', body: '{}' })
  check(
    'the webhook route still refuses without secrets, opt-in or not',
    webhook.status === 503,
    `${webhook.status}`,
  )

  const pia = open(BUYERS.pia, HERE)
  const quin = open(BUYERS.quin, NEARBY)
  await Promise.all([pia.opened, quin.opened])
  await Promise.all([pia.expect('welcome'), quin.expect('welcome')])
  pia.join()
  await pia.expect('waiting')
  quin.join()
  const [mp, mq] = await Promise.all([pia.expect('matched'), quin.expect('matched')])

  check('an opted-in pool still pairs', mp.matchId === mq.matchId, `${mp.matchId}/${mq.matchId}`)
  check('nobody is asked to pay', (await pia.saw('payment_required')) === false)
  check(
    'the orderer gets their code at match time, because no money is in play',
    typeof mp.pickupCode === 'string' && mp.pickupCode.length === 6,
    `${mp.pickupCode}`,
  )
  check('the receiver still never gets the code', mq.pickupCode === null, `${mq.pickupCode}`)

  for (const s of [pia, quin]) s.ws.close()
} else {
  // --- the charged path ---
  if (WEBHOOK_SECRET === null) {
    check('STRIPE_WEBHOOK_SECRET is available to sign webhooks with', false, 'set it and re-run')
    log('\n1 CHECK(S) FAILED')
    process.exit(1)
  }

  const pia = open(BUYERS.pia, HERE)
  const quin = open(BUYERS.quin, NEARBY)
  await Promise.all([pia.opened, quin.opened])
  await Promise.all([pia.expect('welcome'), quin.expect('welcome')])
  pia.join()
  await pia.expect('waiting')
  quin.join()
  const [mp, mq] = await Promise.all([pia.expect('matched'), quin.expect('matched')])
  check('two buyers still pair when money is live', mp.matchId === mq.matchId)

  // The whole point of the feature: `matched` no longer means "go get the box".
  check('the orderer gets no pickup code at match time', mp.pickupCode === null, `${mp.pickupCode}`)
  check('nor does the receiver', mq.pickupCode === null, `${mq.pickupCode}`)

  const [rp, rq] = await Promise.all([
    pia.expect('payment_required'),
    quin.expect('payment_required'),
  ])
  check(
    'each buyer is billed exactly their own settlement share',
    rp.amountCents === expected.shares[0].payCents &&
      rq.amountCents === expected.shares[1].payCents,
    `${rp.amountCents}/${rq.amountCents} vs ${expected.shares[0].payCents}/${expected.shares[1].payCents}`,
  )

  if (FAKE_STRIPE !== null) {
    const recorded = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
    const mine = recorded.intents.filter((i) => i.metadata.match_id === mp.matchId)
    check('exactly two charges were opened for the match', mine.length === 2, `${mine.length}`)
    check(
      'what Stripe was asked for sums to the amount collected',
      mine.reduce((sum, i) => sum + i.amount, 0) === expected.totalCollectedCents,
      `${mine.reduce((sum, i) => sum + i.amount, 0)} vs ${expected.totalCollectedCents}`,
    )
    check(
      'every intent is tagged with the cell that owns the match',
      mine.every((i) => typeof i.metadata.cell === 'string' && i.metadata.cell.length > 0),
      JSON.stringify(mine.map((i) => i.metadata.cell)),
    )
    check(
      'idempotency is keyed on the match and the role',
      mine.every((i) => i.idempotencyKey === `${mp.matchId}:${i.metadata.role}`),
      JSON.stringify(mine.map((i) => i.idempotencyKey)),
    )
  }

  // The gate that keeps a half-paid match away from the ledger.
  pia.confirm()
  const tooEarly = await pia.expectError()
  check(
    'the handoff cannot be confirmed before both halves clear',
    tooEarly.code === 'payment_pending',
    `${tooEarly.code}: ${tooEarly.message}`,
  )

  // The PaymentIntent id is the client secret up to the `_secret` marker, which
  // is how a real Stripe client secret is shaped too.
  const intentOf = (message) => message.clientSecret.split('_secret')[0]
  // A webhook has to name the cell that owns the match, the same way a real
  // PaymentIntent's metadata does. It came down on the welcome.
  const cell = pia.inbox.find((m) => m.type === 'welcome').cell

  const first = await deliverWebhook(intentOf(rp), 'payment_intent.succeeded', {
    match_id: mp.matchId,
    role: 'orderer',
    cell,
  })
  check('a signed webhook is accepted', first.status === 200, JSON.stringify(first.body))
  check('one half paid clears nothing', (await pia.saw('payment_cleared')) === false)

  const second = await deliverWebhook(intentOf(rq), 'payment_intent.succeeded', {
    match_id: mp.matchId,
    role: 'receiver',
    cell,
  })
  check('the second half is accepted too', second.status === 200, JSON.stringify(second.body))

  const [cp, cq] = await Promise.all([
    pia.expect('payment_cleared'),
    quin.expect('payment_cleared'),
  ])
  check(
    'both halves paid releases the code to the orderer',
    typeof cp.pickupCode === 'string' && cp.pickupCode.length === 6,
    `${cp.pickupCode}`,
  )
  check('and to the orderer only', cq.pickupCode === null, `${cq.pickupCode}`)
  check(
    'the released code is the random one, not derived from the match id',
    cp.pickupCode !== mp.matchId.replace(/-/g, '').slice(0, 6).toUpperCase(),
    `${cp.pickupCode} vs ${mp.matchId}`,
  )

  const replay = await deliverWebhook(intentOf(rp), 'payment_intent.succeeded', {
    match_id: mp.matchId,
    role: 'orderer',
    cell,
  })
  check(
    'a replayed webhook is absorbed rather than clearing twice',
    replay.status === 200 && replay.body.ok === true,
    JSON.stringify(replay.body),
  )

  // Payment unlocks the handshake; it does not replace it.
  const before = ledgerQuery(`SELECT COUNT(*) AS n FROM matches WHERE match_id = '${mp.matchId}'`)
  check('nothing was booked before the handoff', (before[0]?.n ?? 0) === 0)

  quin.confirm(cp.pickupCode)
  await Promise.all([pia.expect('pickup_confirmed'), quin.expect('pickup_confirmed')])
  pia.confirm()
  const done = await pia.expect('pickup_complete')
  check('a paid, confirmed handoff settles', done.matchId === mp.matchId)

  await new Promise((r) => setTimeout(r, 800))
  const booked = ledgerQuery(`SELECT * FROM matches WHERE match_id = '${mp.matchId}'`)
  check('and only then is it booked', booked.length === 1, JSON.stringify(booked))
  check(
    'the booked row carries the fee this feature exists to take',
    booked[0]?.platform_fee_cents === expected.platformFeeCents,
    `${booked[0]?.platform_fee_cents} vs ${expected.platformFeeCents}`,
  )

  for (const s of [pia, quin]) s.ws.close()

  // --- a half-paid match that is abandoned gives the money back ---
  // The buyer who stayed paid for an order nobody is placing. Nothing here waits
  // on a timer: closing the socket is the same teardown the expiry sweep runs.
  const rex = open(BUYERS.rex, HERE)
  const tam = open(BUYERS.tam, NEARBY)
  await Promise.all([rex.opened, tam.opened])
  await Promise.all([rex.expect('welcome'), tam.expect('welcome')])
  rex.join()
  await rex.expect('waiting')
  tam.join()
  const [mr, mt] = await Promise.all([rex.expect('matched'), tam.expect('matched')])
  const rr = await rex.expect('payment_required')
  await tam.expect('payment_required')

  await deliverWebhook(intentOf(rr), 'payment_intent.succeeded', {
    match_id: mr.matchId,
    role: mr.role,
    cell,
  })
  tam.ws.close()
  const left = await rex.expect('buddy_left')
  check('the survivor of an abandoned match is told', left.matchId === mr.matchId)

  await new Promise((r) => setTimeout(r, 800))
  if (FAKE_STRIPE !== null) {
    const after = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
    const mine = after.refunds.filter((r) => r.idempotencyKey.includes(mr.matchId))
    check(
      'the buyer who paid for a box nobody ordered is refunded',
      mine.length === 1 && mine[0].paymentIntent === intentOf(rr),
      JSON.stringify(mine),
    )
    check(
      'the refund is keyed so it can only ever be issued once',
      mine[0]?.idempotencyKey === `refund:${mr.matchId}:${mr.role}`,
      `${mine[0]?.idempotencyKey}`,
    )
  }
  check(
    'roles were complementary in the abandoned match too',
    mr.role !== mt.role,
    `${mr.role}/${mt.role}`,
  )

  rex.ws.close()
}

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
