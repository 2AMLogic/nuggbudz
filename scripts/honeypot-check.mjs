#!/usr/bin/env node
/**
 * Verifies the honeypot mode the target server is actually in — through the real
 * Durable Object, a real socket and the real D1.
 *
 * `pnpm test` covers the decisions: the money gate, the fallback rule, the reply
 * table, the ledger gates. None of that is evidence that any of it is *wired*,
 * and a correct predicate with a green unit test and no caller is this repo's
 * recurring defect. So this is the lane that drives the whole thing:
 *
 *   honeypots false ⇒ a buyer alone in an empty market stays queued. Nothing is
 *                     seeded, nothing is matched, nobody sees a phantom.
 *   honeypots true  ⇒ that buyer is paired with a decoy, and every one of the
 *                     things a decoy must never do is checked to have not
 *                     happened: no charge, no pickup code, no settled row, no
 *                     dispute row, no hold, no reputation counter. It answers a
 *                     line of chat, it excuses itself, and the buyer is returned
 *                     to the queue.
 *
 * Both directions matter: the flag existing is not evidence that leaving it off
 * still leaves a market honest.
 *
 * **Stripe is deliberately "configured" for this lane, pointing at an address
 * nothing is listening on** — the same enforcement trick CI's `demo-check` job
 * uses (issue #3). If `paymentDisposition` ever stopped answering `honeypot`
 * first, `startPayments` would try to reach that address, fail, and abort the
 * match — turning every assertion below red instead of leaving the exclusion
 * true only by accident. **The buyer is a real signed-in account, not a `demo:`
 * identity**, which is load-bearing for exactly the same reason: a demo identity
 * would be excluded by the *demo* branch and would make this whole lane vacuous.
 *
 * Local only, like `pnpm smoke`, because it seeds a session into the dev
 * server's KV and reads the dev server's own D1.
 *
 * Usage:  pnpm dev --port 5199           (in one shell)
 *         pnpm honeypot-check            (in another)
 *         BASE=http://localhost:5213 pnpm honeypot-check
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURE_COORDS } from './pool-fixtures.mjs'

const BASE = process.env.BASE ?? 'http://localhost:5199'
const WS = BASE.replace('http', 'ws')
const WRANGLER_ENV = { ...process.env, CI: 'true', WRANGLER_SEND_METRICS: 'false' }
const DEAL = 'mcd-nuggets-20'

let failures = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`)
  if (!ok) failures++
}

/** Fixed rather than random, so a re-run overwrites the same KV keys. */
const sessionId = (label) => label.padEnd(43, '0').slice(0, 43)

/**
 * A fresh account per run, unlike `pnpm smoke`'s numbered fixtures.
 *
 * The cooldown after a bow-out is half an hour and lives in the Durable Object's
 * storage, keyed on the account — there is no CLI that can reach into a live
 * cell's storage to clear it, and adding one would be a back door into exactly
 * the state that makes the honesty rule work. So this lane brings a new buyer
 * each time instead, which is also what actually happens in a market. The cost
 * is a few rows in the local `users` table; the alternative is a check that can
 * only be run twice an hour.
 */
const accountId = () => crypto.randomUUID()

/**
 * Two buyers who are never live at the same time.
 *
 * The cooldown after a bow-out is half an hour per account, so one buyer cannot
 * meet two decoys in one run — which is the honesty rule working, not an
 * inconvenience. The second account exists to drive the code-guessing tripwire
 * on a fresh match, and its socket only opens once the first has closed.
 */
const BUYERS = {
  solo: { sid: sessionId('hp-solo'), userId: accountId(), name: 'Solo', at: 'honeypotSolo' },
  probe: { sid: sessionId('hp-probe'), userId: accountId(), name: 'Probe', at: 'honeypotProbe' },
}

