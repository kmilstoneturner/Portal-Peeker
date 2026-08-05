// The create-record dialog, as one feature the host can start and stop.
//
// WHY THIS IS NOT AN ENTRY IN SURFACES
//
// record-surfaces.js describes surfaces on ONE record, and record-properties.js
// gates the whole sweep on parseRecordPath: the path names the object being
// shown, and every label surface resolves against that one type. Neither holds
// here.
//
// This dialog opens over an index, a board, or another object's record, so the
// path often has no /record/ segment at all. And the object it creates is
// routinely not the object behind it: the same dialog creates a company from a
// deal's record page. Putting it in that table would mean loosening the
// record-page gate for the surfaces that genuinely need it, to accommodate one
// that never did.
//
// So it is a third feature in overlay.js's registry, which is what the registry
// was for. api-name-node.js is reused whole and test-id.js supplies the prefix
// rule; only finding the fields is new here.
//
// WHERE THIS ACTUALLY RUNS
//
// Inside an iframe, and that is not a detail. HubSpot renders this dialog in a
// same-origin frame at:
//
//   /object-builder/{portalId}/{objectTypeId}/embed
//
// so none of it is in the host page's document. Querying a record page for the
// creator finds nothing at all, and the frame carries none of our CSS. The
// overlay reaches it only because the manifest has a SECOND entry matching that
// frame's own URL with all_frames: true.
//
// Found by walking every frame with a dialog open, which is the only way to find
// it: nav-object-create-ui is the obvious guess by name, is loaded on every CRM
// page, and is NOT the host. It was tried first and had creator=0 with the
// dialog open. It appears to be the "+ Create" menu rather than the dialog.
//
// Do not take the objectTypeId from that frame path. It was 0-1 on a CONTACTS
// list page, which is the host page's object, and the same embed creates a deal
// from there. The editor link below is the thing that names what is being
// created, and it agreed with the form on every field observed.
//
// Two more consequences before changing anything here. A feature that never runs
// is indistinguishable from one nobody switched on, which is why the build now
// fails on any content_scripts entry that does not state all_frames. And the
// property-names interceptor is deliberately absent from that frame: it would
// have nothing to do, because everything below reads a prefixed name.
//
// HOW THE NAME IS READ
//
// NAME_FROM.PREFIX in ADR-010's sense, on a different attribute. Every control
// in the dialog carries data-selenium-test="property-input-{name}", the same
// prefix the record surfaces read off their second source. A prefixed id
// announces what it is and fails safe on its own: rename the prefix and the
// selector matches nothing, which is a missing line and not a wrong one. That is
// why one source is enough, for the same reason it is enough on the highlights
// strip.
//
// Two things deliberately NOT done, both recorded so the next person knows they
// were seen rather than missed:
//
//   The fields also carry data-test-id="{name}-input", a SUFFIXED second source.
//   Requiring the pair to agree buys nothing a prefix has not already bought,
//   and every rule that fires on agreement is a rule that drops real rows the
//   day HubSpot renames one of the two.
//
//   The label's own id is FormControl-property-input-input-40, which contains
//   the prefix and is NOT a name: its tail is the DOM id of the input. It costs
//   nothing to refuse, because afterPrefix requires the value to START with the
//   prefix and this one starts with FormControl-. Worth knowing before anyone
//   relaxes a selector here into a substring match.

// One line each: tools/build.mjs is line based and throws on a wrapped import.
import { afterPrefix, nameProblem, refuse, PROPERTY_INPUT_PREFIX } from './test-id.js';
import { placeApiName, removeApiNames } from './api-name-node.js';

// The dialog body. The <form> itself carries only classes, and classes here are
// styled-components hashes that change on every HubSpot build, so this is the
// only honest scope available.
const CREATOR = '[data-selenium-test="creator"]';

// One field. Every control in the dialog is wrapped in one of these, whether it
// renders a textarea, a plain input, or a dropdown button.
const FIELD = '[data-test-id="FormControl"]';

const NAME_SOURCE = `[data-selenium-test^="${PROPERTY_INPUT_PREFIX}"]`;
const NAME_ATTRIBUTE = 'data-selenium-test';

