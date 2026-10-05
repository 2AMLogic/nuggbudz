import { describe, expect, it } from 'vitest'
import { experimental_readRawConfig } from 'wrangler'
import packageSource from '../package.json?raw'

/**
 * The public hostnames are deploy configuration, not dashboard state (#78). Until
 * this landed, `nuggbudz.com` and `www.nuggbudz.com` were attached to the Worker
 * only on the Cloudflare account, so a deploy from the repository could not
 * reproduce them and nothing here would notice the attachment going away.
 *
 * The config is read through Wrangler's own JSONC reader rather than a regex over
 * the text, so a commented-out declaration reads as absent exactly as it does to
 * `wrangler deploy` — the case a pattern match over the raw text gets wrong.
 */

const CONFIG_PATH = new URL('../wrangler.jsonc', import.meta.url).pathname

const CUSTOM_DOMAINS = ['nuggbudz.com', 'www.nuggbudz.com']

describe('the checked-in wrangler.jsonc', () => {
  const config = experimental_readRawConfig({ config: CONFIG_PATH }).rawConfig

  it('declares exactly the two custom domains, each as a Custom Domain', () => {
    expect(config.routes).toEqual(
      CUSTOM_DOMAINS.map((pattern) => ({ pattern, custom_domain: true })),
    )
  })

  it('keeps the workers.dev fallback on explicitly, since routes turn its default off', () => {
    expect(config.workers_dev).toBe(true)
  })

  it('has no single `route` or per-environment block that could deploy something else', () => {
    expect(config.route).toBeUndefined()
    expect(config.env).toBeUndefined()
  })
})

describe('both deploy scripts ship that file', () => {
  const scripts: Record<string, string> = JSON.parse(packageSource).scripts

  // `-c`/`--config` would deploy a different file, `-e`/`--env` a different block
  // of this one, and `--route(s)` replaces the declared routes outright. `--var`
  // is the one flag `deploy:demo` needs, and it touches none of them.
  const wranglerDeployArgs = (script: string): string[] => {
    const step = script
      .split('&&')
      .map((part) => part.trim())
      .find((part) => part.startsWith('wrangler deploy'))
    if (step === undefined) throw new Error(`no \`wrangler deploy\` step in: ${script}`)
    return step.slice('wrangler deploy'.length).trim().split(/\s+/).filter(Boolean)
  }

  for (const name of ['deploy', 'deploy:demo']) {
    it(`${name} passes wrangler deploy nothing but --var`, () => {
      const args = wranglerDeployArgs(scripts[name])
      for (let i = 0; i < args.length; i += 2) {
        expect(args[i]).toBe('--var')
        expect(args[i + 1]).toMatch(/^[A-Z_]+:\S+$/)
      }
    })
  }
})