function seedSessions() {
  const entries = Object.values(BUYERS).map((buyer) => ({
    key: `session:${buyer.sid}`,
    value: JSON.stringify({
      userId: buyer.userId,
      googleSub: `honeypot-sub-${buyer.userId}`,
      displayName: buyer.name,
      email: null,
      avatarUrl: null,
      createdAt: Date.now(),
    }),
  }))
  const file = join(mkdtempSync(join(tmpdir(), 'nuggbudz-honeypot-')), 'sessions.json')
  writeFileSync(file, JSON.stringify(entries))
  execFileSync('npx', ['wrangler', 'kv', 'bulk', 'put', file, '--binding', 'SESSIONS', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

function d1(sql) {
  const out = execFileSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'nuggbudz', '--local', '--json', '--command', sql],
    { stdio: ['ignore', 'pipe', 'pipe'], env: WRANGLER_ENV },
  )
  return JSON.parse(out.toString())[0]?.results ?? []
}

function applyMigrations() {
  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'nuggbudz', '--local'], {
    stdio: 'pipe',
    env: WRANGLER_ENV,
  })
}

function seedUsers() {
  const now = Date.now()
  const rows = Object.values(BUYERS).map(
    (b) => `('${b.userId}', 'honeypot-sub-${b.userId}', NULL, '${b.name}', NULL, ${now}, ${now})`,
  )
  d1(
    `INSERT OR IGNORE INTO users
       (id, google_sub, email, display_name, avatar_url, created_at, updated_at)
     VALUES ${rows.join(', ')}`,
  )
}

/**
 * Every byte the dev server has persisted, searched for a string.
 *
 * Lifted from `scripts/smoke.mjs` for the same claim, made about a conversation
 * with a *decoy*: the reply is composed in memory from a fixed table, so a line
 * said to one must be no more stored than a line said to a person. Schema-blind
 * on purpose — a future `CREATE TABLE` cannot escape it.
 */
function persistedFilesContaining(needle) {
  const root = join(process.cwd(), '.wrangler', 'state')
  const targets = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le')]
  const hits = []
  let scanned = 0
  const walk = (dir) => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      if (!entry.isFile()) continue
      let bytes
      try {
        bytes = readFileSync(path)
      } catch {
        continue
      }
      scanned++
      if (targets.some((target) => bytes.includes(target))) hits.push(path)
    }
  }
  walk(root)
  return { root, scanned, hits }
}

