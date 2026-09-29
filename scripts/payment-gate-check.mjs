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
// The charged-dispute triples below (rin/sam, tia/uma, vin/wyn) are a scenario
// of their own — `chargedDisputePair` in scripts/pool-fixtures.mjs — rather
// than a reuse of the pair above: they run in the same script but are a
// distinct market so `test/fixture-separation.test.ts` isolates them from the
// unrelated charged-path scenarios sharing HERE/NEARBY.
const DISPUTE_HERE = FIXTURE_COORDS.disputeHere
const DISPUTE_NEARBY = FIXTURE_COORDS.disputeNearby

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
  // The abandonment-with-a-refused-refund pair: one half pays, the other walks
  // away before anybody confirms — same as rex/tam — but this time Stripe
  // refuses the survivor's refund too, so `buddy_left` has to say so (#86).
  gia: { sid: sessionId('pay-gia'), userId: accountId(10), name: 'Gia' },
  hal: { sid: sessionId('pay-hal'), userId: accountId(11), name: 'Hal' },
  // The held-money pair: one half pays, the other walks away before anybody
  // confirms, and the refund that teardown asks for is refused. Nobody disputed
  // anything, so the only trace of the money is the `holds` row this proves.
  ada: { sid: sessionId('pay-ada'), userId: accountId(12), name: 'Ada' },
  bex: { sid: sessionId('pay-bex'), userId: accountId(13), name: 'Bex' },
  // The charged-dispute triples: each pair confirms one side and then loses the
  // other, which disputes the match rather than refunding it (#20/#102). Each
  // pair feeds exactly one resolution, because a dispute can only be resolved
  // once — a second attempt is a 409, proven separately below.
  rin: { sid: sessionId('pay-rin'), userId: accountId(14), name: 'Rin' },
  sam: { sid: sessionId('pay-sam'), userId: accountId(15), name: 'Sam' },
  tia: { sid: sessionId('pay-tia'), userId: accountId(16), name: 'Tia' },
  uma: { sid: sessionId('pay-uma'), userId: accountId(17), name: 'Uma' },
  vin: { sid: sessionId('pay-vin'), userId: accountId(18), name: 'Vin' },
  wyn: { sid: sessionId('pay-wyn'), userId: accountId(19), name: 'Wyn' },
  // The operator. Never opens a pool socket and owns no coordinate — this one
  // exists to hold a session `OPERATOR_USER_IDS` can name, which is the only
  // way into the holds queue, the retry route, and dispute resolution. Without
  // the var the admin checks report SKIP, unless PAYMENT_GATE_REQUIRE_ADMIN
  // says otherwise.
  op: { sid: sessionId('pay-operator'), userId: accountId(33), name: 'Ops' },
}

const jsonHeaders = { 'Content-Type': 'application/json' }
const cookie = (buyer) => ({ Cookie: `nb_session=${buyer.sid}` })

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

/**
 * Both sides of a pair are two identities, asserted rather than assumed (#101).
 *
 * Each socket here carries its own session cookie, which is what makes them two
 * buyers — and since a second socket of *one* identity is now refused rather
 * than quietly queued, a harness that ever shared a cookie jar between two sides
 * would stop pairing outright. This is the check that would name that, instead
 * of leaving it to a pairing timeout.
 */
