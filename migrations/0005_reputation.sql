-- How a buyer's past handoffs went. One row per account, created on the first
-- event rather than at sign-up, so a buyer who has never been matched has no row
-- and reads as unrated.
--
-- A table of its own rather than columns on `users`, for the same two reasons
-- `user_sauces` is one: identity is what `users` is for, and `ALTER TABLE ...
-- ADD COLUMN` has no `IF NOT EXISTS` to make it safe to re-apply. It is also the
-- only table here that is written on a hot path — every completed and every
-- missed handoff touches it — and identity is written once per sign-in.
CREATE TABLE IF NOT EXISTS user_reputation (
  user_id TEXT PRIMARY KEY,
  -- Handoffs both sides confirmed. The only counter that can go up on a split
  -- that actually settled.
  splits_completed INTEGER NOT NULL DEFAULT 0,
  -- The other side confirmed the handoff and this buyer never did. A dispute,
  -- not a settlement: see `disputeMatch` in `worker/pool.ts`.
  no_shows INTEGER NOT NULL DEFAULT 0,
  -- Walked away after being matched, before anyone confirmed anything.
  late_cancels INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  -- Demo pairings mint a throwaway `demo:` identity with no `users` row, so this
  -- key is also what keeps a stage demo out of the counters — the same job the
  -- ledger's `isDemoMatch` gate does for money.
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
