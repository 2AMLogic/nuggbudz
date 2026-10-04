/**
 * A reader for `.github/workflows/ci.yml`, for tests whose subject is the job
 * graph itself.
 *
 * Two of them exist. `test/main-red-alert.test.ts` asks which jobs are in the
 * workflow, so the alert job's `needs` can be compared against all of them.
 * `test/fixture-separation.test.ts` asks which job runs which lane, and in which
 * *step*, because that is what decides whether two fixture-less scenarios can be
 * live against one dev server at the same time (issue #96).
 *
 * It is a reader rather than a YAML dependency on purpose: the only shapes it has
 * to understand are the ones this one workflow uses, and a second copy of this
 * parser in each test file is the "two lists nobody compares" defect that
 * `scripts/pool-fixtures.mjs` exists to prevent. It **throws** rather than
 * returning `undefined` for everything it cannot find, so a workflow it has
 * stopped being able to read fails a test instead of quietly answering "nothing
 * runs that".
 */

/** Top-level job ids under `jobs:` — those are the only keys at two spaces. */
export function jobIds(yaml: string): string[] {
  const lines = yaml.split('\n')
  const start = lines.indexOf('jobs:')
  if (start === -1) throw new Error('the workflow has no top-level `jobs:` key')
  return lines.slice(start + 1).flatMap((line) => {
    const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line)
    return match ? [match[1]] : []
  })
}

/** One job's own block, from its key to the next job id. */
export function jobBlock(yaml: string, id: string): string {
  const lines = yaml.split('\n')
  const start = lines.indexOf(`  ${id}:`)
  if (start === -1) throw new Error(`the workflow has no job '${id}'`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:\s*$/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

/**
 * One entry per `- ` step of a job, in the order the job runs them: the step's
 * `run` scalar alone, with comment lines removed, or '' for a step that runs no
 * shell (`uses:`).
 *
 * The comments have to go: this workflow explains itself at length, and a job
 * that merely *mentions* `pnpm smoke` in a comment about a sibling job does not
 * run it. So does everything but `run`: a step *named* `Run pnpm demo-check` whose
 * command is `pnpm demo-check-renamed` invokes nothing called `demo-check`, and
 * reading the name would say it does. The order is the point of the list — steps
 * inside one job run in sequence, so two commands in two different steps of one
 * job are never live at the same time.
 */
export function jobSteps(yaml: string, id: string): string[] {
  const body = jobBlock(yaml, id)
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  // Steps are the six-space `- ` entries under `    steps:`; a `run: |` block's
  // continuation lines are indented further and so never start a new one.
  return body
    .split(/^ {6}- /m)
    .slice(1)
    .map((step) => stepRun(step.trimEnd()))
}

/**
 * The `run` value of one step, inline or block scalar. The step's keys sit at
 * eight spaces (the first one shares the `- ` line, whose six-space dash was
 * consumed by the split), so a `run:` nested under `with:` or `env:` is not it.
 */
function stepRun(step: string): string {
  const lines = step.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^( *)run:\s*(.*)$/.exec(lines[i])
    if (!match) continue
    if (match[1].length !== (i === 0 ? 0 : 8)) continue
    if (!/^[|>][+-]?\d*$/.test(match[2])) return match[2]
    const block: string[] = []
    for (const line of lines.slice(i + 1)) {
      if (line.trim() !== '' && !/^ {9,}/.test(line)) break
      block.push(line)
    }
    return block.join('\n').trimEnd()
  }
  return ''
}

/**
 * Does this step run exactly `command`, rather than something that merely starts
 * with it?
 *
 * A plain substring test answers yes for `pnpm demo-check-renamed` when asked
 * about `pnpm demo-check`, which is the shape of the only mutation that got past
 * the first version of this check: renaming a runner in the workflow left the test
 * green, so a lane whose runner CI no longer invoked still looked wired. The
 * command has to be followed by something that ends it — a newline, a space, a
 * shell separator — and never by another word character, `-` or `:`.
 */
export function stepInvokes(step: string, command: string): boolean {
  const literal = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`${literal}(?![\\w:-])`).test(step)
}