async function checkDistinctIdentities(one, two) {
  const [a, b] = await Promise.all([one.expect('welcome'), two.expect('welcome')])
  check(
    'the two sides of this pair are two identities',
    a.user?.id !== undefined && a.user?.id !== b.user?.id,
    `${a.user?.id} / ${b.user?.id}`,
  )
  return [a, b]
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
  await checkDistinctIdentities(pia, quin)
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
  await checkDistinctIdentities(pia, quin)
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
  await checkDistinctIdentities(pia, quin)
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
  await checkDistinctIdentities(rex, tam)
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
  check('and the ordinary refund leaves nothing held', left.heldCents === 0, `${left.heldCents}`)

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
    await checkDistinctIdentities(una, vic)
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
    await checkDistinctIdentities(wes, zed)
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

    // A refused refund on a NON-dispute teardown is now durable, cross-cell.
    // Before this, the only record that Wes was $4.49 out of pocket lived in
    // one Durable Object's storage, and there is no registry of live cells to
    // fan out to — so nobody could enumerate it at all.
    await new Promise((r) => setTimeout(r, 600))
    const failedHold = ledgerQuery(`SELECT * FROM holds WHERE match_id = '${mw.matchId}'`)
    check(
      'a refund the processor refused is filed as a hold, in D1',
      failedHold.length === 1 && failedHold[0].held_cents === rw.amountCents,
      JSON.stringify(failedHold[0] ?? null),
    )
    check(
      'named after the teardown the buyers actually saw',
      failedHold[0]?.reason === 'payment_failed',
      `${failedHold[0]?.reason}`,
    )
    check(
      'open, with nothing claiming a refund that never happened',
      failedHold[0]?.released_at === null && failedHold[0]?.refunded_cents === null,
      JSON.stringify(failedHold[0] ?? null),
    )
    check(
      'and it is a row in `holds`, never one in `disputes`',
      (ledgerQuery(`SELECT COUNT(*) AS n FROM disputes WHERE match_id = '${mw.matchId}'`)[0]?.n ??
        0) === 0,
    )
    // The negative control the listing turns on: Rex's abandonment refunded
    // cleanly, so it owes nobody anything and must NOT be in the queue.
    check(
      'a teardown whose refund succeeded files no hold at all',
      (ledgerQuery(`SELECT COUNT(*) AS n FROM holds WHERE match_id = '${mr.matchId}'`)[0]?.n ??
        0) === 0,
    )
  }

  // --- money held by a buddy walking away, and an operator getting it back ---
  //
  // The `buddy_left` teardown, driven through a refused refund end to end. This
  // is the path issue #85 is named for: nobody disputed anything, so there is
  // no human in the loop by construction, and the money is invisible unless it
  // reaches D1 at the moment the match record is deleted.
  if (FAKE_STRIPE !== null) {
    const ada = open(BUYERS.ada, HERE)
    const bex = open(BUYERS.bex, NEARBY)
    await Promise.all([ada.opened, bex.opened])
    await checkDistinctIdentities(ada, bex)
    ada.join()
    await ada.expect('waiting')
    bex.join()
    const [ma] = await Promise.all([ada.expect('matched'), bex.expect('matched')])
    const ra = await ada.expect('payment_required')
    await bex.expect('payment_required')

    await failRefunds(500)

    // Ada pays. Bex closes the tab before either of them confirms anything, so
    // the teardown asks for Ada's money back — and Stripe says no.
    await deliverWebhook(intentOf(ra), 'payment_intent.succeeded', {
      match_id: ma.matchId,
      role: ma.role,
      cell,
    })
    bex.ws.close()
    const walked = await ada.expect('buddy_left')
    check('the survivor of the abandoned match is told', walked.matchId === ma.matchId)

    await new Promise((r) => setTimeout(r, 800))
    const hold = ledgerQuery(`SELECT * FROM holds WHERE match_id = '${ma.matchId}'`)
    check(
      'money a buddy_left teardown could not return is enumerable in D1',
      hold.length === 1 && hold[0].reason === 'buddy_left' && hold[0].held_cents === ra.amountCents,
      JSON.stringify(hold[0] ?? null),
    )
    check(
      'the row names the cell that still holds the charges, so a retry can find it',
      hold[0]?.cell === cell,
      `${hold[0]?.cell} vs ${cell}`,
    )
    check(
      'and both buddies, so somebody is chaseable when the retry keeps failing',
      hold[0]?.orderer_user_id === BUYERS.ada.userId ||
        hold[0]?.receiver_user_id === BUYERS.ada.userId,
      JSON.stringify(hold[0] ?? null),
    )

    // Now Stripe will take the refund. The retry is the whole second half of
    // this feature: `refundIdempotencyKey` is what makes re-asking safe.
    const restored = await failRefunds(0)
    check('the refund stub is restored before the retry', restored.refunds === 0)

    const adminProbe = await fetch(`${BASE}/api/admin/holds`, { headers: cookie(BUYERS.op) })
    if (adminProbe.status !== 200) {
      const why =
        `this server has no operator for the payment-gate fixture. Add\n      ` +
        `OPERATOR_USER_IDS="${BUYERS.op.userId}"\n      to .dev.vars and restart the dev server to run them.`
      if (process.env.PAYMENT_GATE_REQUIRE_ADMIN) {
        check('operator hold retry', false, `PAYMENT_GATE_REQUIRE_ADMIN is set but ${why}`)
      } else {
        log(`SKIP  operator hold retry — ${why}`)
      }
    } else {
      const queue = await adminProbe.json()
      const listed = queue.holds?.find((h) => h.matchId === ma.matchId)
      check(
        'an operator can see the held money, across every cell, in one query',
        listed !== undefined &&
          listed.reason === 'buddy_left' &&
          listed.heldCents === ra.amountCents &&
          listed.releasedAt === null &&
          listed.refundedCents === null,
        JSON.stringify(listed ?? queue),
      )
      check(
        'and the teardown that refunded cleanly is not in the queue beside it',
        queue.holds?.every((h) => h.matchId !== mr.matchId) === true,
        JSON.stringify(queue.holds?.map((h) => h.matchId)),
      )

      const retried = await fetch(`${BASE}/api/admin/holds/${ma.matchId}/retry`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...cookie(BUYERS.op) },
      })
      const recovered = await retried.json()
      check(
        'a retry recovers the money and says exactly how much',
        retried.status === 200 &&
          recovered.refundedCents === ra.amountCents &&
          recovered.heldCents === 0,
        JSON.stringify(recovered),
      )

      const afterRetry = ledgerQuery(`SELECT * FROM holds WHERE match_id = '${ma.matchId}'`)
      check(
        'what Stripe gave back is stamped on the row, and only after it answered',
        afterRetry[0]?.refunded_cents === ra.amountCents && afterRetry[0]?.held_cents === 0,
        JSON.stringify(afterRetry[0] ?? null),
      )
      check(
        'and the hold is released rather than lingering as open work',
        Number.isInteger(afterRetry[0]?.released_at),
        `${afterRetry[0]?.released_at}`,
      )

      const stillQueued = await fetch(`${BASE}/api/admin/holds`, {
        headers: cookie(BUYERS.op),
      }).then((r) => r.json())
      check(
        'a released hold drops out of the open queue',
        stillQueued.holds?.every((h) => h.matchId !== ma.matchId) === true,
        JSON.stringify(stillQueued.holds?.map((h) => h.matchId)),
      )

      const again = await fetch(`${BASE}/api/admin/holds/${ma.matchId}/retry`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...cookie(BUYERS.op) },
      })
      check(
        'and retrying a released hold is refused rather than refunded twice',
        again.status === 409,
        `status ${again.status}`,
      )

      const recordedAfter = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
      const mine = recordedAfter.refunds.filter((r) => r.idempotencyKey.includes(ma.matchId))
      check(
        'the recovered refund was issued exactly once, on the per-leg key',
        mine.length === 1 && mine[0].idempotencyKey === `refund:${ma.matchId}:${ma.role}`,
        JSON.stringify(mine),
      )

      const anon = await fetch(`${BASE}/api/admin/holds`)
      check('the holds queue is not readable without a session', anon.status === 404)
      const asBuyer = await fetch(`${BASE}/api/admin/holds/${ma.matchId}/retry`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...cookie(BUYERS.ada) },
      })
      check(
        'and a signed-in buyer cannot retry a refund of their own money',
        asBuyer.status === 404,
        `status ${asBuyer.status}`,
      )
    }

    ada.ws.close()
  }

  // --- the survivor of an abandoned match is told when THEIR refund is refused ---
  //
  // The rex/tam scenario above proves `buddy_left` carries `heldCents` and that it
  // is zero in the ordinary case. This is the same teardown — a buddy walks away
  // before anybody confirms — but Stripe refuses the survivor's refund, which used
  // to vanish: `buddy_left` carried no money fields at all, so the survivor's held
  // $4.49 was reported as nothing (#86).
  if (FAKE_STRIPE !== null) {
    const gia = open(BUYERS.gia, HERE)
    const hal = open(BUYERS.hal, NEARBY)
    await Promise.all([gia.opened, hal.opened])
    await checkDistinctIdentities(gia, hal)
    gia.join()
    await gia.expect('waiting')
    hal.join()
    const [mg] = await Promise.all([gia.expect('matched'), hal.expect('matched')])
    const rg = await gia.expect('payment_required')
    await hal.expect('payment_required')

    await failRefunds(500)

    // Gia pays; Hal walks away before either confirms. Gia's refund is owed —
    // and refused.
    await deliverWebhook(intentOf(rg), 'payment_intent.succeeded', {
      match_id: mg.matchId,
      role: mg.role,
      cell,
    })
    hal.ws.close()
    const goneWithHold = await gia.expect('buddy_left')
    check(
      'the survivor is told their money is held, not refunded silently',
      goneWithHold.matchId === mg.matchId && goneWithHold.heldCents === rg.amountCents,
      `matchId=${goneWithHold.matchId} heldCents=${goneWithHold.heldCents} vs ${rg.amountCents}`,
    )

    await new Promise((r) => setTimeout(r, 400))
    const afterHold = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
    check(
      "the survivor's refund really was attempted and really was refused",
      afterHold.refundAttempts.some(
        (r) => r.idempotencyKey === `refund:${mg.matchId}:${mg.role}`,
      ) && afterHold.refunds.every((r) => !r.idempotencyKey.includes(mg.matchId)),
      `attempts ${JSON.stringify(afterHold.refundAttempts.filter((r) => r.idempotencyKey.includes(mg.matchId)))}`,
    )

    // Restored, so nothing after this runs against a stub that refuses refunds.
    const clearedAgain = await failRefunds(0)
    check('the refund stub is restored', clearedAgain.refunds === 0, JSON.stringify(clearedAgain))

    for (const socket of [gia, hal]) socket.ws.close()
  }

  // --- a charged dispute holds real money, and an operator resolves it ---
  //
  // Every scenario above tears down BEFORE anybody confirms, so none of them
  // can reach a dispute — a dispute needs a *confirmed* role on the record
  // (`worker/pool.ts`'s `handleDisconnect`, `confirmedRole(record.confirmations)
  // !== null`). Driven here the same way `scripts/smoke.mjs`'s `disputePair`
  // avoids `PICKUP_CONFIRM_TIMEOUT_MS`: the receiver confirms with the real
  // code, then the orderer's socket closes before it confirms its own half.
  // `pnpm smoke` proves this teardown holds $0, because it runs
  // `ALLOW_UNCHARGED_PAIRING`; only a charged server can prove it holds $8.98
  // and that an operator's resolution moves the right amount, on the right leg,
  // and only when Stripe actually agrees to it (#100).
  if (FAKE_STRIPE !== null) {
    /**
     * Pair two buyers on the shared HERE/NEARBY market, pay both legs, have the
     * receiver confirm with the orderer's real code, then close the orderer's
     * socket before it can confirm its own half — which files a dispute instead
     * of a refund, holding the whole collected total.
     */
    async function driveToDispute(ordererBuyer, receiverBuyer) {
      const orderer = open(ordererBuyer, DISPUTE_HERE)
      const receiver = open(receiverBuyer, DISPUTE_NEARBY)
      await Promise.all([orderer.opened, receiver.opened])
      await checkDistinctIdentities(orderer, receiver)
      const disputeCell = orderer.inbox.find((m) => m.type === 'welcome').cell
      orderer.join()
      await orderer.expect('waiting')
      receiver.join()
      const [mo, mr] = await Promise.all([orderer.expect('matched'), receiver.expect('matched')])
      check(
        'the dispute-bound pair still pairs when money is live',
        mo.matchId === mr.matchId,
        `${mo.matchId}/${mr.matchId}`,
      )
      const ro = await orderer.expect('payment_required')
      const rr = await receiver.expect('payment_required')
      await deliverWebhook(intentOf(ro), 'payment_intent.succeeded', {
        match_id: mo.matchId,
        role: mo.role,
        cell: disputeCell,
      })
      await deliverWebhook(intentOf(rr), 'payment_intent.succeeded', {
        match_id: mo.matchId,
        role: mr.role,
        cell: disputeCell,
      })
      const [co] = await Promise.all([
        orderer.expect('payment_cleared'),
        receiver.expect('payment_cleared'),
      ])
      receiver.confirm(co.pickupCode)
      await receiver.expect('pickup_confirmed')
      orderer.ws.close()
      const disputed = await receiver.expect('pickup_disputed')
      receiver.ws.close()
      return { matchId: mo.matchId, disputed }
    }

    const { matchId: disputeOneId, disputed: disputedOne } = await driveToDispute(
      BUYERS.rin,
      BUYERS.sam,
    )
    check(
      'the orderer walking away after the receiver confirms raises a dispute',
      disputedOne.confirmedBy === 'receiver',
      JSON.stringify(disputedOne),
    )
    check(
      // `pickup_disputed` tells each buddy only their OWN leg, the same way
      // `buddy_left` does — never the counterparty's amount. The receiver is
      // the only socket left open when this arrives (the orderer's closed
      // socket is what raised the dispute), so this is the receiver's share;
      // the D1 row below is what proves the full total is what is actually held.
      "the receiver is told their own share is held, not the buddy's",
      disputedOne.heldCents === expected.shares[1].payCents,
      `${disputedOne.heldCents} vs ${expected.shares[1].payCents}`,
    )

    await new Promise((r) => setTimeout(r, 400))
    const filedOne = ledgerQuery(`SELECT * FROM disputes WHERE match_id = '${disputeOneId}'`)
    check(
      'the charged dispute is filed in D1 holding the same total, refunded_cents unset',
      filedOne.length === 1 &&
        filedOne[0].held_cents === expected.totalCollectedCents &&
        filedOne[0].refunded_cents === null,
      JSON.stringify(filedOne[0] ?? null),
    )
    const beforeResolve = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
    check(
      'nothing was refunded, or even attempted, on the way into a dispute',
      beforeResolve.refundAttempts.every((r) => !r.idempotencyKey.includes(disputeOneId)),
      JSON.stringify(
        beforeResolve.refundAttempts.filter((r) => r.idempotencyKey.includes(disputeOneId)),
      ),
    )

    const adminProbe = await fetch(`${BASE}/api/admin/disputes`, { headers: cookie(BUYERS.op) })
    if (adminProbe.status !== 200) {
      const why =
        `this server has no operator for the payment-gate fixture. Add\n      ` +
        `OPERATOR_USER_IDS="${BUYERS.op.userId}"\n      to .dev.vars and restart the dev server to run them.`
      if (process.env.PAYMENT_GATE_REQUIRE_ADMIN) {
        check(
          'operator charged-dispute resolution',
          false,
          `PAYMENT_GATE_REQUIRE_ADMIN is set but ${why}`,
        )
      } else {
        log(`SKIP  operator charged-dispute resolution — ${why}`)
      }
    } else {
      // refund_receiver: exactly the receiver's own leg, the rest stays held.
      const resolveReceiver = await fetch(`${BASE}/api/admin/disputes/${disputeOneId}/resolve`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...cookie(BUYERS.op) },
        body: JSON.stringify({ resolution: 'refund_receiver' }),
      })
      const receiverResolved = await resolveReceiver.json()
      check(
        'refund_receiver returns exactly the receiver share and holds the rest',
        resolveReceiver.status === 200 &&
          receiverResolved.refundedCents === expected.shares[1].payCents &&
          receiverResolved.heldCents === expected.shares[0].payCents,
        JSON.stringify(receiverResolved),
      )
      const rowAfterReceiver = ledgerQuery(
        `SELECT * FROM disputes WHERE match_id = '${disputeOneId}'`,
      )
      check(
        'the stamped row agrees with the response',
        rowAfterReceiver[0]?.refunded_cents === expected.shares[1].payCents,
        JSON.stringify(rowAfterReceiver[0] ?? null),
      )
      const afterReceiverRecorded = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
      const receiverRefunds = afterReceiverRecorded.refunds.filter((r) =>
        r.idempotencyKey.includes(disputeOneId),
      )
      check(
        'exactly one refund was issued, keyed to the receiver leg alone',
        receiverRefunds.length === 1 &&
          receiverRefunds[0].idempotencyKey === `refund:${disputeOneId}:receiver`,
        JSON.stringify(receiverRefunds),
      )

      // voided: both legs, on a second, still-open dispute.
      const { matchId: disputeTwoId, disputed: disputedTwo } = await driveToDispute(
        BUYERS.tia,
        BUYERS.uma,
      )
      check(
        'the second dispute also tells the receiver only their own share',
        disputedTwo.heldCents === expected.shares[1].payCents,
        `${disputedTwo.heldCents} vs ${expected.shares[1].payCents}`,
      )
      const resolveVoided = await fetch(`${BASE}/api/admin/disputes/${disputeTwoId}/resolve`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...cookie(BUYERS.op) },
        body: JSON.stringify({ resolution: 'voided' }),
      })
      const voidedResolved = await resolveVoided.json()
      check(
        'voided refunds both legs, holding nothing',
        resolveVoided.status === 200 &&
          voidedResolved.refundedCents === expected.totalCollectedCents &&
          voidedResolved.heldCents === 0,
        JSON.stringify(voidedResolved),
      )
      const afterVoidedRecorded = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
      const voidedRefunds = afterVoidedRecorded.refunds.filter((r) =>
        r.idempotencyKey.includes(disputeTwoId),
      )
      check(
        'each leg is refunded exactly once, each keyed to its own role',
        voidedRefunds.length === 2 &&
          new Set(voidedRefunds.map((r) => r.idempotencyKey)).size === 2 &&
          voidedRefunds.every((r) => r.idempotencyKey.startsWith(`refund:${disputeTwoId}:`)),
        JSON.stringify(voidedRefunds),
      )

      // A refused refund is reported as held, never as refunded, on a third dispute.
      const { matchId: disputeThreeId, disputed: disputedThree } = await driveToDispute(
        BUYERS.vin,
        BUYERS.wyn,
      )
      check(
        'the third dispute also tells the receiver only their own share',
        disputedThree.heldCents === expected.shares[1].payCents,
        `${disputedThree.heldCents} vs ${expected.shares[1].payCents}`,
      )
      await failRefunds(402)
      const resolveRefused = await fetch(`${BASE}/api/admin/disputes/${disputeThreeId}/resolve`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...cookie(BUYERS.op) },
        body: JSON.stringify({ resolution: 'voided' }),
      })
      const refusedResolved = await resolveRefused.json()
      check(
        'a refund Stripe refuses is answered as held, never as refunded',
        resolveRefused.status === 200 &&
          refusedResolved.refundedCents === 0 &&
          refusedResolved.heldCents === expected.totalCollectedCents,
        JSON.stringify(refusedResolved),
      )
      const rowAfterRefused = ledgerQuery(
        `SELECT * FROM disputes WHERE match_id = '${disputeThreeId}'`,
      )
      check(
        'the row stamps 0 — money collected, not returned — rather than leaving it NULL',
        rowAfterRefused[0]?.refunded_cents === 0,
        JSON.stringify(rowAfterRefused[0] ?? null),
      )
      const afterRefusedRecorded = await fetch(`${FAKE_STRIPE}/__recorded`).then((r) => r.json())
      const refusedAttempts = afterRefusedRecorded.refundAttempts.filter((r) =>
        r.idempotencyKey.includes(disputeThreeId),
      )
      const refusedSuccesses = afterRefusedRecorded.refunds.filter((r) =>
        r.idempotencyKey.includes(disputeThreeId),
      )
      check(
        'both legs were really attempted and really refused, not merely never asked',
        refusedAttempts.length === 2 && refusedSuccesses.length === 0,
        `attempts ${JSON.stringify(refusedAttempts)}, successes ${JSON.stringify(refusedSuccesses)}`,
      )

      // Restored, so nothing after this runs against a stub that refuses refunds.
      const restored = await failRefunds(0)
      check('the refund stub is restored', restored.refunds === 0, JSON.stringify(restored))

      const resolveAgain = await fetch(`${BASE}/api/admin/disputes/${disputeOneId}/resolve`, {
        method: 'POST',
        headers: { ...jsonHeaders, ...cookie(BUYERS.op) },
        body: JSON.stringify({ resolution: 'settled' }),
      })
      check(
        'a second resolution of an already-resolved charged dispute is refused',
        resolveAgain.status === 409,
        `status ${resolveAgain.status}`,
      )
    }
  }
}

hosted?.server.close()

log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
