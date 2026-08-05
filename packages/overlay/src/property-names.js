// Turning HubSpot's property metadata into a label lookup. Pure: strings in,
// index out, no DOM and no chrome.*, so every rule here is testable in Vitest's
// node environment.
//
// WHY THIS EXISTS
//
// Two card types render properties and put no internal name in the page at all:
// PROPERTIES_LIST ("Contact profile") and DATA_HIGHLIGHTS ("Data highlights").
// Their rows carry a generic id, a per-render counter, and the human label. The
// name is genuinely absent, confirmed by enumerating every attribute on every
// row, searching inline scripts for bootstrapped config, and searching all 245
// window globals.
//
// The label is therefore the only handle those cards offer, and HubSpot already
// fetches the map that resolves it:
//
//   GET /api/properties/v{n}/groups/{objectTypeId}/properties
//
// 325 contact properties on the portal this was read against, each carrying
// `name` and `label`.
//
// WHY A LABEL LOOKUP IS ALLOWED TO BE ONE SOURCE
//
// ADR-009 called label keying "strictly worse, because labels are not unique",
// and it was right to be suspicious. Measured rather than assumed: on a real
// portal exactly ONE label out of 325 is duplicated. More importantly, a
// duplicate is DETECTABLE. A label resolving to two names is not a coin flip we
// take, it is a row we skip.
//
// So this satisfies ADR-010's rule the same way the prefixed surfaces do. The
// question is never "how many sources", it is "can this produce a confident
// wrong answer". Here it cannot: not found and ambiguous both withdraw, and the
// failure is a missing line.
//
// Matching is case and whitespace insensitive, which is not a convenience
// either. The card renders "Company name" while the property is labelled
// "Company Name". Exact matching resolved 3 of 6 rows on a live card; folding
// case resolved 6 of 6.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { nameProblem, refuse } from './test-id.js';

/** A label that resolves to more than one property. Stored, not dropped. */
const AMBIGUOUS = null;

/**
 * The lookup key for a label.
 *
 * Case folded and whitespace collapsed. HubSpot renders a card label that
 * differs from the property's own label in casing, and treating those as
 * different strings costs real rows for no safety: a case fold cannot turn one
 * property into another, it can only merge two labels that differ in case, and
 * that merge is caught as ambiguity rather than guessed at.
 */
export function labelKey(label) {
  if (typeof label !== 'string') return null;
  const key = label.replace(/\s+/g, ' ').trim().toLowerCase();
  return key === '' ? null : key;
}

/**
 * Build the label index from a properties response body.
 *
 * The shape, observed live: an array of groups, each with propertyDefinitions,
 * each of those wrapping the property itself one level down. Tolerates the
 * response being wrapped in `results`, because a paging envelope appearing later
 * should cost a lookup rather than the feature.
 *
 * @returns {{ok: true, index: Map<string, string|null>, properties: number}
 *   | {ok: false, reason: string}}
 */
export function parsePropertyNames(text) {
  if (typeof text !== 'string' || text === '') return refuse('empty-body');

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return refuse('not-json');
  }

  const groups = Array.isArray(data) ? data : Array.isArray(data && data.results) ? data.results : null;
  if (!groups) return refuse('unrecognized-shape');

  const index = new Map();
  let properties = 0;

  for (const group of groups) {
    const definitions = group && Array.isArray(group.propertyDefinitions) ? group.propertyDefinitions : [];
    for (const definition of definitions) {
      const property = definition && definition.property;
      if (!property || typeof property.name !== 'string' || typeof property.label !== 'string') continue;
      // The same plausibility rules the rest of the package uses. A name with
      // whitespace in it is not a name, wherever it came from.
      if (nameProblem(property.name)) continue;

      const key = labelKey(property.label);
      if (key === null) continue;

      properties += 1;
      if (!index.has(key)) {
        index.set(key, property.name);
      } else if (index.get(key) !== property.name) {
        index.set(key, AMBIGUOUS);
      }
    }
  }

  // A response that parses but yields nothing is a shape change, not an empty
  // portal: every object type has properties.
  if (properties === 0) return refuse('no-properties');

  return { ok: true, index, properties };
}

/**
 * Resolve one rendered label to one internal name.
 *
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function lookupPropertyName(index, label) {
  if (!index || typeof index.get !== 'function') return refuse('no-index');

  const key = labelKey(label);
  if (key === null) return refuse('empty-label');

  if (!index.has(key)) return refuse('label-not-found');

  const name = index.get(key);
  // The whole reason one source is enough here. Two properties sharing a label
  // is a row we decline, never a name we pick.
  if (name === AMBIGUOUS) return refuse('label-ambiguous');

  return { ok: true, propertyName: name };
}
