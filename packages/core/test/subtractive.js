// The ADR-005 property both trims are judged by, in one place so the workflow
// and record suites can never drift apart on what "subtractive" means.
//
// Every leaf in the output must exist in the input at the same path with an
// identical value. Removal only: nothing renamed, restructured, reordered
// within an object, or inflated.
//
// "Reordered" is asserted, not only stated. For a long time it was only
// stated: this helper compared paths and values, the trim moved two keys
// (metadata to the end of each action, updatedAt ahead of updatedBy), and
// nothing noticed, while the context block written into trimmed exports went
// on telling readers that nothing had been reordered. Order is half of what a
// person diffing a trimmed file against a raw one relies on.

import { expect } from 'vitest';

/**
 * Assert output is a subtractive projection of input.
 *
 * Arrays are matched by content rather than index, because a rule may filter
 * one (inputValueFields), which shifts indices without changing any value.
 * The match is looked for after the previous one, so filtering passes and
 * shuffling does not.
 */
export function assertSubtractive(input, output, path = '$') {
  if (output === null || typeof output !== 'object') {
    expect(output, `value changed at ${path}`).toEqual(input);
    return;
  }
  if (Array.isArray(output)) {
    expect(Array.isArray(input), `array became non-array at ${path}`).toBe(true);
    let from = 0;
    for (const [index, item] of output.entries()) {
      const at = input.findIndex(
        (candidate, position) => position >= from && containsSubtree(candidate, item),
      );
      expect(
        at,
        `output array item ${path}[${index}] is not in the input at or after position ${from}`,
      ).not.toBe(-1);
      assertSubtractive(input[at], item, `${path}[${index}]`);
      from = at + 1;
    }
    return;
  }
  expect(input && typeof input === 'object' && !Array.isArray(input), `shape changed at ${path}`).toBe(true);
  for (const [key, value] of Object.entries(output)) {
    expect(Object.hasOwn(input, key), `output key ${path}.${key} does not exist in the input`).toBe(true);
    assertSubtractive(input[key], value, `${path}.${key}`);
  }
  // The keys that survive stand in the order they had. Checked after the loop,
  // so a key that should not exist at all is reported as that, not as order.
  const surviving = Object.keys(input).filter((key) => Object.hasOwn(output, key));
  expect(Object.keys(output), `keys reordered at ${path}`).toEqual(surviving);
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
