import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { spanAt, objectMembers, applyInsertions } from '../src/json-span.js';

const fixturesDir = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const fixture = (name) => readFileSync(fixturesDir + name, 'utf8');

const CASES = fixture('synthetic/ui-number-cases.synthetic.json');
const LOAD_V3 = fixture('synthetic/hybrid-get-v3.json');
const TRIM_CASES = fixture('synthetic/trim-cases.synthetic.json');

/** The span the scanner reports must parse to the value the parser reports. */
const valueAt = (text, path) => {
  const span = spanAt(text, path);
  return span ? JSON.parse(text.slice(span.start, span.end)) : null;
};

const parsedAt = (text, path) =>
  path.reduce((node, segment) => node[segment], JSON.parse(text));

describe('spanAt agrees with the parser about where every value is', () => {
  for (const [label, text, paths] of [
    ['load v3', LOAD_V3, [[], ['actions'], ['actions', '1'], ['actions', '3'], ['name']]],
    ['ui-number cases', CASES, [[], ['actions'], ['actions', '20'], ['firstActionId']]],
    ['trim cases', TRIM_CASES, [[], ['actions']]],
  ]) {
    for (const path of paths) {
      it(`${label}: $.${path.join('.') || '(root)'}`, () => {
        expect(valueAt(text, path)).toEqual(parsedAt(text, path));
      });
    }
  }

  it('walks through array indices as well as keys', () => {
    const text = '{"results":[{"a":1},{"b":{"c":[10,20]}}]}';
    expect(valueAt(text, ['results', 1, 'b', 'c', 1])).toBe(20);
    expect(valueAt(text, ['results', 0])).toEqual({ a: 1 });
  });

  it('is not fooled by braces, brackets, or quotes inside strings', () => {
    const text = '{"a":"{[\\"}]","b":{"c":"}}}"},"d":2}';
    expect(valueAt(text, ['a'])).toBe('{["}]');
    expect(valueAt(text, ['b', 'c'])).toBe('}}}');
    expect(valueAt(text, ['d'])).toBe(2);
  });

  it('is not fooled by a trailing escaped backslash', () => {
    // The string ends in a backslash, so the closing quote is real. Treating
    // the backslash as escaping the quote would run the scanner off the end.
    const text = '{"a":"C:\\\\","b":1}';
    expect(JSON.parse(text).a).toBe('C:\\');
    expect(valueAt(text, ['a'])).toBe('C:\\');
    expect(valueAt(text, ['b'])).toBe(1);
  });

  it('handles the scalar forms and every whitespace shape', () => {
    const text = '{\n  "n": -1.5e10 ,\n\t"t": true,\r\n "z": null,\n "s": "x"\n}';
    expect(valueAt(text, ['n'])).toBe(-1.5e10);
    expect(valueAt(text, ['t'])).toBe(true);
    expect(valueAt(text, ['z'])).toBe(null);
    expect(valueAt(text, ['s'])).toBe('x');
  });

  it('reads a unicode escape without losing the closing quote', () => {
    const text = '{"a":"\\u0022}\\u007b","b":1}';
    expect(valueAt(text, ['a'])).toBe(JSON.parse(text).a);
    expect(valueAt(text, ['b'])).toBe(1);
  });

  it('returns null for a path that is not there', () => {
    expect(spanAt('{"a":1}', ['b'])).toBeNull();
    expect(spanAt('{"a":1}', ['a', 'b'])).toBeNull();
    expect(spanAt('{"a":[1]}', ['a', 4])).toBeNull();
    expect(spanAt(null, ['a'])).toBeNull();
  });

  it('refuses a repeated key rather than picking one', () => {
    // JSON.parse keeps the last, this scanner would see the first, and a
    // disagreement about which value is real must stop the caller.
    expect(spanAt('{"a":1,"a":2}', ['a'])).toBeNull();
  });
});

describe('objectMembers', () => {
  it('lists members in document order, not sorted', () => {
    const text = '{"20":{"x":1},"3":{"y":2},"a":{}}';
    expect(objectMembers(text, 0).map((m) => m.key)).toEqual(['20', '3', 'a']);
    // The parser would have reordered those numeric keys.
    expect(Object.keys(JSON.parse(text))).toEqual(['3', '20', 'a']);
  });

  it('reports an empty object as having no members', () => {
    expect(objectMembers('{}', 0)).toEqual([]);
    expect(objectMembers('{  }', 0)).toEqual([]);
  });

  it('returns null when asked to read something that is not an object', () => {
    expect(objectMembers('[1,2]', 0)).toBeNull();
    expect(objectMembers('"x"', 0)).toBeNull();
  });

  it('gives spans that slice out to the exact member values', () => {
    const text = '{ "a" : { "b" : [1, 2] } , "c" : "d" }';
    const members = objectMembers(text, 0);
    expect(members.map((m) => text.slice(m.valueStart, m.valueEnd))).toEqual([
      '{ "b" : [1, 2] }',
      '"d"',
    ]);
  });
});

describe('applyInsertions', () => {
  it('applies back to front so every offset still means what it meant', () => {
    const text = '{"a":1,"b":2}';
    const output = applyInsertions(text, [
      { at: 6, text: ',"x":0' },
      { at: 12, text: ',"y":0' },
    ]);
    expect(output).toBe('{"a":1,"x":0,"b":2,"y":0}');
    expect(JSON.parse(output)).toEqual({ a: 1, x: 0, b: 2, y: 0 });
  });

  it('is the identity when there is nothing to insert', () => {
    expect(applyInsertions(LOAD_V3, [])).toBe(LOAD_V3);
  });
});
