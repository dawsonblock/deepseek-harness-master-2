#!/usr/bin/env bash
# v0.19 Batch A repository setup script.
#
# Creates 7 real local git repositories under /tmp/v019-batch-a-repos/
# with known bugs at the base commit and fixes at the reference fix commit.
#
# Each repository is a small TypeScript project with vitest tests that
# fail at the base commit and pass at the fix commit.
#
# Idempotent: deletes and recreates repos if they already exist.
set -euo pipefail

REPO_ROOT="/tmp/v019-batch-a-repos"
HOLDOUT_ROOT="$REPO_ROOT/holdouts"
mkdir -p "$REPO_ROOT" "$HOLDOUT_ROOT"

# Common package.json template
make_package_json() {
  local name="$1"
  cat <<EOF
{
  "name": "$name",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
EOF
}

# Common tsconfig.json template
make_tsconfig() {
  cat <<'EOF'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
EOF
}

# Common vitest config — diagnostic tests only; holdout tests are excluded
# from diagnostic discovery and run separately by the verifier.
make_vitest_config() {
  cat <<'EOF'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/**/*.holdout.test.ts', 'node_modules', 'dist'],
  },
})
EOF
}

# Holdout vitest config — includes holdout test files without the exclude.
# Used by the verifier when running staged holdout tests.
make_vitest_holdout_config() {
  cat <<'EOF'
import { defineConfig } from 'vitest/config'
export default defineConfig({
  test: {
    include: ['tests/**/*.holdout.test.ts'],
    exclude: ['node_modules', 'dist'],
  },
})
EOF
}

# Initialize a git repo and make initial commit
init_repo() {
  local dir="$1"
  cd "$dir"
  git init --quiet
  git add -A
  git commit -m "initial: project setup" --quiet
}

# =========================================================================
# 1. ts-utils
# =========================================================================
create_ts_utils() {
  local dir="$REPO_ROOT/ts-utils"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/tests"

  make_package_json "ts-utils" > "$dir/package.json"
  make_tsconfig > "$dir/tsconfig.json"
  make_vitest_config > "$dir/vitest.config.ts"
  make_vitest_holdout_config > "$dir/vitest.holdout.config.ts"

  # --- src/debounce.ts (BUG: missing clearTimeout) ---
  cat > "$dir/src/debounce.ts" <<'EOF'
/**
 * Debounce a function call.
 * @param fn - function to debounce
 * @param ms - delay in milliseconds
 * @returns debounced function
 */
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: Parameters<T>) => {
    // BUG: should clearTimeout(timer) before setting new timer
    timer = setTimeout(() => fn(...args), ms)
  }
}
EOF

  # --- src/chunk.ts (BUG: throws on empty array) ---
  cat > "$dir/src/chunk.ts" <<'EOF'
/**
 * Split an array into chunks of the given size.
 * @param arr - array to chunk
 * @param size - chunk size
 * @returns array of chunks
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) throw new Error('cannot chunk empty array')
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}
EOF

  # --- src/throttle.ts (BUG: missing return type, implicit any) ---
  cat > "$dir/src/throttle.ts" <<'EOF'
/**
 * Throttle a function call.
 * @param fn - function to throttle
 * @param ms - throttle interval
 */
export function throttle(fn, ms) {
  let last = 0
  return (...args) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    }
  }
}
EOF

  # --- src/binarySearch.ts (BUG: doesn't find first occurrence) ---
  cat > "$dir/src/binarySearch.ts" <<'EOF'
/**
 * Binary search for target in a sorted array.
 * @param arr - sorted array
 * @param target - value to find
 * @returns index of target, or -1 if not found
 */
export function binarySearch(arr: number[], target: number): number {
  let lo = 0
  let hi = arr.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === target) {
      // BUG: returns immediately instead of finding first occurrence
      return mid
    } else if (arr[mid] < target) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return -1
}
EOF

  # --- src/index.ts ---
  cat > "$dir/src/index.ts" <<'EOF'
export { debounce } from './debounce.js'
export { chunk } from './chunk.js'
export { throttle } from './throttle.js'
export { binarySearch } from './binarySearch.js'
EOF

  # --- tests ---
  cat > "$dir/tests/debounce.test.ts" <<'EOF'
import { describe, it, expect, vi } from 'vitest'
import { debounce } from '../src/debounce.js'

describe('debounce', () => {
  it('calls the function after delay', async () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 50)
    debounced()
    await new Promise(r => setTimeout(r, 100))
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('cancels previous pending calls', async () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 50)
    debounced()
    debounced()
    debounced()
    await new Promise(r => setTimeout(r, 100))
    expect(fn).toHaveBeenCalledTimes(1)
  })
})
EOF

  cat > "$dir/tests/chunk.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { chunk } from '../src/chunk.js'

describe('chunk', () => {
  it('chunks an array', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })

  it('returns empty array for empty input', () => {
    expect(chunk([], 2)).toEqual([])
  })
})
EOF

  cat > "$dir/tests/binarySearch.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { binarySearch } from '../src/binarySearch.js'

