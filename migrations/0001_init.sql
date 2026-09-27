-- Settled splits, written once a match reaches pickup. The Durable Object owns
-- live matching state; D1 is the durable ledger the platform reports on.
CREATE TABLE IF NOT EXISTS matches (
  match_id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL,
  cell TEXT NOT NULL,
  party_size INTEGER NOT NULL,
  total_collected_cents INTEGER NOT NULL,
  cogs_cents INTEGER NOT NULL,
  platform_fee_cents INTEGER NOT NULL,
  distance_meters REAL NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_matches_created_at ON matches (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_cell ON matches (cell, created_at DESC);

-- One row per buyer per match.
CREATE TABLE IF NOT EXISTS match_buyers (
  match_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('orderer', 'receiver')),
  display_name TEXT NOT NULL,
  pay_cents INTEGER NOT NULL,
  solo_baseline_cents INTEGER NOT NULL,
  pieces_owed INTEGER NOT NULL,
  PRIMARY KEY (match_id, role),
  FOREIGN KEY (match_id) REFERENCES matches (match_id) ON DELETE CASCADE
);
