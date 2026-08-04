# Overlay fixtures

`properties-table.synthetic.html` is hand authored, like the synthetic JSON
fixtures in `packages/core`. It is not a saved copy of a real page, and a real
one must never be committed here.

Two reasons. A real properties table carries a portal's custom property labels,
which are authored content and are never committed to this repo. And it carries
styled-components class hashes that change on every HubSpot build, which would
turn this file into a set of assertions about unstable strings.

So the fixture keeps the real nesting and the real `data-test-id` grammar, and
drops every `class` attribute. Nothing in the parser is allowed to select on a
class, and a fixture that carried them would let someone start.

Every `objectTypeId` is synthetic and short on purpose. Real custom object ids
carry enough digits to trip `tools/check-no-portal-data.mjs`, which scans
`.html` as well as source.

## What each row is for

| Row | Why it exists |
|---|---|
| `0-1/annualrevenue` | The happy path, and the one from the original bug report. Stock contact property, label button and type tag both present. |
| `0-1/hs_lead_status` | Underscores in the name. |
| `2-98765/my_custom_prop` | A custom object, so the parser is exercised on `2-N` as well as `0-N`. |
| `0-1/label-foo` | The prefix trap. This name arrives as `property-label-label-foo`, which a regex replace or a split on `-` would mangle. It is why prefixes are stripped by length. |
| `0-1/mismatch_a` with a `mismatch_b` type tag | Two sources that disagree. Must be skipped, and its neighbours must still annotate. |
| `0-1/orphan` with no `<small>` | No second source and no insertion anchor. Must be skipped without throwing. |
| `cell-name-broken` | A name cell with no objectTypeId. Must be skipped. |

The last three are the point of the file. A well behaved table cannot exercise
the cases where a rule must **not** fire, which is the same reason
`packages/core/__fixtures__/synthetic/trim-cases.synthetic.json` exists.