describe('binarySearch', () => {
  it('finds an element', () => {
    expect(binarySearch([1, 2, 3, 4, 5], 3)).toBe(2)
  })

  it('returns -1 for missing element', () => {
    expect(binarySearch([1, 2, 3, 4, 5], 6)).toBe(-1)
  })

  it('finds first occurrence of duplicates', () => {
    expect(binarySearch([1, 2, 2, 2, 3], 2)).toBe(1)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/debounce.holdout.test.ts" <<'EOF'
import { describe, it, expect, vi } from 'vitest'
import { debounce } from '../src/debounce.js'

describe('debounce holdout', () => {
  it('passes correct arguments', async () => {
    const fn = vi.fn()
    const debounced = debounce(fn, 30)
    debounced('a', 'b')
    await new Promise(r => setTimeout(r, 60))
    expect(fn).toHaveBeenCalledWith('a', 'b')
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/binarySearch.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { binarySearch } from '../src/binarySearch.js'

describe('binarySearch holdout', () => {
  it('finds first occurrence in all-duplicates array', () => {
    expect(binarySearch([5, 5, 5, 5, 5], 5)).toBe(0)
  })
})
EOF

  init_repo "$dir"
  local base_commit=$(git -C "$dir" rev-parse HEAD)

  # Apply fixes
  cat > "$dir/src/debounce.ts" <<'EOF'
export function debounce<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  return (...args: Parameters<T>) => {
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => fn(...args), ms)
  }
}
EOF

  cat > "$dir/src/chunk.ts" <<'EOF'
export function chunk<T>(arr: T[], size: number): T[][] {
  if (arr.length === 0) return []
  const result: T[][] = []
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size))
  }
  return result
}
EOF

  cat > "$dir/src/throttle.ts" <<'EOF'
export function throttle<T extends (...args: unknown[]) => void>(
  fn: T,
  ms: number,
): (...args: Parameters<T>) => void {
  let last = 0
  return (...args: Parameters<T>) => {
    const now = Date.now()
    if (now - last >= ms) {
      last = now
      fn(...args)
    }
  }
}
EOF

  cat > "$dir/src/binarySearch.ts" <<'EOF'
export function binarySearch(arr: number[], target: number): number {
  let lo = 0
  let hi = arr.length - 1
  let result = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (arr[mid] === target) {
      result = mid
      hi = mid - 1
    } else if (arr[mid] < target) {
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return result
}
EOF

  git -C "$dir" add -A
  git -C "$dir" commit -m "fix: correct debounce, chunk, throttle, binarySearch" --quiet
  local fix_commit=$(git -C "$dir" rev-parse HEAD)

  echo "ts-utils base=$base_commit fix=$fix_commit"
}

# =========================================================================
# 2. ts-validate
# =========================================================================
create_ts_validate() {
  local dir="$REPO_ROOT/ts-validate"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/tests"

  make_package_json "ts-validate" > "$dir/package.json"
  make_tsconfig > "$dir/tsconfig.json"
  make_vitest_config > "$dir/vitest.config.ts"
  make_vitest_holdout_config > "$dir/vitest.holdout.config.ts"

  cat > "$dir/src/validators.ts" <<'EOF'
export function isEmail(value: string): boolean {
  return /^[^@]+@[^@]+\.[^@]+$/.test(value)
}

export function isUrl(value: string): boolean {
  // BUG: accepts URLs without protocol
  return value.includes('.') && !value.includes(' ')
}

export function isRequired(value: string): boolean {
  return value.trim().length > 0
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { isEmail, isUrl, isRequired } from './validators.js'
EOF

  cat > "$dir/tests/validators.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { isEmail, isUrl, isRequired } from '../src/validators.js'

describe('isUrl', () => {
  it('accepts valid URLs', () => {
    expect(isUrl('https://example.com')).toBe(true)
    expect(isUrl('http://test.org/path')).toBe(true)
  })

  it('rejects URLs without protocol', () => {
    expect(isUrl('example.com')).toBe(false)
    expect(isUrl('just text')).toBe(false)
  })
})

describe('isEmail', () => {
  it('accepts valid emails', () => {
    expect(isEmail('a@b.com')).toBe(true)
  })
  it('rejects invalid emails', () => {
    expect(isEmail('notanemail')).toBe(false)
  })
})

describe('isRequired', () => {
  it('rejects whitespace-only', () => {
    expect(isRequired('  ')).toBe(false)
  })
  it('accepts non-empty', () => {
    expect(isRequired('hello')).toBe(true)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/validators.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { isUrl } from '../src/validators.js'

describe('isUrl holdout', () => {
  it('rejects ftp URLs', () => {
    const result = isUrl('ftp://example.com')
    expect(result.valid).toBe(false)
  })
})
EOF

  init_repo "$dir"
  local base_commit=$(git -C "$dir" rev-parse HEAD)

  # Apply fixes: fix isUrl, add isPhoneNumber, refactor to ValidationResult, add validateWithSchema
  cat > "$dir/src/validators.ts" <<'EOF'
export interface ValidationResult {
  valid: boolean
  message?: string
}

export function isEmail(value: string): ValidationResult {
  const valid = /^[^@]+@[^@]+\.[^@]+$/.test(value)
  return valid ? { valid: true } : { valid: false, message: 'Invalid email' }
}

export function isUrl(value: string): ValidationResult {
  const valid = /^https?:\/\/[^\s]+\.[^\s]+/.test(value)
  return valid ? { valid: true } : { valid: false, message: 'Invalid URL' }
}

export function isRequired(value: string): ValidationResult {
  const valid = value.trim().length > 0
  return valid ? { valid: true } : { valid: false, message: 'Required' }
}

export function isPhoneNumber(value: string): boolean {
  return /^(\+1\s?)?(\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}$/.test(value)
}

export function validateWithSchema(
  obj: Record<string, unknown>,
  schema: Record<string, (v: unknown) => ValidationResult>,
): { valid: boolean; errors: Record<string, string> } {
  const errors: Record<string, string> = {}
  for (const [field, validator] of Object.entries(schema)) {
    const result = validator(obj[field])
    if (!result.valid) {
      errors[field] = result.message ?? 'Invalid'
    }
  }
  return { valid: Object.keys(errors).length === 0, errors }
}
EOF

  cat > "$dir/src/phone.ts" <<'EOF'
export function isPhoneNumber(value: string): boolean {
  return /^(\+1\s?)?(\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}$/.test(value)
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { isEmail, isUrl, isRequired, validateWithSchema } from './validators.js'
export type { ValidationResult } from './validators.js'
export { isPhoneNumber } from './phone.js'
EOF

  cat > "$dir/tests/phone.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { isPhoneNumber } from '../src/phone.js'

describe('isPhoneNumber', () => {
  it('accepts valid US phone numbers', () => {
    expect(isPhoneNumber('(123) 456-7890')).toBe(true)
    expect(isPhoneNumber('123-456-7890')).toBe(true)
    expect(isPhoneNumber('1234567890')).toBe(true)
  })
  it('rejects invalid phone numbers', () => {
    expect(isPhoneNumber('123')).toBe(false)
    expect(isPhoneNumber('not a number')).toBe(false)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/phone.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { isPhoneNumber } from '../src/phone.js'

describe('isPhoneNumber holdout', () => {
  it('accepts +1 prefix', () => {
    expect(isPhoneNumber('+1 (123) 456-7890')).toBe(true)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/schema.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { validateWithSchema, isEmail, isRequired } from '../src/validators.js'

describe('validateWithSchema holdout', () => {
  it('validates multiple fields', () => {
    const result = validateWithSchema(
      { email: 'bad', name: '' },
      { email: isEmail, name: isRequired },
    )
    expect(result.valid).toBe(false)
    expect(result.errors.email).toBeDefined()
    expect(result.errors.name).toBeDefined()
  })
})
EOF

  # Update validators.test.ts to work with ValidationResult
  cat > "$dir/tests/validators.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { isEmail, isUrl, isRequired } from '../src/validators.js'

describe('isUrl', () => {
  it('accepts valid URLs', () => {
    expect(isUrl('https://example.com').valid).toBe(true)
    expect(isUrl('http://test.org/path').valid).toBe(true)
  })
  it('rejects URLs without protocol', () => {
    expect(isUrl('example.com').valid).toBe(false)
    expect(isUrl('just text').valid).toBe(false)
  })
})

describe('isEmail', () => {
  it('accepts valid emails', () => {
    expect(isEmail('a@b.com').valid).toBe(true)
  })
  it('rejects invalid emails', () => {
    expect(isEmail('notanemail').valid).toBe(false)
  })
})

describe('isRequired', () => {
  it('rejects whitespace-only', () => {
    expect(isRequired('  ').valid).toBe(false)
  })
  it('accepts non-empty', () => {
    expect(isRequired('hello').valid).toBe(true)
  })
})
EOF

  git -C "$dir" add -A
  git -C "$dir" commit -m "fix: correct isUrl, add isPhoneNumber, refactor to ValidationResult, add validateWithSchema" --quiet
  local fix_commit=$(git -C "$dir" rev-parse HEAD)

  echo "ts-validate base=$base_commit fix=$fix_commit"
}

# =========================================================================
# 3. ts-collections
# =========================================================================
create_ts_collections() {
  local dir="$REPO_ROOT/ts-collections"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/tests"

  make_package_json "ts-collections" > "$dir/package.json"
  make_tsconfig > "$dir/tsconfig.json"
  make_vitest_config > "$dir/vitest.config.ts"
  make_vitest_holdout_config > "$dir/vitest.holdout.config.ts"

  cat > "$dir/src/LinkedList.ts" <<'EOF'
interface Node<T> { value: T; next: Node<T> | null }
export class LinkedList<T> {
  private head: Node<T> | null = null
  private len = 0
  append(value: T): void {
    const node: Node<T> = { value, next: null }
    if (this.head === null) { this.head = node }
    else {
      let cur = this.head
      while (cur.next !== null) cur = cur.next
      cur.next = node
    }
    this.len++
  }
  removeAt(index: number): T | undefined {
    if (index < 0 || index >= this.len) return undefined
    // BUG: doesn't handle head removal (index 0)
    let cur = this.head!
    let prev: Node<T> | null = null
    for (let i = 0; i < index; i++) { prev = cur; cur = cur.next! }
    if (prev !== null) prev.next = cur.next
    this.len--
    return cur.value
  }
  size(): number { return this.len }
  toArray(): T[] {
    const result: T[] = []
    let cur = this.head
    while (cur !== null) { result.push(cur.value); cur = cur.next }
    return result
  }
}
EOF

  cat > "$dir/src/quickSort.ts" <<'EOF'
export function quickSort(arr: number[]): number[] {
  if (arr.length <= 1) return arr
  const pivot = arr[arr.length - 1]
  const left: number[] = []
  const right: number[] = []
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] >= pivot) left.push(arr[i])
    else right.push(arr[i])
  }
  return [...quickSort(left), pivot, ...quickSort(right)]
}
EOF

  cat > "$dir/src/HashMap.ts" <<'EOF'
export class HashMap<K extends string, V> {
  private data: Record<string, V> = {}
  set(key: K, value: V): void { this.data[key] = value }
  get(key: K): V | undefined { return this.data[key] }
  has(key: K): boolean { return key in this.data }
  delete(key: K): boolean {
    if (key in this.data) { delete this.data[key]; return true }
    return false
  }
  size(): number { return Object.keys(this.data).length }
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { LinkedList } from './LinkedList.js'
export { quickSort } from './quickSort.js'
export { HashMap } from './HashMap.js'
EOF

  cat > "$dir/tests/LinkedList.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { LinkedList } from '../src/LinkedList.js'

describe('LinkedList', () => {
  it('appends and converts to array', () => {
    const list = new LinkedList<number>()
    list.append(1); list.append(2); list.append(3)
    expect(list.toArray()).toEqual([1, 2, 3])
  })
  it('removes at index 0 (head)', () => {
    const list = new LinkedList<number>()
    list.append(1); list.append(2); list.append(3)
    expect(list.removeAt(0)).toBe(1)
    expect(list.toArray()).toEqual([2, 3])
  })
  it('removes at middle index', () => {
    const list = new LinkedList<number>()
    list.append(1); list.append(2); list.append(3)
    expect(list.removeAt(1)).toBe(2)
    expect(list.toArray()).toEqual([1, 3])
  })
})
EOF

  cat > "$dir/tests/quickSort.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { quickSort } from '../src/quickSort.js'

describe('quickSort', () => {
  it('sorts an array in ascending order', () => {
    expect(quickSort([3, 1, 2])).toEqual([1, 2, 3])
  })
  it('handles duplicates', () => {
    expect(quickSort([3, 1, 2, 1, 3])).toEqual([1, 1, 2, 3, 3])
  })
  it('sorts a larger array', () => {
    expect(quickSort([5, 3, 8, 1, 9, 2, 7, 4, 6])).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
  it('handles single element', () => {
    expect(quickSort([1])).toEqual([1])
  })
  it('handles empty array', () => {
    expect(quickSort([])).toEqual([])
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/LinkedList.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { LinkedList } from '../src/LinkedList.js'

describe('LinkedList holdout', () => {
  it('removes all elements one by one from head', () => {
    const list = new LinkedList<number>()
    list.append(1); list.append(2); list.append(3)
    expect(list.removeAt(0)).toBe(1)
    expect(list.removeAt(0)).toBe(2)
    expect(list.removeAt(0)).toBe(3)
    expect(list.size()).toBe(0)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/quickSort.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { quickSort } from '../src/quickSort.js'

describe('quickSort holdout', () => {
  it('sorts already sorted array', () => {
    expect(quickSort([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5])
  })
  it('sorts reverse sorted array', () => {
    expect(quickSort([5, 4, 3, 2, 1])).toEqual([1, 2, 3, 4, 5])
  })
})
EOF

  init_repo "$dir"
  local base_commit=$(git -C "$dir" rev-parse HEAD)

  # Apply fixes
  cat > "$dir/src/LinkedList.ts" <<'EOF'
interface Node<T> { value: T; next: Node<T> | null }
export class LinkedList<T> {
  private head: Node<T> | null = null
  private len = 0
  append(value: T): void {
    const node: Node<T> = { value, next: null }
    if (this.head === null) { this.head = node }
    else {
      let cur = this.head
      while (cur.next !== null) cur = cur.next
      cur.next = node
    }
    this.len++
  }
  removeAt(index: number): T | undefined {
    if (index < 0 || index >= this.len) return undefined
    if (index === 0) {
      const value = this.head!.value
      this.head = this.head!.next
      this.len--
      return value
    }
    let cur = this.head!
    let prev: Node<T> | null = null
    for (let i = 0; i < index; i++) { prev = cur; cur = cur.next! }
    prev!.next = cur.next
    this.len--
    return cur.value
  }
  size(): number { return this.len }
  toArray(): T[] {
    const result: T[] = []
    let cur = this.head
    while (cur !== null) { result.push(cur.value); cur = cur.next }
    return result
  }
}
EOF

  cat > "$dir/src/quickSort.ts" <<'EOF'
export function quickSort(arr: number[]): number[] {
  if (arr.length <= 1) return arr
  const pivot = arr[arr.length - 1]
  const left: number[] = []
  const right: number[] = []
  for (let i = 0; i < arr.length - 1; i++) {
    if (arr[i] < pivot) left.push(arr[i])
    else right.push(arr[i])
  }
  return [...quickSort(left), pivot, ...quickSort(right)]
}
EOF

  # Add Stack class
  cat > "$dir/src/Stack.ts" <<'EOF'
export class Stack<T> {
  private items: T[] = []
  push(item: T): void { this.items.push(item) }
  pop(): T | undefined { return this.items.pop() }
  peek(): T | undefined { return this.items[this.items.length - 1] }
  size(): number { return this.items.length }
  isEmpty(): boolean { return this.items.length === 0 }
}
EOF

  cat > "$dir/tests/Stack.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { Stack } from '../src/Stack.js'

describe('Stack', () => {
  it('pushes and pops', () => {
    const s = new Stack<number>()
    s.push(1); s.push(2)
    expect(s.pop()).toBe(2)
    expect(s.pop()).toBe(1)
  })
  it('peeks without removing', () => {
    const s = new Stack<number>()
    s.push(1); s.push(2)
    expect(s.peek()).toBe(2)
    expect(s.size()).toBe(2)
  })
  it('returns undefined for pop on empty', () => {
    const s = new Stack<number>()
    expect(s.pop()).toBeUndefined()
  })
  it('returns undefined for peek on empty', () => {
    const s = new Stack<number>()
    expect(s.peek()).toBeUndefined()
  })
  it('isEmpty returns true for empty stack', () => {
    const s = new Stack<number>()
    expect(s.isEmpty()).toBe(true)
    s.push(1)
    expect(s.isEmpty()).toBe(false)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/Stack.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { Stack } from '../src/Stack.js'

describe('Stack holdout', () => {
  it('handles mixed push/pop operations', () => {
    const s = new Stack<string>()
    s.push('a'); s.push('b')
    expect(s.pop()).toBe('b')
    s.push('c')
    expect(s.pop()).toBe('c')
    expect(s.pop()).toBe('a')
    expect(s.isEmpty()).toBe(true)
  })
})
EOF

  # Refactor HashMap to use Map
  cat > "$dir/src/HashMap.ts" <<'EOF'
export class HashMap<K, V> {
  private data: Map<K, V> = new Map()
  set(key: K, value: V): void { this.data.set(key, value) }
  get(key: K): V | undefined { return this.data.get(key) }
  has(key: K): boolean { return this.data.has(key) }
  delete(key: K): boolean { return this.data.delete(key) }
  size(): number { return this.data.size }
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { LinkedList } from './LinkedList.js'
export { quickSort } from './quickSort.js'
export { HashMap } from './HashMap.js'
export { Stack } from './Stack.js'
EOF

  git -C "$dir" add -A
  git -C "$dir" commit -m "fix: LinkedList head removal, quickSort partition, add Stack, refactor HashMap" --quiet
  local fix_commit=$(git -C "$dir" rev-parse HEAD)

  echo "ts-collections base=$base_commit fix=$fix_commit"
}

# =========================================================================
# 4. ts-http
# =========================================================================
create_ts_http() {
  local dir="$REPO_ROOT/ts-http"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/tests"

  # BUG: typescript pinned to 5.0.0, vitest in dependencies instead of devDependencies
  cat > "$dir/package.json" <<'EOF'
{
  "name": "ts-http",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "typescript": "5.0.0",
    "vitest": "^2.0.0"
  }
}
EOF

  make_tsconfig > "$dir/tsconfig.json"
  make_vitest_config > "$dir/vitest.config.ts"
  make_vitest_holdout_config > "$dir/vitest.holdout.config.ts"

  cat > "$dir/src/headers.ts" <<'EOF'
export function parseHeaders(rawHeaders: string): Record<string, string> {
  // BUG: overwrites duplicate headers instead of collecting into array
  const result: Record<string, string> = {}
  for (const line of rawHeaders.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    result[key] = value
  }
  return result
}
EOF

  cat > "$dir/src/HttpClient.ts" <<'EOF'
export interface RequestConfig {
  url: string
  method?: string
  headers?: Record<string, string>
}

export class HttpClient {
  // BUG: no interceptor support
  async request(config: RequestConfig): Promise<unknown> {
    return fetch(config.url, {
      method: config.method ?? 'GET',
      headers: config.headers,
    })
  }
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { parseHeaders } from './headers.js'
export { HttpClient } from './HttpClient.js'
export type { RequestConfig } from './HttpClient.js'
EOF

  cat > "$dir/tests/headers.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { parseHeaders } from '../src/headers.js'

describe('parseHeaders', () => {
  it('parses simple headers', () => {
    const result = parseHeaders('Content-Type: application/json\nX-Custom: value')
    expect(result['Content-Type']).toBe('application/json')
    expect(result['X-Custom']).toBe('value')
  })
  it('handles multiple Set-Cookie headers', () => {
    const result = parseHeaders('Set-Cookie: a=1\nSet-Cookie: b=2') as Record<string, unknown>
    expect(result['Set-Cookie']).toEqual(['a=1', 'b=2'])
  })
})
EOF

  cat > "$dir/tests/HttpClient.test.ts" <<'EOF'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { HttpClient } from '../src/HttpClient.js'

describe('HttpClient interceptors', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('calls interceptors in registration order before request', async () => {
    const client = new HttpClient()
    const calls: string[] = []
    client.addInterceptor((config) => { calls.push('first'); return config })
    client.addInterceptor((config) => { calls.push('second'); return config })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}')))
    await client.request({ url: 'http://example.com' })
    expect(calls).toEqual(['first', 'second'])
  })

  it('passes modified config from interceptor to fetch', async () => {
    const client = new HttpClient()
    client.addInterceptor((config) => ({ ...config, headers: { 'X-Injected': 'yes' } }))
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    await client.request({ url: 'http://example.com' })
    expect(fetchMock).toHaveBeenCalledWith('http://example.com', expect.objectContaining({
      headers: { 'X-Injected': 'yes' },
    }))
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/headers.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { parseHeaders } from '../src/headers.js'

describe('parseHeaders holdout', () => {
  it('handles three duplicate headers', () => {
    const result = parseHeaders('X: 1\nX: 2\nX: 3') as Record<string, unknown>
    expect(result['X']).toEqual(['1', '2', '3'])
  })
})
EOF

  init_repo "$dir"
  local base_commit=$(git -C "$dir" rev-parse HEAD)

  # Apply fixes
  cat > "$dir/package.json" <<'EOF'
{
  "name": "ts-http",
  "version": "1.0.0",
  "type": "module",
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "vitest": "^2.0.0"
  }
}
EOF

  cat > "$dir/src/headers.ts" <<'EOF'
export function parseHeaders(rawHeaders: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const line of rawHeaders.split('\n')) {
    const idx = line.indexOf(':')
    if (idx === -1) continue
    const key = line.slice(0, idx).trim()
    const value = line.slice(idx + 1).trim()
    if (key in result) {
      const existing = result[key]
      if (Array.isArray(existing)) existing.push(value)
      else result[key] = [existing, value]
    } else {
      result[key] = value
    }
  }
  return result
}
EOF

  cat > "$dir/src/HttpClient.ts" <<'EOF'
export interface RequestConfig {
  url: string
  method?: string
  headers?: Record<string, string>
}

type Interceptor = (config: RequestConfig) => RequestConfig

export class HttpClient {
  private interceptors: Interceptor[] = []

  addInterceptor(fn: Interceptor): void {
    this.interceptors.push(fn)
  }

  async request(config: RequestConfig): Promise<unknown> {
    let finalConfig = config
    for (const interceptor of this.interceptors) {
      finalConfig = interceptor(finalConfig)
    }
    return fetch(finalConfig.url, {
      method: finalConfig.method ?? 'GET',
      headers: finalConfig.headers,
    })
  }
}
EOF

  git -C "$dir" add -A
  git -C "$dir" commit -m "fix: parseHeaders duplicates, add interceptors, fix deps" --quiet
  local fix_commit=$(git -C "$dir" rev-parse HEAD)

  echo "ts-http base=$base_commit fix=$fix_commit"
}

# =========================================================================
# 5. ts-string
# =========================================================================
create_ts_string() {
  local dir="$REPO_ROOT/ts-string"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/tests"

  make_package_json "ts-string" > "$dir/package.json"
  make_tsconfig > "$dir/tsconfig.json"
  make_vitest_config > "$dir/vitest.config.ts"
  make_vitest_holdout_config > "$dir/vitest.holdout.config.ts"

  cat > "$dir/src/truncate.ts" <<'EOF'
export function truncate(str: string, maxLen: number): string {
  // BUG: uses string.length which counts UTF-16 code units, not characters
  if (str.length <= maxLen) return str
  return str.slice(0, maxLen) + '...'
}
EOF

  cat > "$dir/src/padStart.ts" <<'EOF'
export function padStart(str: string, targetLen: number, padStr = ' '): string {
  // BUG: throws RangeError on negative targetLen
  return str.padStart(targetLen, padStr)
}
EOF

  cat > "$dir/src/template.ts" <<'EOF'
export function template(str: string, vars: Record<string, string>): string {
  // Uses regex replace — refactor target
  return str.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '')
}
EOF

  cat > "$dir/src/slugify.ts" <<'EOF'
export function slugify(str: string): string {
  // BUG: strips all non-ASCII characters
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { truncate } from './truncate.js'
export { padStart } from './padStart.js'
export { template } from './template.js'
export { slugify } from './slugify.js'
EOF

  cat > "$dir/tests/truncate.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { truncate } from '../src/truncate.js'

describe('truncate', () => {
  it('truncates long strings', () => {
    expect(truncate('hello world', 5)).toBe('hello...')
  })
  it('does not truncate short strings', () => {
    expect(truncate('hi', 10)).toBe('hi')
  })
  it('handles multi-byte characters', () => {
    expect(truncate('👋👋👋👋', 2)).toBe('👋👋...')
  })
})
EOF

  cat > "$dir/tests/padStart.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { padStart } from '../src/padStart.js'

describe('padStart', () => {
  it('pads a string', () => {
    expect(padStart('5', 3, '0')).toBe('005')
  })
  it('returns empty string for negative length', () => {
    expect(padStart('test', -1)).toBe('')
  })
})
EOF

  cat > "$dir/tests/slugify.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { slugify } from '../src/slugify.js'

describe('slugify', () => {
  it('slugifies simple text', () => {
    expect(slugify('Hello World!')).toBe('hello-world')
  })
  it('handles accented characters', () => {
    expect(slugify('café résumé')).toBe('cafe-resume')
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/truncate.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { truncate } from '../src/truncate.js'

describe('truncate holdout', () => {
  it('handles mixed ASCII and emoji', () => {
    expect(truncate('ab👋cd', 3)).toBe('ab👋...')
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/slugify.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { slugify } from '../src/slugify.js'

describe('slugify holdout', () => {
  it('handles German umlauts', () => {
    expect(slugify('Müller Straße')).toBe('muller-strasse')
  })
})
EOF

  init_repo "$dir"
  local base_commit=$(git -C "$dir" rev-parse HEAD)

  # Apply fixes
  cat > "$dir/src/truncate.ts" <<'EOF'
export function truncate(str: string, maxLen: number): string {
  const chars = Array.from(str)
  if (chars.length <= maxLen) return str
  return chars.slice(0, maxLen).join('') + '...'
}
EOF

  cat > "$dir/src/padStart.ts" <<'EOF'
export function padStart(str: string, targetLen: number, padStr = ' '): string {
  if (targetLen < 0) return ''
  return str.padStart(targetLen, padStr)
}
EOF

  cat > "$dir/src/template.ts" <<'EOF'
export function template(str: string, vars: Record<string, string>): string {
  const parts = str.split(/(\{\w+\})/g)
  return parts.map(part => {
    const match = part.match(/^\{(\w+)\}$/)
    if (match) return vars[match[1]] ?? ''
    return part
  }).join('')
}
EOF

  cat > "$dir/src/slugify.ts" <<'EOF'
export function slugify(str: string): string {
  const transliterate = (s: string): string => {
    const map: Record<string, string> = {
      'à': 'a', 'á': 'a', 'â': 'a', 'ä': 'a', 'å': 'a',
      'è': 'e', 'é': 'e', 'ê': 'e', 'ë': 'e',
      'ì': 'i', 'í': 'i', 'î': 'i', 'ï': 'i',
      'ò': 'o', 'ó': 'o', 'ô': 'o', 'ö': 'o',
      'ù': 'u', 'ú': 'u', 'û': 'u', 'ü': 'u',
      'ñ': 'n', 'ç': 'c',
      'ß': 'ss',
    }
    return s.replace(/[àáâäåèéêëìíîïòóôöùúûüñçß]/g, c => map[c] ?? c)
  }
  return transliterate(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
EOF

  git -C "$dir" add -A
  git -C "$dir" commit -m "fix: truncate multi-byte, padStart negative, slugify unicode, refactor template" --quiet
  local fix_commit=$(git -C "$dir" rev-parse HEAD)

  echo "ts-string base=$base_commit fix=$fix_commit"
}

# =========================================================================
# 6. ts-state
# =========================================================================
create_ts_state() {
  local dir="$REPO_ROOT/ts-state"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/tests"

  make_package_json "ts-state" > "$dir/package.json"
  make_tsconfig > "$dir/tsconfig.json"
  make_vitest_config > "$dir/vitest.config.ts"
  make_vitest_holdout_config > "$dir/vitest.holdout.config.ts"

  cat > "$dir/src/Store.ts" <<'EOF'
type Listener<S> = (state: S) => void

export class Store<S> {
  private state: S
  private listeners: Listener<S>[] = []

  constructor(initialState: S) {
    this.state = initialState
  }

  getState(): S { return this.state }

  setState(updater: (state: S) => S): void {
    this.state = updater(this.state)
    // BUG: doesn't return unsubscribe function
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  subscribe(listener: Listener<S>): void {
    this.listeners.push(listener)
  }
}
EOF

  cat > "$dir/src/types.ts" <<'EOF'
// BUG: Reducer type doesn't accept undefined initial state
export type Reducer<S, A> = (state: S, action: A) => S
EOF

  # Source file that uses Reducer with undefined — fails at base, passes at fix
  cat > "$dir/src/createStore.ts" <<'EOF'
import type { Reducer } from './types.js'

export function createStore<S, A>(reducer: Reducer<S, A>, initial: S | undefined): S {
  return reducer(initial, {} as A)
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { Store } from './Store.js'
export type { Reducer } from './types.js'
export { createStore } from './createStore.js'
EOF

  # Type-level test that fails at base (Reducer doesn't accept undefined)
  cat > "$dir/tests/types.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import type { Reducer } from '../src/types.js'

// This test verifies the Reducer type accepts undefined initial state.
// At the base commit, the Reducer type is (state: S, action: A) => S
// which does not accept undefined, causing a type error.
interface State { count: number }
type Action = { type: 'increment' } | { type: 'reset' }

const reducer: Reducer<State, Action> = (state, action) => {
  if (state === undefined) return { count: 0 }
  switch (action.type) {
    case 'increment': return { count: state.count + 1 }
    case 'reset': return { count: 0 }
  }
}

describe('Reducer type', () => {
  it('accepts undefined initial state', () => {
    expect(reducer(undefined, { type: 'increment' })).toEqual({ count: 0 })
  })

  it('handles actions with defined state', () => {
    expect(reducer({ count: 5 }, { type: 'increment' })).toEqual({ count: 6 })
  })
})
EOF

  cat > "$dir/tests/Store.test.ts" <<'EOF'
import { describe, it, expect, vi } from 'vitest'
import { Store } from '../src/Store.js'

describe('Store', () => {
  it('gets initial state', () => {
    const store = new Store({ count: 0 })
    expect(store.getState()).toEqual({ count: 0 })
  })

  it('updates state', () => {
    const store = new Store({ count: 0 })
    store.setState(s => ({ count: s.count + 1 }))
    expect(store.getState()).toEqual({ count: 1 })
  })

  it('notifies subscribers', () => {
    const store = new Store({ count: 0 })
    const listener = vi.fn()
    store.subscribe(listener)
    store.setState(s => ({ count: s.count + 1 }))
    expect(listener).toHaveBeenCalledWith({ count: 1 })
  })

  it('returns unsubscribe function', () => {
    const store = new Store({ count: 0 })
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
    store.setState(s => ({ count: s.count + 1 }))
    expect(listener).not.toHaveBeenCalled()
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/Store.holdout.test.ts" <<'EOF'
import { describe, it, expect, vi } from 'vitest'
import { Store } from '../src/Store.js'

describe('Store holdout', () => {
  it('supports multiple subscribers with independent unsubscribe', () => {
    const store = new Store({ value: 0 })
    const l1 = vi.fn(), l2 = vi.fn()
    const unsub1 = store.subscribe(l1)
    store.subscribe(l2)
    store.setState(s => ({ value: s.value + 1 }))
    expect(l1).toHaveBeenCalledTimes(1)
    expect(l2).toHaveBeenCalledTimes(1)
    unsub1()
    store.setState(s => ({ value: s.value + 1 }))
    expect(l1).toHaveBeenCalledTimes(1)
    expect(l2).toHaveBeenCalledTimes(2)
  })
})
EOF

  init_repo "$dir"
  local base_commit=$(git -C "$dir" rev-parse HEAD)

  # Apply fixes
  cat > "$dir/src/Store.ts" <<'EOF'
type Listener<S> = (state: S) => void

export class Store<S> {
  private state: S
  private listeners: Listener<S>[] = []

  constructor(initialState: S) {
    this.state = initialState
  }

  getState(): S { return this.state }

  setState(updater: (state: S) => S): void {
    this.state = updater(this.state)
    for (const listener of this.listeners) {
      listener(this.state)
    }
  }

  subscribe(listener: Listener<S>): () => void {
    this.listeners.push(listener)
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener)
    }
  }
}
EOF

  cat > "$dir/src/types.ts" <<'EOF'
export type Reducer<S, A> = (state: S | undefined, action: A) => S
EOF

  # Add createSelector
  cat > "$dir/src/selector.ts" <<'EOF'
type Selector<S, R> = (state: S) => R

export function createSelector<S, R>(
  inputs: Selector<S, unknown>[],
  resultFn: (...args: unknown[]) => R,
): Selector<S, R> {
  let lastInputs: unknown[] = []
  let lastResult: R | undefined
  let hasCached = false
  return (state: S): R => {
    const currentInputs = inputs.map(fn => fn(state))
    if (hasCached && currentInputs.every((v, i) => Object.is(v, lastInputs[i]))) {
      return lastResult as R
    }
    lastInputs = currentInputs
    lastResult = resultFn(...currentInputs)
    hasCached = true
    return lastResult
  }
}
EOF

  cat > "$dir/tests/selector.test.ts" <<'EOF'
import { describe, it, expect, vi } from 'vitest'
import { createSelector } from '../src/selector.js'

describe('createSelector', () => {
  it('memoizes results', () => {
    const resultFn = vi.fn((a: number, b: number) => a + b)
    const selector = createSelector(
      [(s: { x: number }) => s.x, (s: { y: number }) => s.y],
      resultFn,
    )
    const state = { x: 1, y: 2 }
    expect(selector(state)).toBe(3)
    expect(selector(state)).toBe(3)
    expect(resultFn).toHaveBeenCalledTimes(1)
  })

  it('recomputes when inputs change', () => {
    const resultFn = vi.fn((a: number) => a * 2)
    const selector = createSelector(
      [(s: { x: number }) => s.x],
      resultFn,
    )
    expect(selector({ x: 1 })).toBe(2)
    expect(selector({ x: 2 })).toBe(4)
    expect(resultFn).toHaveBeenCalledTimes(2)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/selector.holdout.test.ts" <<'EOF'
import { describe, it, expect, vi } from 'vitest'
import { createSelector } from '../src/selector.js'

describe('createSelector holdout', () => {
  it('handles multiple input selectors', () => {
    const resultFn = vi.fn((a: number, b: number, c: number) => a + b + c)
    const selector = createSelector(
      [
        (s: { x: number }) => s.x,
        (s: { y: number }) => s.y,
        (s: { z: number }) => s.z,
      ],
      resultFn,
    )
    expect(selector({ x: 1, y: 2, z: 3 })).toBe(6)
    expect(selector({ x: 1, y: 2, z: 3 })).toBe(6)
    expect(resultFn).toHaveBeenCalledTimes(1)
  })
})
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { Store } from './Store.js'
export type { Reducer } from './types.js'
export { createSelector } from './selector.js'
EOF

  git -C "$dir" add -A
  git -C "$dir" commit -m "fix: Store unsubscribe, Reducer undefined, add createSelector" --quiet
  local fix_commit=$(git -C "$dir" rev-parse HEAD)

  echo "ts-state base=$base_commit fix=$fix_commit"
}

# =========================================================================
# 7. ts-date
# =========================================================================
create_ts_date() {
  local dir="$REPO_ROOT/ts-date"
  rm -rf "$dir"
  mkdir -p "$dir/src" "$dir/tests"

  make_package_json "ts-date" > "$dir/package.json"
  make_tsconfig > "$dir/tsconfig.json"
  make_vitest_config > "$dir/vitest.config.ts"
  make_vitest_holdout_config > "$dir/vitest.holdout.config.ts"

  cat > "$dir/src/format.ts" <<'EOF'
export function formatDate(date: Date, format: string): string {
  // BUG: uses getHours/getMinutes instead of getUTCHours/getUTCMinutes
  // when 'Z' timezone specifier is in the format
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
}
EOF

  cat > "$dir/src/diff.ts" <<'EOF'
export function daysBetween(from: Date, to: Date): number {
  // BUG: divides by fixed 86400000 ms, doesn't account for DST
  const ms = to.getTime() - from.getTime()
  return Math.floor(ms / 86400000)
}
EOF

  cat > "$dir/src/leapYear.ts" <<'EOF'
export function isLeapYear(year: number): boolean {
  // BUG: only checks divisibility by 4
  return year % 4 === 0
}
EOF

  cat > "$dir/src/index.ts" <<'EOF'
export { formatDate } from './format.js'
export { daysBetween } from './diff.js'
export { isLeapYear } from './leapYear.js'
EOF

  cat > "$dir/tests/format.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { formatDate } from '../src/format.js'

describe('formatDate', () => {
  it('formats a date', () => {
    const date = new Date('2024-03-15T14:30:00Z')
    expect(formatDate(date, 'YYYY-MM-DD')).toBe('2024-03-15')
  })

  it('formats with UTC time when Z specifier present', () => {
    const date = new Date('2024-03-15T14:30:00Z')
    const result = formatDate(date, 'YYYY-MM-DDTHH:mmZ')
    expect(result).toBe('2024-03-15T14:30Z')
  })
})
EOF

  cat > "$dir/tests/diff.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { daysBetween } from '../src/diff.js'

describe('daysBetween', () => {
  it('calculates days between two dates', () => {
    expect(daysBetween(new Date('2024-01-01'), new Date('2024-01-05'))).toBe(4)
  })

  it('handles dates spanning a month boundary', () => {
    expect(daysBetween(new Date('2024-01-30'), new Date('2024-02-02'))).toBe(3)
  })

  it('handles dates spanning a DST spring-forward transition', () => {
    // 2024-03-09 to 2024-03-11 spans US DST spring-forward (Mar 10).
    // A naive ms/86400000 calculation yields 1.958 days → floor = 1 instead of 2.
    expect(daysBetween(new Date('2024-03-09T00:00:00'), new Date('2024-03-11T00:00:00'))).toBe(2)
  })
})
EOF

  cat > "$dir/tests/leapYear.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { isLeapYear } from '../src/leapYear.js'

describe('isLeapYear', () => {
  it('identifies leap years divisible by 4', () => {
    expect(isLeapYear(2024)).toBe(true)
  })

  it('identifies non-leap years not divisible by 4', () => {
    expect(isLeapYear(2023)).toBe(false)
  })

  it('rejects 1900 (divisible by 100 but not 400)', () => {
    expect(isLeapYear(1900)).toBe(false)
  })

  it('accepts 2000 (divisible by 400)', () => {
    expect(isLeapYear(2000)).toBe(true)
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/format.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { formatDate } from '../src/format.js'

describe('formatDate holdout', () => {
  it('formats UTC midnight', () => {
    const date = new Date('2024-06-15T00:00:00Z')
    expect(formatDate(date, 'YYYY-MM-DDTHH:mmZ')).toBe('2024-06-15T00:00Z')
  })
})
EOF

  mkdir -p "$HOLDOUT_ROOT/$(basename "$dir")" && cat > "$HOLDOUT_ROOT/$(basename "$dir")/leapYear.holdout.test.ts" <<'EOF'
import { describe, it, expect } from 'vitest'
import { isLeapYear } from '../src/leapYear.js'

describe('isLeapYear holdout', () => {
  it('rejects 2100 (divisible by 100 but not 400)', () => {
    expect(isLeapYear(2100)).toBe(false)
  })
  it('accepts 2400 (divisible by 400)', () => {
    expect(isLeapYear(2400)).toBe(true)
  })
})
EOF

  init_repo "$dir"
  local base_commit=$(git -C "$dir" rev-parse HEAD)

  # Apply fixes
  cat > "$dir/src/format.ts" <<'EOF'
export function formatDate(date: Date, format: string): string {
  const useUTC = format.includes('Z')
  const year = useUTC ? date.getUTCFullYear() : date.getFullYear()
  const month = String((useUTC ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, '0')
  const day = String(useUTC ? date.getUTCDate() : date.getDate()).padStart(2, '0')
  const hours = String(useUTC ? date.getUTCHours() : date.getHours()).padStart(2, '0')
  const minutes = String(useUTC ? date.getUTCMinutes() : date.getMinutes()).padStart(2, '0')
  return format
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', day)
    .replace('HH', hours)
    .replace('mm', minutes)
}
EOF

  cat > "$dir/src/diff.ts" <<'EOF'
export function daysBetween(from: Date, to: Date): number {
  // Use UTC dates to avoid DST issues
  const fromUtc = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate())
  const toUtc = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate())
  return Math.round((toUtc - fromUtc) / 86400000)
}
EOF

  cat > "$dir/src/leapYear.ts" <<'EOF'
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}
EOF

  git -C "$dir" add -A
  git -C "$dir" commit -m "fix: formatDate UTC, daysBetween DST, isLeapYear formula" --quiet
  local fix_commit=$(git -C "$dir" rev-parse HEAD)

  echo "ts-date base=$base_commit fix=$fix_commit"
}

# =========================================================================
# Main
# =========================================================================
echo "Creating Batch A repositories under $REPO_ROOT..."
create_ts_utils
create_ts_validate
create_ts_collections
create_ts_http
create_ts_string
create_ts_state
create_ts_date
echo "Done."
