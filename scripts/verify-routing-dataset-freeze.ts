#!/usr/bin/env node
/** Verifies the immutable learned-routing baseline manifest and its task-ID splits. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST_PATH = resolve(REPO_ROOT, 'artifacts/reports/paired-v4-100-v1.manifest.json')

interface ArtifactPin {
  path: string
  sha256: string
}

/** Successful frozen-dataset verification summary. */
export interface RoutingDatasetFreezeResult {
  datasetId: string
  taskClasses: number
}

interface FreezeManifest {
  datasetId: string
  artifacts: Record<string, ArtifactPin>
  partitions: Record<'train' | 'validation' | 'test', string[]>
}

interface EvaluationRecord {
  dataset: { id: string }
  partitions: Record<'train' | 'validation' | 'test', { tasks: string[] }>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`verify-routing-dataset-freeze: ${field} must be a string array`)
  }
  return value
}

function parseManifest(value: unknown): FreezeManifest {
  if (!isRecord(value) || typeof value.datasetId !== 'string' || !isRecord(value.artifacts) || !isRecord(value.partitions)) {
    throw new Error('verify-routing-dataset-freeze: malformed manifest')
  }
  const artifacts: Record<string, ArtifactPin> = {}
  for (const [name, pin] of Object.entries(value.artifacts)) {
    if (!isRecord(pin) || typeof pin.path !== 'string' || typeof pin.sha256 !== 'string') {
      throw new Error(`verify-routing-dataset-freeze: malformed artifact pin ${name}`)
    }
    artifacts[name] = { path: pin.path.replaceAll('\\', '/'), sha256: pin.sha256 }
  }
  return {
    datasetId: value.datasetId,
    artifacts,
    partitions: {
      train: stringArray(value.partitions.train, 'partitions.train'),
      validation: stringArray(value.partitions.validation, 'partitions.validation'),
      test: stringArray(value.partitions.test, 'partitions.test'),
    },
  }
}

function parseEvaluation(value: unknown): EvaluationRecord {
  if (!isRecord(value) || !isRecord(value.dataset) || typeof value.dataset.id !== 'string' || !isRecord(value.partitions)) {
    throw new Error('verify-routing-dataset-freeze: malformed evaluation record')
  }
  const partitions = value.partitions
  const partition = (name: 'train' | 'validation' | 'test'): { tasks: string[] } => {
    const candidate = partitions[name]
    if (!isRecord(candidate)) throw new Error(`verify-routing-dataset-freeze: missing ${name} partition`)
    return { tasks: stringArray(candidate.tasks, `evaluation.partitions.${name}.tasks`) }
  }
  return {
    dataset: { id: value.dataset.id },
    partitions: { train: partition('train'), validation: partition('validation'), test: partition('test') },
  }
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Verify artifact hashes, dataset identity, and task-isolated partitions.
 * @param repositoryRoot - repository root used to resolve normalized artifact paths.
 * @param manifestPath - freeze manifest to validate.
 * @returns the verified dataset identity and task-class count.
 */
export async function verifyRoutingDatasetFreeze(
  repositoryRoot: string,
  manifestPath: string,
): Promise<RoutingDatasetFreezeResult> {
  const manifest = parseManifest(JSON.parse(await readFile(manifestPath, 'utf8')) as unknown)
  for (const [name, pin] of Object.entries(manifest.artifacts)) {
    const path = resolve(repositoryRoot, pin.path)
    if (!path.startsWith(`${repositoryRoot}/`)) {
      throw new Error(`verify-routing-dataset-freeze: artifact ${name} escapes repository`)
    }
    const actual = await sha256(path)
    if (actual !== pin.sha256) {
      throw new Error(`verify-routing-dataset-freeze: ${pin.path} changed: expected ${pin.sha256}, got ${actual}`)
    }
  }

  const evaluationPin = manifest.artifacts.evaluation
  if (evaluationPin === undefined) throw new Error('verify-routing-dataset-freeze: evaluation artifact pin is required')
  const evaluation = parseEvaluation(
    JSON.parse(await readFile(resolve(repositoryRoot, evaluationPin.path), 'utf8')) as unknown,
  )
  if (evaluation.dataset.id !== manifest.datasetId) {
    throw new Error(`verify-routing-dataset-freeze: dataset id mismatch: ${evaluation.dataset.id} != ${manifest.datasetId}`)
  }

  const seen = new Set<string>()
  for (const name of ['train', 'validation', 'test'] as const) {
    const expected = manifest.partitions[name]
    const actual = evaluation.partitions[name].tasks
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`verify-routing-dataset-freeze: ${name} task IDs changed`)
    }
    for (const taskId of actual) {
      if (seen.has(taskId)) throw new Error(`verify-routing-dataset-freeze: task ${taskId} crosses partitions`)
      seen.add(taskId)
    }
  }
  return { datasetId: manifest.datasetId, taskClasses: seen.size }
}

async function main(): Promise<void> {
  const result = await verifyRoutingDatasetFreeze(REPO_ROOT, MANIFEST_PATH)
  process.stdout.write(
    `verify-routing-dataset-freeze: ${result.datasetId} verified (${result.taskClasses} task classes)\n`,
  )
}

if (process.env.VITEST === undefined) void main()
