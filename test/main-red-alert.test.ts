import { describe, expect, it } from 'vitest'
import labelsYaml from '../.github/labels.yml?raw'
import ciWorkflow from '../.github/workflows/ci.yml?raw'
import {
  ALERT_LABEL,
  ALERT_MARKER,
  ALERT_TITLE,
  alertBody,
  failureReport,
  findOpenAlert,
  notGreenJobs,
} from '../scripts/main-red-alert.mjs'
import { runAlertAgainstStub } from '../scripts/main-red-alert-probe.mjs'
// The same reader `test/fixture-separation.test.ts` uses to ask which job runs
// which lane — one parser for this workflow, not one per test file.
import { jobBlock, jobIds } from './lib/ci-workflow'

/**
 * The notifier that makes a red `main` something somebody is handed (issue #57).
 *
 * Four times in one afternoon a pull request that was individually correct and
 * CI-green produced a broken `main` when it merged — three of them with no `git`
 * conflict, because identical edits merge clean and so do edits to different
 * lines of files whose semantics interact. The push-triggered half of
 * `.github/workflows/ci.yml` was already checking the merge result the whole
 * time; what was missing was anyone reading it.
 *
 * Two halves are tested here, and the second is the one that matters. The report
 * composition is pure and cheap to assert. The *wiring* is what has failed in
 * this repo before — a guard with a green unit test and no path to production —
 * so the workflow file itself is parsed and the alert job's `needs` is compared
 * against every other job in the workflow. Add a CI job later and leave it out of
 * that list and this suite goes red, rather than the job going unwatched in
 * silence.
 */

/** Every label name `.loom/scripts/sync-labels.sh` would create on the forge. */
const repoLabels = [...labelsYaml.matchAll(/^- name: (.+)$/gm)].map((match) => match[1].trim())

const ALERT_JOB = 'main-red-alert'

describe('the alert job is wired to every check it claims to watch', () => {
  const jobs = jobIds(ciWorkflow)
  const block = jobBlock(ciWorkflow, ALERT_JOB)

  it('exists in the workflow at all', () => {
    expect(jobs).toContain(ALERT_JOB)
  })

  it('needs every other job in the workflow, so none goes unwatched', () => {
    const needs = /^ {4}needs: \[(.+)\]$/m.exec(block)?.[1]
    expect(needs).toBeDefined()
    const watched = (needs ?? '').split(',').map((entry) => entry.trim())
    expect([...watched].sort()).toEqual(jobs.filter((job) => job !== ALERT_JOB).sort())
  })

  it('runs only on a push to main, and treats a cancelled job as not green', () => {
    const condition = /^ {4}if: (.+)$/m.exec(block)?.[1] ?? ''
    expect(condition).toContain('failure()')
    expect(condition).toContain('cancelled()')
    expect(condition).toContain("github.ref == 'refs/heads/main'")
  })

  it('asks for the one permission it needs', () => {
    expect(block).toMatch(/^ {6}issues: write$/m)
  })

  // Matched as regexes rather than plain strings so an Actions expression can be
  // written out literally without biome reading `${{` as a template placeholder.
  it('invokes this script, with the needs context it reports on', () => {
    expect(block).toContain('node scripts/main-red-alert.mjs')
    expect(block).toMatch(/NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}/)
    expect(block).toMatch(/GITHUB_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/)
  })

  it('does not install dependencies, so an install failure still alerts', () => {
    expect(block).not.toMatch(/^ {6}- run: pnpm install/m)
  })
})

describe('which jobs a run reports as not green', () => {
  it('names the failures, and leaves the green ones out', () => {
    expect(
      notGreenJobs({
        check: { result: 'failure' },
        smoke: { result: 'success' },
        e2e: { result: 'failure' },
      }),
    ).toEqual([
      { job: 'check', result: 'failure' },
      { job: 'e2e', result: 'failure' },
    ])
  })

  it('counts cancelled and skipped, because neither ran', () => {
    expect(notGreenJobs({ smoke: { result: 'cancelled' }, e2e: { result: 'skipped' } })).toEqual([
      { job: 'e2e', result: 'skipped' },
      { job: 'smoke', result: 'cancelled' },
    ])
  })

  it('survives a needs context that is missing or malformed', () => {
    expect(notGreenJobs(null)).toEqual([])
    expect(notGreenJobs('not an object')).toEqual([])
    expect(notGreenJobs({ check: {} })).toEqual([{ job: 'check', result: 'unknown' }])
  })
})

