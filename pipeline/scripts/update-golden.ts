/**
 * Regenerate one golden fixture and print it as a TypeScript module on stdout.
 * Driven by scripts/update-golden.sh, which redirects the output into test/golden/<name>.ts.
 *
 * Usage (via the shell wrapper): GOLDEN_CASE=straight-eighths jsc ... update-golden.js
 */

import { buildScore } from '../src/buildScore.js';
import { buildMultiPartScore } from '../src/multipart.js';
import { GOLDEN_CASES, MULTI_PART_GOLDEN_CASES } from '../test/goldenCases.js';

declare function print(s: string): void;
declare const GOLDEN_CASE_NAME: string | undefined;

const name = typeof GOLDEN_CASE_NAME === 'string' ? GOLDEN_CASE_NAME : '';
const testCase = GOLDEN_CASES.find((c) => c.name === name);
const multiCase = MULTI_PART_GOLDEN_CASES.find((c) => c.name === name);
if (!testCase && !multiCase) throw new Error(`unknown golden case ${JSON.stringify(name)}`);

// The alphaTab hand-off is JSON, not text, so its fixture is the JSON — indented one space so a
// diff points at the field that moved rather than at one 40 KB line.
const body = testCase
  ? buildScore(testCase.input, testCase.settings).toMusicXML()
  : multiCase!.emit === 'alphatab'
    ? JSON.stringify(buildMultiPartScore(multiCase!.parts, multiCase!.input, multiCase!.settings).toAlphaTabModelData(), null, 1)
    : buildMultiPartScore(multiCase!.parts, multiCase!.input, multiCase!.settings).toMusicXML();
const escaped = body.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

print(`/** GENERATED golden fixture for the "${name}" case — regenerate with`);
print(` *  scripts/update-golden.sh ${name}`);
print(' *  Do not edit by hand: a diff here is a real behaviour change and wants review. */');
print('');
print('export default `' + escaped + '`;');
