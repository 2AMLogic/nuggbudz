/**
 * Honeypot buyers: a decoy that populates an empty market and trips on abuse.
 *
 * Two problems share one mechanism, which is why they share one module.
 *
 * **Cold start.** A market with one buyer in it is indistinguishable from a
 * broken app. The first person to open NuggBudz in a new city sees a circle,
 * their own dot and nothing — and the thing they are being asked to believe is
 * precisely that somebody else is nearby.
 *
 * **Abuse has no tripwire.** Nothing in the pool can otherwise tell a buyer from
 * something enumerating the roster or messaging every buddy it is shown. A decoy
 * no legitimate flow would ever mistreat is the cheapest detector there is:
 * anything that behaves toward it in ways a real buyer would not has identified
 * itself.
 *
 * A honeypot is **matchable and can hold a short conversation, and it never
 * completes a pair.** Three rules make that safe rather than dishonest, and each
 * is enforced somewhere else in the tree rather than here:
 *
 * 1. **It can never be charged.** `paymentDisposition` answers `honeypot`
 *    *before* the Stripe secrets are consulted — identity-driven, exactly like
 *    `demo` — so a honeypot on a fully configured production deploy cannot reach
 *    the processor. `codeAtMatchTime('honeypot')` is false, so no pickup code is
 *    ever released either, which makes `handleConfirmPickup` refuse by
 *    construction. No code means no confirmation; no confirmation means no
 *    `matches` row, and — since every route to `disputeMatch` requires one side
 *    to have confirmed — no `disputes` row either. That is the whole safety
 *    argument, and it is structural rather than a matter of timing.
 * 2. **It bows out; it never goes silent.** `worker/pool.ts` tears a honeypot
 *    match down through the *refunding* teardown (`buddy_left`), promptly and
 *    explicitly, and the buyer is returned to the queue. Silence would walk them
 *    into the dispute path, which deliberately does not refund.
 * 3. **It is a fallback, never a competitor.** `shared/matchmaker.ts` considers a
 *    honeypot only when no real counterpart is eligible, so every real pairing
 *    that could have happened still happens. A honeypot preferred over a real
 *    buyer would degrade the starvation-free queue invisibly.
 *
 * **The answer it composes is a fixed table, and that is a decision, not an
 * omission.** Nuggchat's promise on screen is that a message goes to the buddy
 * "and nowhere else — not to the ledger, not to us". Handing a buyer's line to a
 * language model would make that sentence false and would need the sentence
 * changed. `honeypotReply` is therefore pure, synchronous, deterministic and
 * offline: it reads the incoming line in memory to choose one of a handful of
 * canned replies and keeps nothing. Nothing reaches D1, Durable Object storage,
 * KV or any third party, so `pnpm smoke`'s never-stored scan is unaffected and
 * the sentence stays literally true.
 *
 * Runtime-free, like everything in `shared/`.
 */
import { reviewChatText } from './chat'
import type { LatLng } from './geo'
import { offsetMeters } from './geo'
import type { SauceSelection } from './sauces'
import { saucesForMerchant } from './sauces'

/** The marker that makes a honeypot identity legible and greppable, spelled once. */
export const HONEYPOT_USER_ID_PREFIX = 'honeypot:'

/**
 * A user id for a decoy buyer.
 *
 * Prefixed for the same reason `demo:` is — the money gate, the ledger gate and
 * the logs all read it as a plain string by the time it matters, and the prefix
 * is the only thing that survives that far.
 */
export function honeypotUserId(unique: string): string {
  return `${HONEYPOT_USER_ID_PREFIX}${unique}`
}

/**
 * True when this id names a decoy rather than a person.
 *
 * What this guarantees, precisely: an id carrying the prefix *is* a honeypot, so
 * the money gate can refuse it and the ledger can exclude it. It says nothing
 * about the ids it answers `false` for — deciding that an id is genuinely an
 * account is `classifyUserId` in `shared/identity.ts`.
 */
export function isHoneypotUserId(userId: string): boolean {
  return userId.startsWith(HONEYPOT_USER_ID_PREFIX)
}