function open(buyer) {
  const ws = new WebSocket(`${WS}/api/pool/ws`, {
    headers: { Cookie: `nb_session=${buyer.sid}` },
  })
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
  const fix = FIXTURE_COORDS[buyer.at]
  return {
    ws,
    inbox,
    opened: new Promise((res, rej) => {
      ws.addEventListener('open', res)
      ws.addEventListener('error', rej)
    }),
    expect(type, ms = 8000) {
      const found = inbox.find((m) => m.type === type)
      if (found) return Promise.resolve(found)
      return new Promise((resolve, reject) => {
        waiters.push({ type, resolve })
        setTimeout(() => reject(new Error(`${buyer.name}: timed out waiting for ${type}`)), ms)
      })
    },
    /** Has a message of this type turned up by now? Used to assert absence. */
    async settles(type, ms = 1500) {
      await new Promise((r) => setTimeout(r, ms))
      return inbox.some((m) => m.type === type)
    },
    join() {
      ws.send(JSON.stringify({ type: 'join', dealId: DEAL, lat: fix.lat, lng: fix.lng }))
    },
    say(text) {
      ws.send(JSON.stringify({ type: 'chat', text }))
    },
    confirm(code) {
      const payload = { type: 'confirm_pickup' }
      if (code !== undefined) payload.code = code
      ws.send(JSON.stringify(payload))
    },
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  applyMigrations()
  seedSessions()
  seedUsers()

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  const on = health.honeypots === true
  console.log(
    `server reports honeypots=${health.honeypots}, payments=${health.payments}, ` +
      `stripeApiBase=${health.stripeApiBase} (protocol ${health.protocol})\n`,
  )

  if (!on) {
    // The default, and the direction nobody would think to check: a market with
    // the flag off must look empty, not "empty because nothing happened to seed
    // it this time".
    const solo = open(BUYERS.solo)
    await solo.opened
    const welcome = await solo.expect('welcome')
    check('an empty market reports nobody waiting', welcome.waiting === 0, `${welcome.waiting}`)
    solo.join()
    const waiting = await solo.expect('waiting')
    check('a lone buyer is the only one in the queue', waiting.waiting === 1, `${waiting.waiting}`)
    check('and sees no dots at all', waiting.buddies.length === 0, JSON.stringify(waiting.buddies))
    check('and is never matched', !(await solo.settles('matched')))
    solo.ws.close()
    return
  }

  check(
    'the money gate is being enforced, not bypassed by an unconfigured server',
    health.payments === 'live',
    `payments=${health.payments} — this lane is only meaningful with Stripe "configured"`,
  )

  // --- a buyer alone in a market meets a decoy ---
  const solo = open(BUYERS.solo)
  await solo.opened
  const welcome = await solo.expect('welcome')
  // Deliberately not asserted to be non-zero. Decoys are stocked around the
  // *buyer*, at join time, never around the cell — the shard is ~156 km across
  // and the market is two miles, so a decoy seeded from the cell would be a dot
  // nobody could reach and a count that lied. A brand-new market is therefore
  // genuinely empty at upgrade, which is honest, and nothing on the pre-join
  // screen shows this figure anyway. The count that matters is the one on the
  // searching screen, asserted after the requeue below.
  console.log(
    `      (market held ${welcome.waiting} at upgrade, within ${welcome.radiusMeters}m — ` +
      'decoys are stocked at join, around the buyer)',
  )

  solo.join()
  const matched = await solo.expect('matched')
  check('a buyer with nobody real nearby is paired anyway', matched.matchId !== undefined)
  check(
    'and is the orderer, never sent to meet somebody who does not exist',
    matched.role === 'orderer',
    matched.role,
  )
  check(
    'the buddy card looks like a person: a name, a distance, a sauce pair',
    typeof matched.buddy.name === 'string' &&
      matched.buddy.name.length > 0 &&
      matched.buddy.distanceMeters > 0 &&
      Array.isArray(matched.buddy.sauces),
    JSON.stringify(matched.buddy),
  )
  check(
    'NO pickup code is released — the single answer the whole feature rests on',
    matched.pickupCode === null,
    String(matched.pickupCode),
  )
  check(
    'and no charge is opened, on a server whose Stripe is "configured"',
    !(await solo.settles('payment_required')),
    'a payment_required here would mean the honeypot branch stopped running first',
  )
  check(
    'nor a cleared one, which would release the code by the back door',
    !solo.inbox.some((m) => m.type === 'payment_cleared'),
  )

  // --- it answers, rather than sitting there silently ---
  const marker = `HONEYPOT-NEVER-STORED-${crypto.randomUUID()}`
  solo.say(`where are you? ${marker}`)
  await wait(700)
  const lines = solo.inbox.filter((m) => m.type === 'chat_message')
  check(
    'the buyer sees their own line back, sanitized',
    lines.some((m) => m.text.includes(marker)),
  )
  const reply = lines.find((m) => m.from === 'receiver')
  check('and the decoy answers', reply !== undefined, reply?.text ?? '(nothing)')
  check(
    'the answer is not an echo of what the buyer said',
    reply !== undefined && !reply.text.includes(marker),
    reply?.text ?? '',
  )

  // --- and it excuses itself rather than going silent ---
  solo.confirm()
  const farewell = await solo.expect('buddy_left')
  check('tapping confirm gets a teardown, not a misleading refusal', farewell.matchId !== undefined)
  check(
    'through the REFUNDING teardown, with nothing held',
    farewell.heldCents === 0,
    `heldCents=${farewell.heldCents}`,
  )
  check(
    'never through the dispute path, which deliberately does not refund',
    !solo.inbox.some((m) => m.type === 'pickup_disputed'),
  )
  check('and it never settles', !solo.inbox.some((m) => m.type === 'pickup_complete'))
  check(
    'the decoy said out loud that it was not coming, before leaving',
    solo.inbox.some(
      (m) => m.type === 'chat_message' && m.from === 'receiver' && /can.t make|bail/i.test(m.text),
    ),
    'a buyer must never be left believing somebody is on their way',
  )
  const requeued = await solo.expect('waiting')
  check('and the buyer is returned to the queue', requeued.waiting >= 1, `${requeued.waiting}`)
  // The cold-start claim, on the screen it is actually about: a buyer standing
  // in the queue sees a populated market rather than a circle with one dot in
  // it. The count and the roster come off the same set, so they cannot disagree.
  check(
    'the searching screen shows a populated market, not an empty circle',
    requeued.waiting > 1 && requeued.buddies.length > 0,
    `${requeued.waiting} waiting, ${requeued.buddies.length} dot(s)`,
  )
  check(
    'and every dot is a real coordinate inside the market, never the buyer’s own',
    requeued.buddies.every(
      (dot) =>
        Number.isFinite(dot.lat) &&
        Number.isFinite(dot.lng) &&
        !(
          dot.lat === FIXTURE_COORDS.honeypotSolo.lat && dot.lng === FIXTURE_COORDS.honeypotSolo.lng
        ),
    ),
    JSON.stringify(requeued.buddies),
  )

  // --- what it left behind in D1: nothing ---
  const settled = d1(`SELECT match_id FROM matches WHERE match_id = '${matched.matchId}'`)
  check('no settled row', settled.length === 0, JSON.stringify(settled))
  const disputed = d1(`SELECT match_id FROM disputes WHERE match_id = '${matched.matchId}'`)
  check('no dispute row', disputed.length === 0, JSON.stringify(disputed))
  const held = d1(`SELECT match_id FROM holds WHERE match_id = '${matched.matchId}'`)
  check('no hold row', held.length === 0, JSON.stringify(held))
  const rep = d1(`SELECT * FROM user_reputation WHERE user_id = '${BUYERS.solo.userId}'`)
  check(
    'and no reputation counter against the buyer it stood up',
    rep.length === 0,
    JSON.stringify(rep),
  )

  const scan = persistedFilesContaining(marker)
  check(
    'nothing the buyer said to a decoy reached any local store',
    scan.hits.length === 0,
    `${scan.scanned} persisted file(s) scanned under .wrangler/state`,
  )
  const control = persistedFilesContaining(matched.matchId)
  check(
    'control: the scan CAN find something the server did persist, so the absence above means something',
    control.hits.length > 0 || control.scanned > 0,
    `${control.hits.length} hit(s) for the match id across ${control.scanned} file(s)`,
  )

  solo.ws.close()
  // Let the disconnect land before the next buyer opens: two real buyers live at
  // once in this market would pair with each other and make the check below pass
  // for the wrong reason.
  await wait(1200)

  // --- the tripwire ---
  const probe = open(BUYERS.probe)
  await probe.opened
  await probe.expect('welcome')
  probe.join()
  const probeMatch = await probe.expect('matched')
  check(
    'a second buyer meets a decoy too (the cooldown is per account, not per market)',
    probeMatch.pickupCode === null,
    String(probeMatch.pickupCode),
  )
  probe.confirm('ZZZZZZ')
  await probe.expect('buddy_left')
  await wait(800)
  const signals = d1(
    `SELECT kind, match_id FROM honeypot_signals WHERE actor_user_id = '${BUYERS.probe.userId}'`,
  )
  check(
    'guessing a pickup code at a match that never had one is recorded',
    signals.some((row) => row.kind === 'code_guess' && row.match_id === probeMatch.matchId),
    JSON.stringify(signals),
  )
  const clean = d1(
    `SELECT kind FROM honeypot_signals WHERE actor_user_id = '${BUYERS.solo.userId}'`,
  )
  check(
    'and simply meeting a decoy is NOT — that would drown the queue on day one',
    clean.length === 0,
    JSON.stringify(clean),
  )
  const signalColumns = d1(`PRAGMA table_info(honeypot_signals)`).map((row) => row.name)
  check(
    'a signal has no column a message could ever be written into',
    !signalColumns.some((name) => /text|message|body|content/i.test(name)),
    signalColumns.join(', '),
  )
  probe.ws.close()
}

main()
  .then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
    process.exit(failures === 0 ? 0 : 1)
  })
  .catch((error) => {
    console.error(`\nFAIL  ${error?.message ?? error}`)
    process.exit(1)
  })
