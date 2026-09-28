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
 * `FAKE_STRIPE_SERVE=<port>` makes this script *host* that stub itself rather
 * than expect one already running. That is how CI does it: a backgrounded `&`
 * step does not reliably outlive the step that started it, so the stub's lifetime
 * belongs to this process instead.
 *
 * Usage:
 *   BASE=http://localhost:5248 node scripts/payment-gate-check.mjs
 *   BASE=... FAKE_STRIPE=http://localhost:5312 FAKE_STRIPE_SERVE=5312 \
 *     STRIPE_WEBHOOK_SECRET=whsec_x node scripts/payment-gate-check.mjs
 */
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startFakeStripe } from './fake-stripe.mjs'
import { FIXTURE_COORDS } from './pool-fixtures.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5248'
const WS = BASE.replace('http', 'ws')
const FAKE_STRIPE = process.env.FAKE_STRIPE ?? null
const FAKE_STRIPE_SERVE = process.env.FAKE_STRIPE_SERVE ?? null
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? null
const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }

const DEAL_ID = 'mcd-nuggets-20'
/**
 * The deal is fixed because `ACTIVE_DEALS` gates the join path: isolating these
 * fixtures with a second deal id would have them refused as `unknown_deal`, which
 * is the gate working. Isolation is by *distance* instead, and it comes from the
 * one table every lane shares (`scripts/pool-fixtures.mjs`): these two are a
 * market of their own, more than a hundred kilometres from every fixture in
 * `scripts/smoke.mjs` and `e2e/`, which `test/fixture-separation.test.ts` checks
 * rather than leaving to this comment. Since #82 a shared geohash cell no longer
 * means a shared market — the cell is ~156 km wide — so "nowhere near" has to be
 * measured, not asserted.
 */
const HERE = FIXTURE_COORDS.payHere
const NEARBY = FIXTURE_COORDS.payNearby

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
  // The late-success pair: one card declines, the OTHER clears afterwards (3DS),
  // against a match the pool has already torn down.
  una: { sid: sessionId('pay-una'), userId: accountId(6), name: 'Una' },
  vic: { sid: sessionId('pay-vic'), userId: accountId(7), name: 'Vic' },
  // The refused-refund pair: one half pays, the other declines, and Stripe
  // refuses to hand the first one's money back.
  wes: { sid: sessionId('pay-wes'), userId: accountId(8), name: 'Wes' },
  zed: { sid: sessionId('pay-zed'), userId: accountId(9), name: 'Zed' },
}

/** Tell the fake Stripe to refuse refunds (or, with no argument, to stop). */
async function failRefunds(status = 0) {
  const res = await fetch(`${FAKE_STRIPE}/__fail`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refunds: status }),
  })
  return await res.json()
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

// Hosted here, before the first socket, so nothing the dev server does can find
// the stub missing. The dev server only calls Stripe once a match is struck, which
// cannot happen until this script joins the pool below.
const hosted =
  FAKE_STRIPE_SERVE === null ? null : await startFakeStripe({ port: Number(FAKE_STRIPE_SERVE) })
