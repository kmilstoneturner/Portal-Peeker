# Fixtures

Two directories, one rule between them.

## `synthetic/`

Everything committed. **No value in here came from a live portal.**

| File | What it models |
|---|---|
| `hybrid-get-v3.json` | `GET /hybrid/{flowId}` on editor load, three actions, version 3 |
| `save-response-v4.json` | the same flow after adding an email notification, version 4 |
| `refresh-response-v4.json` | a Refresh taken immediately after that save |
| `inbounddb-list-get.json` | `GET /inbounddb-lists/v1/lists/{listId}`: a segment definition |
| `inbounddb-list-getbatch.json` | the hydration response holding the lists that segment references |
| `crm-objects-batch-contact.json` | `GET /crm-objects/{type}/batch`: a contact record, name table resolvable |
| `crm-objects-batch-custom.json` | the same endpoint on a portal-defined custom object, unknown type |
| `record-duplicate-key.synthetic.json` | a record carrying a literal duplicate JSON key, as HubSpot has emitted |
| `trim-cases.synthetic.json` | a workflow that could not exist, covering every trim rule and every retraction |
| `ui-number-cases.synthetic.json` | a graph built so every wrong traversal produces a different numbering |

All but the last three are **scrubbed copies** of real captures: structure, key
order, and HubSpot vocabulary are exactly as returned, while every identifier and
every piece of authored content was replaced with a synthetic stand-in,
consistently across files so cross-file relationships still hold. The last three
are hand-authored. See `synthetic/README.md`.

**Never reformat a fixture.** The observed key order, whitespace, and (in the
duplicate-key fixture) a literal repeated key are part of what they test, and a
round trip through a JSON formatter destroys exactly that. For the same reason,
because scrubbing changes lengths, **never assert a hardcoded byte count against
a fixture.** Measure it from the file.

## `private/`

Gitignored, empty in a fresh clone. Real captures go here: unscrubbed trial
portals, and **client portals, which are never committed under any
circumstances.**

`trim.test.js` runs its assertions against whatever it finds here and skips
silently when the directory is empty. That is how the rules get validated at real
scale locally without portal data reaching a public repo.

One naming convention: record captures dropped here must be named
`record-*.json`. `record-trim.test.js` runs its subtractive property against
those, and `trim.test.js` skips them, because the workflow trim rightly refuses
a record and a refusal in that loop would read as a break.

## The guard

`npm run check:no-portal-data` fails the build if any committed file contains a
six-or-more-digit number that is not on an explicit allowlist of synthetic values,
or a `hubspot.com` URL carrying one.

It is an allowlist rather than a blocklist on purpose: a fresh capture dropped
into `synthetic/` without scrubbing fails immediately, even though nobody could
have predicted what its identifiers would be. It runs in CI on every push.

Know what it does **not** catch: it keys on digit runs, so email addresses,
UUIDs, region hostnames, and authored text (names, subjects, bodies) pass it
untouched. Those are scrubbed by hand and checked by eye; the guard is a
backstop for identifiers, not a scrubber.
