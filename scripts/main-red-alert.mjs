#!/usr/bin/env node
/**
 * Tell somebody when `main` is red (issue #57).
 *
 * Four times in one afternoon a pull request that was individually correct and
 * CI-green produced a broken `main` when it merged, and in three of the four
 * cases `git` reported no conflict at all: per-PR CI tests the PR's tree and
 * `main`'s tree, never the tree that results from combining them. Two of those
 * four were caught only because somebody happened to run the integration suite
 * locally afterwards.
 *
 * `.github/workflows/ci.yml` has always re-run on `push: branches: [main]`, so
 * the merge result *was* being checked — nobody was watching the result. This
 * script is the watching: on a red push-triggered run it opens one
 * `loom:auditor` tracking issue, and every later failure comments on that same
 * issue rather than filing a second one, so a week of red pushes is one thread a
 * human (or the Auditor role) can read top to bottom.
 *
 * It is deliberately not a gate. Gating the merge result needs "require branches
 * to be up to date before merging" or a merge queue, which is a repo-admin
 * setting no workflow can grant itself — see CLAUDE.md, "A green pull request is
 * not a green `main`".
 *
 * The half that composes the report is exported and pure, because the half that
 * talks to the forge cannot be run in `pnpm test`: `test/main-red-alert.test.ts`
 * drives it, and also asserts the workflow actually wires this file up with every
 * other job in `needs` — a notifier that is never invoked, or that watches five
 * of six jobs, is this repo's recurring defect shape.
 */

import { pathToFileURL } from 'node:url'

const API_VERSION = '2022-11-28'

/** The label this repo's Auditor role already answers to. */
export const ALERT_LABEL = 'loom:auditor'

/**
 * How a later failure finds the issue an earlier one opened. A marker in the
 * body rather than a title match: the title is prose somebody may well rewrite
 * while triaging, and code search over an HTML comment is not reliable enough to
 * decide "file a duplicate" on.
 */
export const ALERT_MARKER = '<!-- nuggbudz:main-red-alert -->'

export const ALERT_TITLE = '`main` is red: CI failed on a push to `main`'

/**
 * Every job in the run that did not come up green, with the result verbatim.
 *
 * `skipped` and `cancelled` count as not-green on purpose: a job that could not
 * run must never read as one that passed, and on `main` there is nothing to
 * supersede a run for, so neither has an innocent explanation here.
 */
export function notGreenJobs(needs) {
  if (needs === null || typeof needs !== 'object') return []
  return Object.entries(needs)
    .map(([job, outcome]) => ({ job, result: outcome?.result ?? 'unknown' }))
    .filter(({ result }) => result !== 'success')
    .sort((a, b) => a.job.localeCompare(b.job))
}

/**
 * The part that is true of one failing run, used verbatim both as the body of a
 * newly filed issue and as a comment on an existing one.
 */
export function failureReport({ sha, runUrl, attempt, jobs }) {
  const lines = [
    `- Commit: \`${sha}\``,
    `- Run: ${runUrl}${attempt && attempt !== '1' ? ` (attempt ${attempt})` : ''}`,
  ]
  if (jobs.length === 0) {
    // The workflow's own `if:` decided this run is not green, so there is
    // something to report even when no single job owns it — say so rather than
    // filing an empty alert or, worse, filing nothing.
    lines.push('- Jobs: no job reported a non-success result; read the run.')
  } else {
    lines.push('- Jobs that did not come up green:')
    for (const { job, result } of jobs) lines.push(`  - \`${job}\` — ${result}`)
  }
  return lines.join('\n')
}

/**
 * The body of the tracking issue itself. Carries the marker and the standing
 * explanation; the per-failure detail is the same `failureReport` a repeat
 * failure posts as a comment.
 */
export function alertBody(report) {
  return [
    ALERT_MARKER,
    'CI went red on a push to `main`, which means the **merge result** is broken —',
    'not a pull request. Every job in this workflow runs on `push: branches: [main]`',
    'as well as on pull requests, precisely because a pull request that is green on',
    'its own merge-base says nothing about the tree it produces when it lands',
    '(issue #57: four such merges in one afternoon, three of them with no `git`',
    'conflict at all).',
    '',
    'Reproduce with `pnpm test`, `pnpm smoke` and `pnpm test:e2e` on `main`. Treat a',
    'red `main` as a revert trigger: the commit below is the first suspect, but the',
    'whole point of this class of defect is that no single side of the merge is',
    'wrong on its own.',
    '',
    'Later failures are added as comments on this issue rather than filed as new',
    'ones. Close it once `main` is green again.',
    '',
    '---',
    '',
    report,
  ].join('\n')
}

/** The open alert this run should comment on, or `null` if there is none. */
export function findOpenAlert(issues) {
  const open = issues.filter(
    (issue) => typeof issue?.body === 'string' && issue.body.includes(ALERT_MARKER),
  )
  // Oldest first, so a duplicate filed by hand never splits the thread in two.
  open.sort((a, b) => a.number - b.number)
  return open[0] ?? null
}

async function api(base, path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': API_VERSION,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (!response.ok) {
    throw new Error(`${method} ${path} → ${response.status} ${await response.text()}`)
  }
  return response.json()
}

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set — this script only runs inside Actions`)
  return value
}

/**
 * File the alert, or comment on the one an earlier failure filed.
 *
 * Everything it needs comes from the Actions environment, including
 * `GITHUB_API_URL` — which is also how `scripts/main-red-alert-probe.mjs` points
 * this at a stub forge, so the two calls that actually matter are exercised
 * rather than merely described.
 */
export async function fileAlert() {
  const token = required('GITHUB_TOKEN')
  const repo = required('GITHUB_REPOSITORY')
  const sha = required('GITHUB_SHA')
  const server = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const apiBase = process.env.GITHUB_API_URL ?? 'https://api.github.com'
  const runId = required('GITHUB_RUN_ID')
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? '1'

  // The `needs` context as JSON, handed over by the workflow. Parsed
  // defensively: a malformed blob must still produce an alert, because the run
  // is red either way.
  let needs = null
  try {
    needs = JSON.parse(process.env.NEEDS_JSON ?? 'null')
  } catch {
    needs = null
  }

  const report = failureReport({
    sha,
    runUrl: `${server}/${repo}/actions/runs/${runId}`,
    attempt,
    jobs: notGreenJobs(needs),
  })

  const label = encodeURIComponent(ALERT_LABEL)
  const query = `state=open&labels=${label}&per_page=100`
  const existing = findOpenAlert(await api(apiBase, `/repos/${repo}/issues?${query}`, { token }))

  if (existing) {
    await api(apiBase, `/repos/${repo}/issues/${existing.number}/comments`, {
      token,
      method: 'POST',
      body: { body: report },
    })
    console.log(`Commented on existing ${ALERT_LABEL} issue #${existing.number}`)
    return { action: 'commented', issue: existing.number }
  }

  const filed = await api(apiBase, `/repos/${repo}/issues`, {
    token,
    method: 'POST',
    body: { title: ALERT_TITLE, body: alertBody(report), labels: [ALERT_LABEL] },
  })
  console.log(`Filed ${ALERT_LABEL} issue #${filed.number}`)
  return { action: 'filed', issue: filed.number }
}

// Importing this module for its pure half must not file anything — the same
// argv/import.meta.url guard scripts/demo-pairing-check.mjs uses.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // A notifier that fails silently is worse than none: let the error surface as
  // a red job of its own rather than a green one that told nobody.
  await fileAlert()
}