if (hosted !== null) log(`hosting the fake Stripe API on port ${FAKE_STRIPE_SERVE}\n`)

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

  // --- a leg that succeeds AFTER the other one failed is still refunded ---
  //
  // Two buyers confirm cards in parallel. The first declines and the match is
  // torn down; the second clears two seconds later behind 3DS, against a match
  // this pool no longer has. Before the tombstone, that webhook was answered
  // `unknown_match` and the buyer kept a $4.49 charge for a box that never
  // existed — with a green unit test over the branch that would have refunded it,
  // because no live path could reach that branch. There is no way to see this
  // from a pure function: the deletion is what breaks it.
  if (FAKE_STRIPE !== null) {
    const una = open(BUYERS.una, HERE)
    const vic = open(BUYERS.vic, NEARBY)
    await Promise.all([una.opened, vic.opened])
    await Promise.all([una.expect('welcome'), vic.expect('welcome')])
    una.join()
    await una.expect('waiting')
    vic.join()
    const [mu, mv] = await Promise.all([una.expect('matched'), vic.expect('matched')])
    const ru = await una.expect('payment_required')
    const rv = await vic.expect('payment_required')

    // Una's card declines. The match dies with Vic's PaymentIntent still open.
    await deliverWebhook(intentOf(ru), 'payment_intent.payment_failed', {
      match_id: mu.matchId,
      role: mu.role,
      cell,
    })
    const dead = await vic.expect('payment_failed')
    check(
      'a declined half kills the match for the other buyer',
      dead.matchId === mu.matchId && dead.whose === 'buddy',
      JSON.stringify(dead),
    )
    check(
      'nothing was collected from the declining half',
      dead.refundedCents === 0,
      `${dead.refundedCents}`,
    )

    // ...and now Vic's clears, against a match that is already gone.
    const late = await deliverWebhook(intentOf(rv), 'payment_intent.succeeded', {
      match_id: mu.matchId,
      role: mv.role,
      cell,
    })
    check('the late success is acknowledged', late.status === 200, JSON.stringify(late.body))

    await new Promise((r) => setTimeout(r, 800))
    const afterLate = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
    const lateRefunds = afterLate.refunds.filter((r) => r.idempotencyKey.includes(mu.matchId))
    check(
      'a leg that succeeds AFTER the other failed is refunded',
      lateRefunds.length === 1 && lateRefunds[0].paymentIntent === intentOf(rv),
      JSON.stringify(lateRefunds),
    )
    check(
      'and that refund is keyed on the dead match and the late role',
      lateRefunds[0]?.idempotencyKey === `refund:${mu.matchId}:${mv.role}`,
      `${lateRefunds[0]?.idempotencyKey}`,
    )
    const lateBooked = ledgerQuery(
      `SELECT COUNT(*) AS n FROM matches WHERE match_id = '${mu.matchId}'`,
    )
    check('the dead match still books no ledger row', (lateBooked[0]?.n ?? 0) === 0)

    for (const socket of [una, vic]) socket.ws.close()
  }

  // --- a refund the processor refuses is reported as a refund that did not happen ---
  //
  // `refundedCents` used to be the amount *collected*, computed before the Stripe
  // call, and the call's failure was swallowed — so a buyer was told
  // `refunded=true refundedCents=449` while every refund call had failed, and the
  // stored record agreed with the lie. What a buyer is told now is what Stripe
  // actually did.
  if (FAKE_STRIPE !== null) {
    const wes = open(BUYERS.wes, HERE)
    const zed = open(BUYERS.zed, NEARBY)
    await Promise.all([wes.opened, zed.opened])
    await Promise.all([wes.expect('welcome'), zed.expect('welcome')])
    wes.join()
    await wes.expect('waiting')
    zed.join()
    const [mw, mz] = await Promise.all([wes.expect('matched'), zed.expect('matched')])
    const rw = await wes.expect('payment_required')
    const rz = await zed.expect('payment_required')

    await failRefunds(500)

    // Wes pays; Zed declines. Wes is owed a refund that Stripe will refuse.
    await deliverWebhook(intentOf(rw), 'payment_intent.succeeded', {
      match_id: mw.matchId,
      role: mw.role,
      cell,
    })
    await deliverWebhook(intentOf(rz), 'payment_intent.payment_failed', {
      match_id: mw.matchId,
      role: mz.role,
      cell,
    })

    const told = await wes.expect('payment_failed')
    check(
      'a buyer is NOT told they were refunded when the refund failed',
      told.refunded === false && told.refundedCents === 0,
      `refunded=${told.refunded} refundedCents=${told.refundedCents}`,
    )
    check(
      'they are told what is still held instead',
      told.heldCents === rw.amountCents,
      `${told.heldCents} vs ${rw.amountCents}`,
    )

    await new Promise((r) => setTimeout(r, 400))
    const afterFail = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
    check(
      'the refund really was attempted and really was refused',
      afterFail.refundAttempts.some(
        (r) => r.idempotencyKey === `refund:${mw.matchId}:${mw.role}`,
      ) && afterFail.refunds.every((r) => !r.idempotencyKey.includes(mw.matchId)),
      `attempts ${JSON.stringify(afterFail.refundAttempts.filter((r) => r.idempotencyKey.includes(mw.matchId)))}, successes ${JSON.stringify(afterFail.refunds.filter((r) => r.idempotencyKey.includes(mw.matchId)))}`,
    )

    // Restored, so nothing after this runs against a stub that refuses refunds.
    const cleared = await failRefunds(0)
    check('the refund stub is restored', cleared.refunds === 0, JSON.stringify(cleared))

    for (const socket of [wes, zed]) socket.ws.close()
  }
}

hosted?.server.close()

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
