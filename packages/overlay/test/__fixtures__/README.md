# Overlay fixtures

Both fixtures here are hand authored, like the synthetic JSON fixtures in
`packages/core`. Neither is a saved copy of a real page, and a real one must
never be committed here.

Two reasons. A real page carries a portal's custom property labels, which are
authored content and are never committed to this repo, and a real record page
carries a person's data on top of that. And both carry styled-components class
hashes that change on every HubSpot build, which would turn these files into
sets of assertions about unstable strings.

So the fixtures keep the real nesting and the real attribute grammar, and drop
every `class` attribute. Nothing in this package is allowed to select on a class,
and a fixture that carried them would let someone start.

Every `objectTypeId` is synthetic and short on purpose. Real custom object ids
carry enough digits to trip `tools/check-no-portal-data.mjs`, which scans
`.html` as well as source.

## `properties-table.synthetic.html`

The property settings table. What each row is for:

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

## `record-sidebar.synthetic.html`

A contact record's properties card. Load it with a path of
`/contacts/1/record/0-1/2`, since a card is only read when the `objectTypeId` it
declares matches the one in the URL.

This surface is harder than the table, and the fixture is shaped around why. The
primary source is the **bare property name** (`data-test-id="lifecyclestage"`),
which carries no evidence on its own, so the decoys here are not merely nearby:
some of them are indistinguishable from a real property by any rule that reads
one attribute.

| Row | Why it exists |
|---|---|
| `annualrevenue` | The happy path. Display mode, editable, second source on a `<span>`. |
| `hs_lead_status` | An enum, whose value nests a `badge` and a `dropdown-caret` **inside** the second source. Direct-child scoping is the only thing keeping them out of the row list. |
| `label-foo` | The prefix trap, arriving as `property-input-label-foo`. It is why prefixes are stripped by length. It is also the proof that no character-shape rule can be used to reject `dropdown-caret`: real names may be hyphenated. |
| `notes_last_contacted` | Read only (`state="readonly"`). Confirmed live to carry both sources and an anchor, so it must annotate. Pinned because "read only is different" is the obvious wrong guess. |
| `hs_pipeline_stage` | Being edited (`mode="input"`). An extra `DisplayOptimizedFormControl` layer appears and the second source moves to a `<button>` one level deeper, so it is matched by attribute alone. |
| `hubspot_owner_id` | A real property with no second source at all: an owner control renders its value as bare text. Skipped, which is a known cost of the rule rather than a bug. |
| `mismatch_a` with a `mismatch_b` source | Two sources that disagree. Skipped, neighbours still annotated. |
| `no_marker` | Both sources agree, but no `data-deferred-property-input-root` child. The structural check is the only thing that rejects it. |
| `no_anchor` | Readable, but nowhere to put the name. On the table the anchor was also the second source and could not go missing alone; here it can. |
| `wrong_object` in a `2-98765` card | A card for a different object than the page. The one thing withdrawn whole rather than per row. |
| `no_object_type` in a `MARKETING_LEAD_SCORES` card | Cards are scoped by the generic `data-card-type`, so every card on the page is considered. This one's id carries no objectTypeId, so it never parses and is never read. |
| `OBJECT_HIGHLIGHT-FAS-0-1-1` | The other real shape that carries no parseable objectTypeId: hyphens where the grammar wants slashes. |
| `ASSOCIATION_V3/0-2` | A real objectTypeId, but the *associated* object's rather than the page's. Skipped today. Annotating association cards would need its own entry with its own idea of which type is correct. |
| `outside_card` | A properties list with no card above it. Never walked. |
| nav `deals`, `contacts`, `tasks`, `badge` | Well-formed property names on nav chrome. Only the container excludes them. |
| `create-engagement-email-button`, `activity-button-icon-email`, `QuickFiltersBar-item-hubspot_owner_id` | Property-shaped ids on controls that carry no property, all three observed live. The last is a genuine property name, which is why the second source is matched on a prefix rather than a substring. |

Inert presentation wrappers inside the label are collapsed. No rule reads them
and depth there changes no behaviour, unlike the marker depth and the anchor
position, which are kept exactly.
