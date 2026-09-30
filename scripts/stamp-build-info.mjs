#!/usr/bin/env node
/** Runs after `vite build`: writes dist/client/build-info.json. See build-info.mjs. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_INFO_FILE, detectPublishableKey } from './build-info.mjs'

const CLIENT_DIR = process.env.CLIENT_DIST_DIR ?? 'dist/client'
const assets = join(CLIENT_DIR, 'assets')
const sources = readdirSync(assets)
  .filter((f) => f.endsWith('.js'))
  .map((f) => readFileSync(join(assets, f), 'utf8'))

const stripePublishableKey = detectPublishableKey(sources)
writeFileSync(join(CLIENT_DIR, BUILD_INFO_FILE), `${JSON.stringify({ stripePublishableKey })}\n`)
console.log(`Build info: stripePublishableKey=${stripePublishableKey}`)