/**
 * Whether this deployment seats honeypot buyers at all.
 *
 * **One var, one question, one default, and the default is off.** Deliberately
 * *not* conditioned on whether Stripe is configured, whether demo pairing is on,
 * or on anything else a deployment happens to have set: "do decoys run here" is
 * a product decision an operator makes on purpose, and inferring it from an
 * unrelated flag is how `ALLOW_DEMO_PAIRING` came to answer more than one
 * question (#150). A charged production deployment runs honeypots only if
 * somebody typed this var, and what makes that *safe* is the payment gate, never
 * this flag.
 *
 * Same truthy spellings as every other boolean Worker var, and for the same
 * reason: the string `"false"` is truthy in JavaScript.
 */
export function honeypotsEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false
  switch (raw.trim().toLowerCase()) {
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true
    default:
      return false
  }
}

/**
 * How long a honeypot sits in a match before excusing itself.
 *
 * Short, and much shorter than `MATCH_CONFIRM_SECONDS` (ten minutes), so the
 * bow-out always wins the race against the expiry sweep — which would otherwise
 * charge a real buyer a `late_cancel` for a pairing that was never real. Long
 * enough to read the receipt and exchange a line or two, which is the whole
 * point of a decoy that can hold a conversation.
 */
export const HONEYPOT_BOW_OUT_MS = 45_000

/**
 * How long a seeded honeypot stays on the map before it is cleared.
 *
 * A decoy that never leaves is a market that only ever grows, and a buyer who
 * waits half an hour watching the same four dots not move has been told
 * something false by omission.
 */
export const HONEYPOT_TTL_MS = 12 * 60_000

/**
 * How long after meeting a decoy a buyer is ineligible to meet another.
 *
 * The honesty line as code. One phantom buddy is market seeding; a buyer paired
 * with a second and a third phantom in a row is being kept in a queue by
 * something that knows nobody is coming. After a bow-out that buyer waits
 * honestly, and only a real buddy can end that wait.
 */
export const HONEYPOT_COOLDOWN_MS = 30 * 60_000

/** How many decoys a market is stocked to, at most. */
export const HONEYPOT_POOL_SIZE = 3

/**
 * Names a decoy may wear.
 *
 * First names only, as ordinary as the demo-mode placeholder asks for ("e.g.
 * Alex"), because a buddy card that reads like a generated handle tells a buyer
 * nothing true and a suspicious buyer something they should not have to guess
 * at. Data rather than literals at a call site, for the same reason deal prices
 * are.
 */
export const HONEYPOT_NAMES: readonly string[] = [
  'Alex',
  'Sam',
  'Jordan',
  'Riley',
  'Casey',
  'Devon',
  'Micah',
  'Noor',
  'Tara',
  'Quinn',
  'Rowan',
  'Kai',
]

/**
 * A honeypot as the pool remembers one: a queue entry with no socket behind it.
 *
 * Deliberately the same fields a `Candidate` needs and nothing more. There is no
 * connection, no session and no attachment, so everything downstream that reads
 * a socket has to be given this explicitly — which is what keeps a decoy from
 * silently inheriting a real buyer's code path.
 */
export interface HoneypotBuyer {
  /** Stands in for a `connId`, and is what the matcher keys on. */
  id: string
  /** `honeypot:<id>`, so every identity gate downstream can see what this is. */
  userId: string
  name: string
  dealId: string
  lat: number
  lng: number
  /** Epoch millis this decoy "joined", backdated so it reads as a real wait. */
  joinedAt: number
  /** Epoch millis it is cleared off the map. */
  expiresAt: number
  /** Two sauces off the deal's own menu, never ids spelled at a call site. */
  sauces: SauceSelection | null
}

/**
 * A deterministic 32-bit hash of a string — FNV-1a.
 *
 * Deterministic so a placement can be reproduced in a test from its seed alone,
 * which is the only way to assert "inside the radius, never on top of the buyer"
 * without a statistical argument.
 */
