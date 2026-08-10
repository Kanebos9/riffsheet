/**
 * A tiny `vitest` stand-in for JavaScriptCore.
 *
 * WHY THIS EXISTS: the development machine has no Node.js. `scripts/run-tests.sh` bundles the
 * REAL test files with esbuild (a native binary, no node) aliasing `vitest` to this module, and
 * runs the bundle under `jsc` (ships with macOS). The tests are not duplicated or rewritten —
 * the same `test/*.test.ts` files run under `vitest run` on a machine that has Node.
 *
 * Only the matchers the suite actually uses are implemented; anything missing throws loudly
 * rather than silently passing.
 */

declare function print(s: string): void;

interface Case {
  name: string;
  fn: () => void | Promise<void>;
  skip: boolean;
}
interface Suite {
  name: string;
  cases: Case[];
}

const suites: Suite[] = [];
let current: Suite | null = null;

export function describe(name: string, fn: () => void): void {
  const suite: Suite = { name, cases: [] };
  suites.push(suite);
  const prev = current;
  current = suite;
  fn();
  current = prev;
}
describe.skip = (name: string, _fn: () => void): void => {
  suites.push({ name: name + ' (skipped)', cases: [] });
};

export function it(name: string, fn: () => void | Promise<void>): void {
  (current ?? fallbackSuite()).cases.push({ name, fn, skip: false });
}
it.skip = (name: string, fn: () => void | Promise<void>): void => {
  (current ?? fallbackSuite()).cases.push({ name, fn, skip: true });
};
export const test = it;

function fallbackSuite(): Suite {
  if (!suites.length || suites[suites.length - 1].name !== '(top level)') {
    suites.push({ name: '(top level)', cases: [] });
  }
  return suites[suites.length - 1];
}

const beforeAllFns: (() => void)[] = [];
export function beforeAll(fn: () => void): void {
  beforeAllFns.push(fn);
}
export function afterAll(_fn: () => void): void {
  /* not needed by this suite */
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return String(v) + 'n';
  try {
    return JSON.stringify(v, (_k, val) => (val instanceof Map ? [...val] : val)) ?? String(v);
  } catch {
    return String(v);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])) return false;
  }
  return true;
}

class Assertion {
  constructor(
    private readonly actual: unknown,
    private readonly negated = false
  ) {}
  private check(pass: boolean, message: string): void {
    if (pass === this.negated) {
      throw new Error(`${message}${this.negated ? ' (negated)' : ''}`);
    }
  }
  get not(): Assertion {
    return new Assertion(this.actual, !this.negated);
  }
  toBe(expected: unknown): void {
    this.check(Object.is(this.actual, expected), `expected ${stringify(this.actual)} to be ${stringify(expected)}`);
  }
  toEqual(expected: unknown): void {
    this.check(deepEqual(this.actual, expected), `expected ${stringify(this.actual)} to equal ${stringify(expected)}`);
  }
  toStrictEqual(expected: unknown): void {
    this.toEqual(expected);
  }
  toBeCloseTo(expected: number, digits = 2): void {
    const pass = Math.abs((this.actual as number) - expected) < Math.pow(10, -digits) / 2;
    this.check(pass, `expected ${this.actual} to be close to ${expected} (${digits} digits)`);
  }
  toBeGreaterThan(n: number): void {
    this.check((this.actual as number) > n, `expected ${this.actual} > ${n}`);
  }
  toBeGreaterThanOrEqual(n: number): void {
    this.check((this.actual as number) >= n, `expected ${this.actual} >= ${n}`);
  }
  toBeLessThan(n: number): void {
    this.check((this.actual as number) < n, `expected ${this.actual} < ${n}`);
  }
  toBeLessThanOrEqual(n: number): void {
    this.check((this.actual as number) <= n, `expected ${this.actual} <= ${n}`);
  }
  toBeTruthy(): void {
    this.check(!!this.actual, `expected ${stringify(this.actual)} to be truthy`);
  }
  toBeFalsy(): void {
    this.check(!this.actual, `expected ${stringify(this.actual)} to be falsy`);
  }
  toBeDefined(): void {
    this.check(this.actual !== undefined, `expected value to be defined`);
  }
  toBeUndefined(): void {
    this.check(this.actual === undefined, `expected ${stringify(this.actual)} to be undefined`);
  }
  toBeNull(): void {
    this.check(this.actual === null, `expected ${stringify(this.actual)} to be null`);
  }
  toContain(needle: unknown): void {
    const a = this.actual;
    const pass =
      typeof a === 'string' ? a.indexOf(String(needle)) >= 0 : Array.isArray(a) ? a.some((x) => deepEqual(x, needle)) : false;
    this.check(pass, `expected ${stringify(a).slice(0, 200)} to contain ${stringify(needle)}`);
  }
  toMatch(re: RegExp | string): void {
    const pass = typeof re === 'string' ? String(this.actual).indexOf(re) >= 0 : re.test(String(this.actual));
    this.check(pass, `expected ${stringify(this.actual).slice(0, 200)} to match ${String(re)}`);
  }
  toHaveLength(n: number): void {
    const len = (this.actual as { length?: number })?.length;
    this.check(len === n, `expected length ${len} to be ${n}`);
  }
  toThrow(match?: RegExp | string): void {
    let threw = false;
    let msg = '';
    try {
      (this.actual as () => void)();
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    if (match && threw) {
      const ok = typeof match === 'string' ? msg.indexOf(match) >= 0 : match.test(msg);
      this.check(ok, `expected thrown message ${JSON.stringify(msg)} to match ${String(match)}`);
      return;
    }
    this.check(threw, 'expected function to throw');
  }
}

export function expect(actual: unknown): Assertion {
  return new Assertion(actual);
}

export async function runAll(): Promise<void> {
  for (const fn of beforeAllFns) fn();
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const failures: string[] = [];
  for (const suite of suites) {
    if (!suite.cases.length) continue;
    print(`\n  ${suite.name}`);
    for (const c of suite.cases) {
      if (c.skip) {
        skipped++;
        print(`    - ${c.name}`);
        continue;
      }
      try {
        const r = c.fn();
        if (r && typeof (r as Promise<void>).then === 'function') await r;
        passed++;
        print(`    ✓ ${c.name}`);
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        print(`    ✗ ${c.name}`);
        print(`        ${msg.split('\n').join('\n        ')}`);
        failures.push(`${suite.name} > ${c.name}: ${msg.split('\n')[0]}`);
      }
    }
  }
  print(`\n  ${passed} passed, ${failed} failed, ${skipped} skipped\n`);
  if (failed) {
    throw new Error(`${failed} test(s) failed:\n  - ${failures.join('\n  - ')}`);
  }
}
