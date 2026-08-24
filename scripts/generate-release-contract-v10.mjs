import { readFile, writeFile } from 'node:fs/promises'
import { releaseAcceptancePack } from '../packages/outcome/outcome-verification/lib/index.js'

const config = JSON.parse(await readFile(new URL('../config/acceptance/release-v1.json', import.meta.url), 'utf8'))
const goalId = process.env.DSH_RELEASE_GOAL_ID ?? 'deepseek-harness-release'
const goalRevision = Number(process.env.DSH_RELEASE_GOAL_REVISION ?? '1')
if (!Number.isSafeInteger(goalRevision) || goalRevision < 1) throw new Error('DSH_RELEASE_GOAL_REVISION must be a positive integer')
const contract = releaseAcceptancePack({ goalId, goalRevision, objective: `Verify DeepSeek Harness release candidate using ${config.pack}@${config.packVersion}` })
const output = `${JSON.stringify({ mode: config.defaultMode, benchmarkGate: config.benchmarkGate, contract }, null, 2)}\n`
const target = process.argv[2]
if (target) await writeFile(target, output)
else process.stdout.write(output)
