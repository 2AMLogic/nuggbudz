-- Disputed pickups: one buddy confirmed the handoff and the other never did.
--
-- A table of its own rather than a status column on `matches`, because
-- `matches` answers exactly one question — "which splits settled?" — and every
-- revenue figure in this repo is a `WHERE settled_at IS NOT NULL` over it
-- (`/api/stats`, `scripts/deck-ledger.ts`). Widening it to hold splits that did
-- *not* settle would make every one of those queries a filter nobody can forget
-- safely. A dispute is not a weaker split; it is an item of work for a human.
CREATE TABLE IF NOT EXISTS disputes (
  match_id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  -- The shard the match lived in, which is also the name of the NuggPool
  -- Durable Object still holding its money. A resolution that has to refund
  -- has no other way to find the instance.
  cell TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  disputed_at INTEGER NOT NULL,
  -- Why the handshake died: the second side ran out of time, or walked away.
  reason TEXT NOT NULL CHECK (reason IN ('timeout', 'buddy_left')),
  -- The side that did confirm, and when. Nullable only defensively: every
  -- dispute reachable today has exactly one confirmation on it, which is what
  -- distinguishes a dispute from an unconfirmed match (those are cancelled).
  confirmed_role TEXT CHECK (confirmed_role IN ('orderer', 'receiver')),
  confirmed_at INTEGER,
  -- Who the two buddies were. The account ids are recorded here and not in
  -- `match_buyers` on purpose: the settled ledger is a revenue report and needs
  -- no names attached to money, while a dispute is a thing a human has to act
  -- on, and "refund the receiver" is meaningless without knowing which account
  -- that is. Deliberately no foreign key to `users`, for the same reason
  -- `match_buyers` has none: this row is evidence about what happened, and it
  -- must not become unwritable because of the state of another table.
  orderer_user_id TEXT NOT NULL,
  orderer_name TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  receiver_name TEXT NOT NULL,
  -- Integer cents collected from both buyers and not handed back, as of the
  -- moment of the dispute. A dispute is the one teardown that deliberately does
  -- NOT refund, so this is the money a human is being asked to decide about.
  held_cents INTEGER NOT NULL,
  -- Everything below is written once, by an operator, through
  -- `POST /api/admin/disputes/:matchId/resolve`.
  resolved_at INTEGER,
  -- The operator's `users.id`. A real account rather than a shared token, so a
  -- resolution that moved money names somebody.
  resolved_by TEXT,
  resolution TEXT CHECK (
    resolution IN ('settled', 'voided', 'refund_orderer', 'refund_receiver')
  ),
  -- What Stripe actually gave back, in integer cents. NULL until the refund
  -- call has been answered for at all — which is not the same as 0, "the call
  -- came back and returned nothing". A row resolved with this still NULL is a
  -- resolution whose money did not move, and it says so rather than claiming a
  -- refund that never happened.
  refunded_cents INTEGER,
  note TEXT
);

-- The operator's queue: open disputes, oldest first. `resolved_at` leads so the
-- open set is a prefix scan rather than a table scan that filters.
CREATE INDEX IF NOT EXISTS idx_disputes_open ON disputes (resolved_at, disputed_at DESC);
