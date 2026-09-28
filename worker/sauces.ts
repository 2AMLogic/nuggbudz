import { Hono } from 'hono'
import { parseSauceSelection } from '../shared/sauces'
import { sessionFromRequest } from './auth'
import type { Env } from './env'

/**
 * A signed-in buyer's sauce pair, kept in D1 so it outlives the browser that
 * chose it — the acceptance criterion is that it survives a sign-out and a
 * sign-in, which `localStorage` cannot do.
 *
 * A demo buyer has no account on purpose (`shared/demo.ts`), so there is nothing
 * here for them to own: their preference lives in `localStorage`, exactly as
 * their display name does. Both of those paths reach the same validator, which is
 * the point — the catalogue decides what a selection may be, not the caller.
 */
export const sauceRoutes = new Hono<{ Bindings: Env }>()

interface StoredSauces {
  first_sauce_id: string
  second_sauce_id: string
}

sauceRoutes.get('/me/sauces', async (c) => {
  const active = await sessionFromRequest(c.env, c.req.raw)
  if (active === null) return c.json({ error: 'sign in required' }, 401)

  const row = await c.env.DB.prepare(
    'SELECT first_sauce_id, second_sauce_id FROM user_sauces WHERE user_id = ?1',
  )
    .bind(active.session.userId)
    .first<StoredSauces>()

  // Re-validated on the way out, not just on the way in: a row written while a
  // chain was still offered must not be handed back as a current choice once that
  // chain is gated, and a hand-edited row is no more trustworthy than a socket.
  const sauces =
    row === null ? null : parseSauceSelection([row.first_sauce_id, row.second_sauce_id])
  return c.json({ sauces })
})

sauceRoutes.put('/me/sauces', async (c) => {
  const active = await sessionFromRequest(c.env, c.req.raw)
  if (active === null) return c.json({ error: 'sign in required' }, 401)

  const body: unknown = await c.req.json().catch(() => null)
  const raw =
    typeof body === 'object' && body !== null ? (body as { sauces?: unknown }).sauces : undefined
  const sauces = parseSauceSelection(raw)
  // An unknown id is refused, and the answer says what is allowed rather than
  // repeating what arrived — an unvalidated string is not something to echo.
  if (sauces === null) {
    return c.json({ error: 'sauces must be two ids from the current menu' }, 400)
  }

  await c.env.DB.prepare(
    `INSERT INTO user_sauces (user_id, first_sauce_id, second_sauce_id, updated_at)
     VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (user_id) DO UPDATE SET
       first_sauce_id = excluded.first_sauce_id,
       second_sauce_id = excluded.second_sauce_id,
       updated_at = excluded.updated_at`,
  )
    .bind(active.session.userId, sauces[0], sauces[1], Date.now())
    .run()

  // The validated, canonically ordered pair — so a client that sent them the
  // other way round agrees with the server about what it stored.
  return c.json({ sauces })
})
