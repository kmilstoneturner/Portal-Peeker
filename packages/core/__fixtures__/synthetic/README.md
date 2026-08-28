# Synthetic fixtures

Everything committed to the repo lives here. Nothing in this directory contains a
value from a live portal.

## The capture chain

`hybrid-get-v3.json`, `save-response-v4.json`, and `refresh-response-v4.json` are
scrubbed copies of three real captures taken from one flow in a trial portal in a
single sitting. Structure, key order, and HubSpot vocabulary are exactly as
returned; every identifier and every piece of authored content was replaced.

What the chain establishes:

- The refresh capture is byte-identical to the save response, so Refresh returns
  exactly the state the save produced.
- The v3 to v4 step is one action appended and one connection filled in, so the
  diff semantics are unambiguous: seven leaf changes, three semantic and four
  volatile or derived.
- All three notification actions have empty `userIds`, `teamIds`, and
  `ownerProperties`. That is not missing data. Nobody is configured to receive
  them, which is why the trim exempts empty recipient lists from its
  empty-collection rule.

## `inbounddb-list-get.json`

A scrubbed mirror of a real segment (list) capture: the response of
`GET /api/inbounddb-lists/v1/lists/{listId}`, observed live from segments-ui in
August 2026. Structure, key order, and HubSpot vocabulary are exactly as
returned; every identifier, timestamp, uuid, name, and filter value was
replaced.

Its `filterBranch` deliberately carries one of each observed condition shape:
a plain PROPERTY filter, an IN_LIST reference to another list, and an
ASSOCIATION branch that carries its own operator and nests a PROPERTY filter
for the associated object. Three leaves in total, which is what
`countFilters` must report.

## `trim-cases.synthetic.json`

A workflow that could not exist, built so that every trim rule and **every
retraction** has something to bite on in a single fixture. It is entirely
hand-authored, is not a model of a real flow, and must never be used to infer
what HubSpot returns.

It exists because the capture chain above is a small, well-behaved workflow. It
cannot exercise the cases that matter most, which are the ones where a rule must
*not* fire.

Cases encoded, and why each is there:

| Case | Expected | Motivated by |
|---|---|---|
| `filterBranchType: ASSOCIATION` and `UNIFIED_EVENTS` | kept | disagrees with `filterBranchOperator` in 20 of 161 branches of a real 201-action flow |
| `CLASSIC_GOAL_LIST` with unique `filterBranch` | kept | a real flow's goal criteria, 14KB, matches nothing else |
| `ENROLLMENT_LIST` whose `filterBranch` matches enrollment criteria, written in a different key order | dropped | the comparison must be order-insensitive |
| `inputValueFields` with unknown `fieldKey`s | kept | extension action configuration |
| `hs_flow_branch_action_connections` | dropped | lossy shadow of `connection` |
| `hs_flow_action_time_delay` matching `metadata.delay` | dropped | byte-identical in 64 of 64 real cases |
| `hs_flow_action_time_delay` **not** matching | kept | proves the rule compares rather than assumes |
| `metadata.actionType` matching / not matching its parent | dropped / kept | same |
| branch `nextActionId` matching / not matching the nested connection | dropped / kept | same |
| empty `userIds`, `teamIds`, `ownerProperties` | kept | "nobody is configured" is the answer to why a notification reaches no one |
| empty array nested below `metadata` | dropped | structural placeholder, not configuration |
| `defaultConnection: null` | kept | records failing every branch exit the workflow |
| `connection: null` | kept | terminal action |
| HTML body with list, bold, entity, link | converted only with `stripHtml` | |
| plain-text body | untouched | |

## `ui-number-cases.synthetic.json`

Hand-authored like the trim cases, for the editor-number walker in
`src/ui-numbers.js`. The editor labels every action card with a number that
appears nowhere in the payload: it is the breadth-first reading order of the
STANDARD-edge tree from `firstActionId`, listBranches order then default, GOTO
edges skipped.

The graph is built so that **every wrong traversal produces a different
numbering**: a GOTO from an early branch into the deepest card (following it
would misplace that card), a default column beside ordinary columns
(default-first or depth-first would renumber it), sibling branches whose
correct numbers disagree with their actionId order, an empty branch, a null
defaultConnection, and terminal actions. Expected numbers are hand-computed in
`test/ui-numbers.test.js`, with one assertion per wrong traversal.

The withdrawal cases (unrecognized `connectionType` or `edgeType`, actions
reachable only through a GOTO) are built in the test by mutating a parsed copy,
because a payload carrying them could not have come from the editor.

## Adding a fixture

Captures from **client portals are never committed**, period. Put them in the
gitignored `../private/` directory.

Anything else must be scrubbed before it lands here, and `npm run
check:no-portal-data` enforces it: any six-or-more-digit number not on the
allowlist in `tools/check-no-portal-data.mjs` fails the build. When you add a
scrubbed fixture, add its synthetic identifiers to that allowlist deliberately,
picking values that are obviously invented.
