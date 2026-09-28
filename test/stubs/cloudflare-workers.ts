/**
 * The one import that stops `worker/pool.ts` loading in plain Node.
 *
 * `vitest.config.ts` aliases `cloudflare:workers` here so the Durable Object's
 * *own* code can be driven by a unit test. It is deliberately the whole stub
 * and nothing more: a base class that keeps the two constructor arguments where
 * the real one does. Everything else `NuggPool` touches — storage, sockets, D1 —
 * is supplied by the test as an ordinary fake, so nothing here fakes behaviour
 * that a test could then assert about.
 *
 * This is not a replacement for `pnpm smoke` or `pnpm test:e2e`, which run the
 * real runtime. It exists for the class of defect those lanes cannot see
 * cheaply: bookkeeping *inside* one alarm tick, where the wrong answer is a
 * silent extra write rather than a broken handshake (#87).
 */
export class DurableObject<E = unknown> {
  constructor(
    protected ctx: DurableObjectState,
    protected env: E,
  ) {}
}
