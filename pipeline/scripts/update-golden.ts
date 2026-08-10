/**
 * Regenerate one golden fixture and print it as a TypeScript module on stdout.
 * Driven by scripts/update-golden.sh, which redirects the output into test/golden/<name>.ts.
 *
 * Usage (via the shell wrapper): GOLDEN_CASE=straight-eighths jsc ... update-golden.js
 */

import { buildScore } from '../src/buildScore.js';
import { GOLDEN_CASES } from '../test/goldenCases.js';

declare function print(s: string): void;
declare const GOLDEN_CASE_NAME: string | undefined;

const name = typeof GOLDEN_CASE_NAME === 'string' ? GOLDEN_CASE_NAME : '';
const testCase = GOLDEN_CASES.find((c) => c.name === name);
if (!testCase) throw new Error(`unknown golden case ${JSON.stringify(name)}`);

const xml = buildScore(testCase.input, testCase.settings).toMusicXML();
const escaped = xml.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

print(`/** GENERATED golden fixture for the "${testCase.name}" case — regenerate with`);
print(` *  scripts/update-golden.sh ${testCase.name}`);
print(' *  Do not edit by hand: a diff here is a real behaviour change and wants review. */');
print('');
print('export default `' + escaped + '`;');
