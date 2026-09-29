-- What a decoy buyer saw somebody do to it.
--
-- A fourth table rather than a column anywhere, for the same reason `disputes`
-- and `holds` are separate from `matches`: this answers a different question
-- from all three of them. `matches` is revenue, `disputes` is a decision
-- somebody owes an answer to, `holds` is a refund the processor refused — and
-- this is evidence about a *caller*, not about money. A honeypot match never
-- produces a row in any of the other three, by construction, so there was
-- nowhere for this to live.
--
-- **No chat content, ever.** A signal records that something happened, which
-- match it happened in and which kind it was. It never records what was said.
-- Nuggchat is relayed and never stored, and the tripwire that watches for abuse
-- of that channel must not be the thing that quietly starts storing it —
-- `pnpm smoke` scans every table here for text that was just exchanged, and
-- this table has to pass that scan like every other.
--
-- What a human does with it: `GET /api/admin/honeypot` is the queue, behind the
-- same `OPERATOR_USER_IDS` allowlist as disputes and holds. There is nothing to
-- resolve and no action endpoint, deliberately — a row is an observation, not a
-- case. It exists to answer "is anything hammering this market, and since
-- when", which is the question that precedes blocking anybody, and the absence
-- of rows is as much of an answer as their presence.
CREATE TABLE IF NOT EXISTS honeypot_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The match the decoy was in. Not a foreign key to anything: a honeypot match
  -- never reaches `matches`, and this row has to outlive the Durable Object
  -- record that is the only other place it existed.
  match_id TEXT NOT NULL,
  -- The shard, so an operator can tell one market's noise from another's.
  cell TEXT NOT NULL,
  -- Which decoy. Always `honeypot:<uuid>`, and useful only for grouping.
  honeypot_user_id TEXT NOT NULL,
  -- Who did it. A real `users.id`, or a `demo:` identity on a demo deployment.
  -- Deliberately no foreign key to `users`: this row is evidence about what
  -- happened and must not become unwritable because of another table.
  actor_user_id TEXT NOT NULL,
  -- One of `shared/honeypot.ts`'s `HONEYPOT_SIGNALS`. Both are behaviours no
  -- legitimate client produces — see the comment on that list for why "was
  -- matched with a decoy" is deliberately not one of them.
  kind TEXT NOT NULL CHECK (kind IN ('chat_flood', 'code_guess')),
  observed_at INTEGER NOT NULL
);

-- The operator's queue: newest first, which is the only order the question
-- ("is anything hammering us right now") is ever asked in.
CREATE INDEX IF NOT EXISTS idx_honeypot_signals_recent
  ON honeypot_signals (observed_at DESC);

-- And the follow-up question, once a row has been seen: what else has this
-- caller done.
CREATE INDEX IF NOT EXISTS idx_honeypot_signals_actor
  ON honeypot_signals (actor_user_id, observed_at DESC);
