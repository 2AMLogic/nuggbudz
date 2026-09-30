/**
 * Run `scripts/main-red-alert.mjs`'s forge half against a stub forge.
 *
 * The pure half of that script composes text, which is easy to assert and proves
 * nothing about whether an alert is ever filed. This hosts a throwaway HTTP
 * server, points the script at it through `GITHUB_API_URL` (the same variable
 * Actions itself sets), and records every request — so "files one issue the first
 * time, comments on that same issue the second" is checked against the calls that
 * actually go out. A notifier with a green unit test and a broken request is this
 * repo's recurring defect shape.
 *
 * A `.mjs` module, imported by `test/main-red-alert.test.ts`, because this is the
 * only part that needs `node:` — the same division
 * `scripts/protocol-merge-probe.mjs` follows.
 */
import { createServer } from 'node:http'

import { fileAlert } from './main-red-alert.mjs'

/** The Actions environment the script reads, with nothing real in it. */
const STUB_ENV = {
  GITHUB_TOKEN: 'not-a-real-token',
  GITHUB_REPOSITORY: '2AMLogic/nuggbudz',
  GITHUB_SHA: 'ba5eba11ba5eba11ba5eba11ba5eba11ba5eba11',
  GITHUB_SERVER_URL: 'https://github.example',
  GITHUB_RUN_ID: '4242',
  GITHUB_RUN_ATTEMPT: '1',
  NEEDS_JSON: JSON.stringify({ check: { result: 'success' }, smoke: { result: 'failure' } }),
}

function startStubForge(openIssues) {
  const requests = []
  let nextNumber = 500
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => {
      raw += chunk
    })
    request.on('end', () => {
      const record = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        body: raw.length > 0 ? JSON.parse(raw) : null,
      }
      requests.push(record)
      const send = (status, payload) => {
        response.writeHead(status, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify(payload))
      }
      if (request.method === 'GET') return send(200, openIssues)
      if (request.url?.endsWith('/comments')) return send(201, { id: 1 })
      // Answer a create with a number, the way the forge does.
      return send(201, { number: nextNumber++ })
    })
  })
  return new Promise((accept) => {
    server.listen(0, '127.0.0.1', () => accept({ server, requests }))
  })
}

/**
 * Drive one alert against a forge that already has `openIssues` open under the
 * alert label, and report what the script asked the forge to do.
 *
 * `env` overrides let a caller vary the run (a re-run attempt, a malformed
 * `needs`); everything else is the stub environment above.
 */
export async function runAlertAgainstStub({ openIssues = [], env = {} } = {}) {
  const { server, requests } = await startStubForge(openIssues)
  const port = server.address().port
  const previous = { ...process.env }
  Object.assign(process.env, STUB_ENV, env, { GITHUB_API_URL: `http://127.0.0.1:${port}` })
  try {
    const outcome = await fileAlert()
    return { ...outcome, requests }
  } finally {
    // Restore rather than delete: a vitest worker runs other suites in this
    // process, and one of them reading a leaked GITHUB_TOKEN would be a mess.
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
    server.close()
  }
}
