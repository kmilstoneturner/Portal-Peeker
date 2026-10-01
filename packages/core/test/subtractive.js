// The ADR-005 property both trims are judged by, in one place so the workflow
// and record suites can never drift apart on what "subtractive" means.
//
// Every leaf in the output must exist in the input at the same path with an
// identical value. Removal only: nothing renamed, restructured, reordered
// within an object, or inflated.

import { expect } from 'vitest';

/**
 * Assert output is a subtractive projection of input.
 *
 * Arrays are matched by content rather than index, because a rule may filter
 * one (inputValueFields), which shifts indices without changing any value.
 */
export function assertSubtractive(input, output, path = '$') {
  if (output === null || typeof output !== 'object') {
    expect(output, `value changed at ${path}`).toEqual(input);
    return;
  }
  if (Array.isArray(output)) {
    expect(Array.isArray(input), `array became non-array at ${path}`).toBe(true);
    for (const [index, item] of output.entries()) {
      const match = input.find((candidate) => containsSubtree(candidate, item));
      expect(match, `output array item ${path}[${index}] is not present in the input`).toBeDefined();
      assertSubtractive(match, item, `${path}[${index}]`);
    }
    return;
  }
  expect(input && typeof input === 'object' && !Array.isArray(input), `shape changed at ${path}`).toBe(true);
  for (const [key, value] of Object.entries(output)) {
    expect(Object.hasOwn(input, key), `output key ${path}.${key} does not exist in the input`).toBe(true);
    assertSubtractive(input[key], value, `${path}.${key}`);
  }
}

function containsSubtree(input, output) {
  if (output === null || typeof output !== 'object') return input === output;
  if (Array.isArray(output)) {
    if (!Array.isArray(input)) return false;
    return output.every((item) => input.some((candidate) => containsSubtree(candidate, item)));
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  return Object.entries(output).every(
    ([key, value]) => Object.hasOwn(input, key) && containsSubtree(input[key], value),
  );
}
