# Fixtures

Two directories, one rule between them.

## `synthetic/`

Everything committed. **No value in here came from a live portal.**

| File | What it models |
|---|---|
| `hybrid-get-v3.json` | `GET /hybrid/{flowId}` on editor load, three actions, version 3 |
| `save-response-v4.json` | the same flow after adding an email notification, version 4 |
| `refresh-response-v4.json` | a Refresh taken immediately after that save |
| `trim-cases.synthetic.json` | a workflow that could not exist, covering every trim rule and every retraction |
| `ui-number-cases.synthetic.json` | a graph built so every wrong traversal produces a different numbering |

The first three are **scrubbed copies** of real captures: structure, key order,
and HubSpot vocabulary are exactly as returned, while every identifier and every
piece of authored content was replaced with a synthetic stand-in, consistently
across all three so cross-file relationships still hold. The last two are
entirely hand-authored. See `synthetic/README.md`.

Because scrubbing changes lengths, **never assert a hardcoded byte count against
a fixture.** Measure it from the file.

## `private/`

Gitignored, empty in a fresh clone. Real captures go here: unscrubbed trial
portals, and **client portals, which are never committed under any
circumstances.**

`trim.test.js` runs its assertions against whatever it finds here and skips
silently when the directory is empty. That is how the rules get validated at real
scale locally without portal data reaching a public repo.

## The guard

`npm run check:no-portal-data` fails the build if any committed file contains a
six-or-more-digit number that is not on an explicit allowlist of synthetic values,
or a `hubspot.com` URL carrying one.

It is an allowlist rather than a blocklist on purpose: a fresh capture dropped
into `synthetic/` without scrubbing fails immediately, even though nobody could
have predicted what its identifiers would be. It runs in CI on every push.