describe('what the alert says', () => {
  const failure = {
    sha: 'f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
    runUrl: 'https://github.com/2AMLogic/nuggbudz/actions/runs/123',
    attempt: '1',
    jobs: [{ job: 'smoke', result: 'failure' }],
  }

  it('carries the commit, the run and each failing job', () => {
    const report = failureReport(failure)
    expect(report).toContain(failure.sha)
    expect(report).toContain(failure.runUrl)
    expect(report).toContain('`smoke` — failure')
  })

  it('names a re-run attempt, and stays quiet about the first one', () => {
    expect(failureReport(failure)).not.toContain('attempt')
    expect(failureReport({ ...failure, attempt: '3' })).toContain('(attempt 3)')
  })

  it('still reports something when no job owns the failure', () => {
    const report = failureReport({ ...failure, jobs: [] })
    expect(report).toContain('no job reported a non-success result')
    expect(report).toContain(failure.runUrl)
  })

  it('puts the marker in the body exactly once, with the report', () => {
    const body = alertBody(failureReport(failure))
    expect(body.split(ALERT_MARKER)).toHaveLength(2)
    expect(body).toContain(failure.runUrl)
    // The reproduction instructions have to name the lanes that see this class
    // of defect at all: `pnpm test` was green for two of the four incidents.
    expect(body).toContain('pnpm smoke')
  })
})

describe('finding the issue an earlier failure opened', () => {
  it('only claims an issue this script wrote', () => {
    expect(findOpenAlert([{ number: 7, body: 'an unrelated auditor report' }])).toBeNull()
    expect(findOpenAlert([{ number: 7, body: null }])).toBeNull()
    expect(findOpenAlert([])).toBeNull()
  })

  it('takes the oldest, so a hand-filed duplicate does not split the thread', () => {
    const issues = [
      { number: 30, body: `${ALERT_MARKER}\nlater` },
      { number: 12, body: `${ALERT_MARKER}\nfirst` },
    ]
    expect(findOpenAlert(issues)?.number).toBe(12)
  })
})

describe('what the alert actually asks the forge to do', () => {
  it('files one issue, labelled and marked, when there is none open', async () => {
    const run = await runAlertAgainstStub()
    expect(run.action).toBe('filed')
    const created = run.requests.filter((request) => request.method === 'POST')
    expect(created).toHaveLength(1)
    expect(created[0].url).toBe('/repos/2AMLogic/nuggbudz/issues')
    expect(created[0].body?.labels).toEqual([ALERT_LABEL])
    expect(created[0].body?.title).toBe(ALERT_TITLE)
    expect(created[0].body?.body).toContain(ALERT_MARKER)
    // The failing job comes from the `needs` context the workflow hands over,
    // not from anything this script knows about the workflow.
    expect(created[0].body?.body).toContain('`smoke` — failure')
  })

  it('looks for an open alert under the label before filing anything', async () => {
    const run = await runAlertAgainstStub()
    const [first] = run.requests
    expect(first.method).toBe('GET')
    expect(first.url).toContain('state=open')
    expect(first.url).toContain(encodeURIComponent(ALERT_LABEL))
    expect(first.authorization).toBe('Bearer not-a-real-token')
  })

  it('comments on the open alert instead of filing a second one', async () => {
    const run = await runAlertAgainstStub({
      openIssues: [
        { number: 91, body: 'an unrelated auditor report' },
        { number: 92, body: `${ALERT_MARKER}\nthe first failure` },
      ],
    })
    expect(run).toMatchObject({ action: 'commented', issue: 92 })
    const posted = run.requests.filter((request) => request.method === 'POST')
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toBe('/repos/2AMLogic/nuggbudz/issues/92/comments')
    // The standing explanation belongs to the issue; a comment is just this run.
    expect(posted[0].body?.body).not.toContain(ALERT_MARKER)
    expect(posted[0].body?.body).toContain('actions/runs/4242')
  })

  it('refuses to run outside Actions rather than filing a half-filled alert', async () => {
    await expect(runAlertAgainstStub({ env: { GITHUB_SHA: '' } })).rejects.toThrow('GITHUB_SHA')
  })
})

describe('the label the alert is filed under', () => {
  it('is one this repo defines, so the create call cannot 422 on an unknown one', () => {
    // A label missing from the forge makes `POST /issues` fail, and the alert
    // would be a red job that told nobody — the exact failure mode this whole
    // lane exists to remove. `.github/labels.yml` is what `sync-labels.sh`
    // creates them from, so it is the closest thing to that list a unit test can
    // read.
    expect(repoLabels).toContain(ALERT_LABEL)
  })
})