function hash32(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/** A small deterministic generator, so one seed yields a whole placement. */
function* stream(seed: string): Generator<number, never, void> {
  let state = hash32(seed) || 1
  for (;;) {
    state ^= (state << 13) >>> 0
    state >>>= 0
    state ^= state >>> 17
    state ^= (state << 5) >>> 0
    state >>>= 0
    yield state / 0x1_0000_0000
  }
}

/**
 * How close to a real buyer a decoy may be placed, as a fraction of the radius.
 *
 * Never on top of them: two dots in the same pixel read as a rendering bug, and
 * a decoy claiming to be across the road is a more specific claim than the one
 * this is entitled to make. Never at the rim either, so a decoy is not the dot
 * that is always about to fall out of the circle.
 */
const PLACEMENT_MIN_FRACTION = 0.2
const PLACEMENT_MAX_FRACTION = 0.85

/**
 * Where one decoy stands, relative to the buyer whose market it is stocking.
 *
 * Placed around the *buyer*, never around the shard: the shard is ~156 km across
 * and the market is two miles, so a decoy seeded from the shard would be a dot
 * nobody could ever reach and a count that lied. Deterministic in `seed`, so the
 * same decoy is in the same place every time it is read back.
 */
export function honeypotPlacement(origin: LatLng, radiusMeters: number, seed: string): LatLng {
  const rng = stream(seed)
  const bearing = rng.next().value * 2 * Math.PI
  const span = PLACEMENT_MAX_FRACTION - PLACEMENT_MIN_FRACTION
  const fraction = PLACEMENT_MIN_FRACTION + rng.next().value * span
  const distance = Math.max(0, radiusMeters) * fraction
  return offsetMeters(origin, Math.cos(bearing) * distance, Math.sin(bearing) * distance)
}

/**
 * The longest a decoy is made to look like it has already been waiting.
 *
 * Backdating is what stops every decoy from reading as "joined the instant you
 * did", which is the tell that would make the whole roster obvious. Bounded well
 * inside the queue's idle window so a decoy never looks like an entry the sweep
 * should already have dropped.
 */
const MAX_BACKDATE_MS = 4 * 60_000

/**
 * Mint one decoy for a market, deterministically from its own id.
 *
 * The caller supplies the id (a `crypto.randomUUID()` in the pool), so this
 * stays pure: everything else about the decoy — name, position, sauces, how long
 * it claims to have been waiting — is a function of that id, and a test can
 * reproduce any of it.
 */
export function mintHoneypot(input: {
  id: string
  dealId: string
  merchant: string
  origin: LatLng
  radiusMeters: number
  now: number
}): HoneypotBuyer {
  const rng = stream(`${input.id}:profile`)
  const name = HONEYPOT_NAMES[Math.floor(rng.next().value * HONEYPOT_NAMES.length)]
  const backdate = Math.floor(rng.next().value * MAX_BACKDATE_MS)
  const at = honeypotPlacement(input.origin, input.radiusMeters, `${input.id}:place`)

  // Off the catalogue for this deal's merchant, never an id written here: a
  // Wendy's sauce on a McDonald's box is not an order anybody could place, and
  // `shared/sauces.ts` is the only list.
  const menu = saucesForMerchant(input.merchant)
  let sauces: SauceSelection | null = null
  if (menu.length >= 2) {
    const first = Math.floor(rng.next().value * menu.length)
    let second = Math.floor(rng.next().value * (menu.length - 1))
    if (second >= first) second += 1
    sauces = [menu[first].id, menu[second].id]
  }

  return {
    id: input.id,
    userId: honeypotUserId(input.id),
    name,
    dealId: input.dealId,
    lat: at.lat,
    lng: at.lng,
    joinedAt: input.now - backdate,
    expiresAt: input.now + HONEYPOT_TTL_MS,
    sauces,
  }
}

/**
 * How many replies a decoy gives before it excuses itself regardless.
 *
 * A conversation that could run forever is a conversation that keeps somebody
 * standing somewhere. The bow-out timer is the real bound; this is the second
 * one, for a buyer who talks fast.
 */
export const HONEYPOT_MAX_REPLIES = 4

/**
 * What a decoy says when a specific question is asked of it.
 *
 * Matched against the *sanitized* line the relay already produced, in memory,
 * and discarded. The patterns are here rather than at the call site for the same
 * reason the names are: one table, greppable, and testable without a runtime.
 */
const KEYED_REPLIES: readonly { readonly match: RegExp; readonly say: string }[] = [
  { match: /\bwhere\b|\bwhich door\b|\bspot\b|\binside\b|\boutside\b/i, say: 'by the front doors' },
  {
    match: /\bwear|\bhoodie\b|\bjacket\b|\bcap\b|look like|\bcolou?r\b/i,
    say: 'black jacket, blue cap',
  },
  { match: /how long|\bmins?\b|\bminutes?\b|\bwhen\b|\beta\b/i, say: 'couple of minutes out' },
  { match: /\bsauce|\bbbq\b|\bketchup\b|\bbuffalo\b/i, say: 'whatever you picked is fine by me' },
]

/**
 * What a decoy says when nothing in particular was asked.
 *
 * Indexed by turn rather than chosen at random, so the same conversation always
 * plays out the same way and a test can enumerate the whole space.
 */
const PACED_REPLIES: readonly string[] = [
  'on my way',
  'almost there',
  'two minutes',
  'nearly with you',
]

/**
 * The line a decoy leaves on.
 *
 * It says the true thing — this handoff is not happening — in the register a
 * person would use, and it is sent *before* the `buddy_left` teardown so the
 * buyer reads an excuse rather than watching a buddy evaporate. A buyer must
 * never be left believing somebody is still on their way.
 */
export const HONEYPOT_FAREWELL = 'sorry — something came up, I can’t make this one. Going to bail.'

/**
 * Compose a decoy's answer to one line of chat, or nothing if it is done talking.
 *
 * Pure, synchronous, offline and deterministic: no model, no clock, no fetch, no
 * randomness. `incoming` is read to pick a branch and is not retained, returned,
 * echoed or written anywhere — which is what keeps the sentence under the chat
 * box ("Nothing here is saved… not to the ledger, not to us") literally true for
 * a buyer talking to a decoy.
 *
 * `turn` is how many replies this decoy has already given. Past
 * `HONEYPOT_MAX_REPLIES` it answers null, and the caller bows the match out.
 */
export function honeypotReply(incoming: string, turn: number): string | null {
  if (!Number.isInteger(turn) || turn < 0) return null
  if (turn >= HONEYPOT_MAX_REPLIES) return null
  for (const keyed of KEYED_REPLIES) {
    if (keyed.match.test(incoming)) return keyed.say
  }
  return PACED_REPLIES[turn % PACED_REPLIES.length]
}

/** Every line a decoy can ever say, so a test can hold the whole set to policy. */
export const HONEYPOT_LINES: readonly string[] = [
  ...KEYED_REPLIES.map((keyed) => keyed.say),
  ...PACED_REPLIES,
  HONEYPOT_FAREWELL,
]

/** Whether a canned line survives the same review a buyer's line is held to. */
export function honeypotLineIsSayable(line: string): boolean {
  const reviewed = reviewChatText(line)
  return reviewed.ok && reviewed.text === line
}

/**
 * What a decoy is allowed to notice.
 *
 * Deliberately two things, and deliberately *behaviours no legitimate client
 * produces* — not "this buyer met a honeypot", which is the ordinary cold-start
 * case and would drown the queue in false positives on day one.
 *
 * - `chat_flood` — the per-connection chat limiter tripped against a decoy. Six
 *   messages in ten seconds is not two strangers arranging to meet.
 * - `code_guess` — a `confirm_pickup` carrying a pickup code for a honeypot
 *   match. A honeypot match never releases one, and the app's own client sends
 *   `code: null` for an orderer, so a non-null code here is a caller trying
 *   values against the handshake.
 *
 * **No chat content is ever part of a signal.** A signal records that something
 * happened and to which match, never what was said — the never-stored promise is
 * not weakened by the tripwire that watches for its abuse.
 */
export const HONEYPOT_SIGNALS = ['chat_flood', 'code_guess'] as const

export type HoneypotSignalKind = (typeof HONEYPOT_SIGNALS)[number]

/** Narrow a signal kind rather than casting one, the same as every other enum here. */
export function parseHoneypotSignal(raw: unknown): HoneypotSignalKind | null {
  return HONEYPOT_SIGNALS.includes(raw as HoneypotSignalKind) ? (raw as HoneypotSignalKind) : null
}
