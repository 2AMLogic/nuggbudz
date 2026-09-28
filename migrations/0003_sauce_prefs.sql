-- A signed-in buyer's sauce pair, so it survives a sign-out rather than living
-- only in the browser that picked it. Demo buyers have no account by design and
-- keep theirs in localStorage instead (`src/hooks/useSauces.ts`).
--
-- A table of its own rather than columns on `users`: identity is what `users`
-- is for, and `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` to make it
-- safe to re-apply.
CREATE TABLE IF NOT EXISTS user_sauces (
  user_id TEXT PRIMARY KEY,
  -- Two ids from `shared/sauces.ts`, stored in catalogue order by
  -- `parseSauceSelection` so one choice has one spelling. Deliberately not a
  -- foreign key: the catalogue is code, not a table, and a sauce leaving the
  -- menu must not delete a buyer's preference — it is re-validated on read.
  first_sauce_id TEXT NOT NULL,
  second_sauce_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
