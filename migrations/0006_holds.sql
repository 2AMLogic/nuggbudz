-- Money a dead match is still holding, from a teardown that was not a dispute.
--
-- A third table rather than a status column, for the same reason `disputes` is
-- a second one: `matches` answers "which splits settled?" and every revenue
-- figure in this repo is a `WHERE settled_at IS NOT NULL` over it. And a
-- **parallel** table to `disputes` rather than more rows in it, because the two
-- are different questions. A dispute is a decision somebody owes an answer to —
-- one buddy confirmed, the other went silent, and the hold is deliberate. A row
-- here is a *failure*: every non-dispute teardown asks Stripe for a refund, and
-- this is the money Stripe would not give back. Nobody decided it, so there is
-- nothing here to resolve; there is only something to retry.
--
-- Before this table that money existed in exactly one place — the
-- `PaymentTombstone` in the one NuggPool Durable Object that owned the match —
-- and there is no registry of live cells to fan out to, so no operator could
-- enumerate it at all.
CREATE TABLE IF NOT EXISTS holds (
  match_id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  -- The shard the match lived in, which is also the name of the NuggPool
  -- Durable Object still holding the charges. A retry has no other way to find
  -- the instance that can issue the refund.
  cell TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  -- When the match record was deleted and the money became a tombstone.
  retired_at INTEGER NOT NULL,
  -- How the match died. Every value is a non-dispute teardown by construction:
  -- a settled split owes nothing back and a dispute holds its money on purpose
  -- and is recorded in `disputes`. See `shared/holds.ts`.
  reason TEXT NOT NULL CHECK (
    reason IN ('match_expired', 'payment_unavailable', 'buddy_left', 'payment_failed')
  ),
  -- Who the two buddies were, recorded here and not in `match_buyers` for the
  -- same reason a dispute records them: the settled ledger is a revenue report
  -- and needs no names attached to money, while this is a thing a human has to
  -- chase. Deliberately no foreign key to `users` — this row is evidence about
  -- what happened, and must not become unwritable because of another table.
  orderer_user_id TEXT NOT NULL,
  orderer_name TEXT NOT NULL,
  receiver_user_id TEXT NOT NULL,
  receiver_name TEXT NOT NULL,
  -- Integer cents collected from both buyers and NOT handed back, as of the
  -- moment of the retirement, and updated to the current figure by every retry
  -- that Stripe answers. A row is written only when this is greater than zero:
  -- a teardown whose refund fully succeeded owes nobody anything and must not
  -- appear in an operator's queue.
  held_cents INTEGER NOT NULL,
  -- What retries have actually recovered, in integer cents. NULL until a retry
  -- has been answered for at all — which is not the same as 0, "we asked and
  -- Stripe returned nothing". Same rule as `disputes.refunded_cents`: never
  -- stamped before the Stripe call returns.
  refunded_cents INTEGER,
  -- When a retry was last attempted, so an operator can tell a hold nobody has
  -- touched from one that has been refused repeatedly.
  retried_at INTEGER,
  -- Set when `held_cents` reaches 0 and the money is finally answered for.
  -- Until then the hold is open. A hold a late Stripe webhook cleared inside
  -- the Durable Object still reads as open here until somebody retries it; that
  -- retry is a no-op that closes the row, which is the self-healing direction.
  released_at INTEGER
);

-- The operator's queue: open holds, oldest first. `released_at` leads so the
-- open set is a prefix scan rather than a table scan that filters — the same
-- shape `idx_disputes_open` has, for the same reason.
CREATE INDEX IF NOT EXISTS idx_holds_open ON holds (released_at, retired_at DESC);