// Between the label and the control, which is where the settings table and the
// record sidebar both put it. Present on every field observed, including the
// ones the form renders disabled until a name is typed.
const ANCHOR = '[data-test-id="hover-content-wrapper"]';

// "Edit this form" points at the creator editor for the type being created, and
// is the only thing in the dialog that names the object at all.
const EDITOR_LINK = 'a[data-selenium-test="creator-editor-link"]';
const EDITOR_OBJECT_TYPE = /\/creator-editor\/(\d+-\d+)(?:\/|$)/;

/**
 * The property name for one field, or a refusal.
 *
 * Strings in, object out, so the rule is testable without a DOM.
 *
 * Exactly one prefixed control per field, never the first of several. A field
 * holding two is a shape nobody has seen here, and picking one would be a guess:
 * the All properties panel already renders a nested control wearing this exact
 * prefix (property-input-phone-button, inside the fax row), so it is unobserved
 * rather than impossible.
 *
 * @returns {{ok: true, propertyName: string} | {ok: false, reason: string}}
 */
export function readFieldName(values) {
  if (!Array.isArray(values) || values.length === 0) return refuse('no-source');
  if (values.length > 1) return refuse('ambiguous-source');

  const name = afterPrefix(values[0], PROPERTY_INPUT_PREFIX);
  const problem = nameProblem(name);
  if (problem) return refuse(problem === 'no-prefix' ? 'not-a-property-input' : problem);
  return { ok: true, propertyName: name };
}

/**
 * The object type this dialog creates, or null.
 *
 * Read from the form's own link, never from the URL: the URL describes the page
 * BEHIND the dialog, which is a different object as often as not.
 *
 * Null is a normal answer here rather than a failure. The link is an admin
 * affordance and a user without those permissions never sees it, and nothing
 * depends on the answer: the name comes from a prefixed id that identifies
 * itself, and the object type is only carried onto our node as an attribute
 * nothing renders. A label surface could not take that deal, because its whole
 * lookup is keyed by type. This one can.
 */
export function creatorObjectType(href) {
  if (typeof href !== 'string') return null;
  const match = href.match(EDITOR_OBJECT_TYPE);
  return match ? match[1] : null;
}

/** Whether a create dialog is open at all. The host's cheap bail. */
export function createFormPresent(root) {
  if (!root || typeof root.querySelector !== 'function') return false;
  return root.querySelector(CREATOR) !== null;
}

/**
 * Annotate every field that can be read with confidence.
 *
 * Failure is per field, exactly as everywhere else: a field with no API name
 * under it is visibly missing and cannot mislead anyone, and the fields either
 * side of it are still correct.
 *
 * @returns {{inserted: number, skipped: number, fields: number, forms: number}}
 *   skipped counts fields that could not be read or had nowhere to put a name.
 *   A field already carrying the right name is neither: correcting is not
 *   inserting, and it is not a failure either.
 */
export function annotateCreateForm(root) {
  const result = { inserted: 0, skipped: 0, fields: 0, forms: 0 };
  if (!root || typeof root.querySelectorAll !== 'function') return result;

  for (const creator of root.querySelectorAll(CREATOR)) {
    result.forms += 1;

    const link = creator.querySelector(EDITOR_LINK);
    const objectTypeId = creatorObjectType(link ? link.getAttribute('href') : null);

    for (const field of creator.querySelectorAll(FIELD)) {
      result.fields += 1;
      try {
        const values = [...field.querySelectorAll(NAME_SOURCE)].map((node) =>
          node.getAttribute(NAME_ATTRIBUTE),
        );

        const read = readFieldName(values);
        if (!read.ok) {
          result.skipped += 1;
          continue;
        }

        const anchor = field.querySelector(ANCHOR);
        if (!anchor) {
          result.skipped += 1;
          continue;
        }

        if (placeApiName(anchor, read.propertyName, objectTypeId)) result.inserted += 1;
      } catch {
        // One field's worth of surprise is one missing line. It is never allowed
        // to become a broken create dialog for whoever is using this portal.
        result.skipped += 1;
      }
    }
  }

  return result;
}

/** The feature record the host registers. */
export const createFormFeature = {
  id: 'create-form',
  present: createFormPresent,
  annotate: annotateCreateForm,
  remove: removeApiNames,
};
