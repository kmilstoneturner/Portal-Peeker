# Overlay fixtures

Every fixture here is hand authored, like the synthetic JSON fixtures in
`packages/core`. None is a saved copy of a real page, and a real one must
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

A contact record's properties cards. Load it with a path of
`/contacts/1/record/0-1/2`: the object type comes from the path, and nothing asks
a card to declare one.

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
| `verticalmarket` in a card whose id is a bare `4773` | A custom card built in a portal. Nearly every card on a real client record looks like this, and it must annotate. Nothing reads an object type off a card: the card **type** is the scope. |
| `wrong_object` in an `ASSOCIATION_V3` card | Another card type carrying the properties grammar anyway. Excluded by type. A live association card has no properties list at all, so this is belt and braces on the type selector. |
| `outside_card` | A properties list with no card above it. Never walked. |
| nav `deals`, `contacts`, `tasks`, `badge` | Well-formed property names on nav chrome. Only the container excludes them. |
| `create-engagement-email-button`, `activity-button-icon-email`, `QuickFiltersBar-item-hubspot_owner_id` | Property-shaped ids on controls that carry no property, all three observed live. The last is a genuine property name, which is why the second source is matched on a prefix rather than a substring. |

Inert presentation wrappers inside the label are collapsed. No rule reads them
and depth there changes no behaviour, unlike the marker depth and the anchor
position, which are kept exactly.

### The two prefixed surfaces

The highlights strip and the All properties panel are in the same file, because
the point of several of these rows is what happens when both grammars are on one
page. Both read a single **prefixed** id (`NAME_FROM.PREFIX`), so they carry no
bare name, no second source, and no per-row marker.

| Row | Why it exists |
|---|---|
| `highlight-property-display-{hs_full_name_or_email, jobtitle, email}` | The strip's happy path. It has no label/value pair, so the name goes immediately before the value node. |
| `highlight-property-item-jobtitle-and-company` | Looks like a second source and is not one: the id is two properties joined, not a property name. Never selected on, which is why the strip reads one id rather than requiring a pair to agree. |
| `property-input-{annualrevenue, hs_email_domain}` in two `group-accordion-*` groups | The panel's happy path, across groups. Groups need no handling of their own: a collapsed one has no rows until it opens, and the observer catches them then. |
| `property-input-label-foo` | The prefix trap again, on the surface that has only the prefix to work with. |
| `property-input-no_anchor_modal` | Readable, nowhere to put the name. |
| `property-input-skeleton` ×2 | Loading placeholders. The panel is virtualized, and a live record had **67** of these on screen at once, every one parsing as a property named "skeleton". |
| `property-input-phone-button` inside `property-input-fax` | A control nested in another property's row, wearing the prefix. Same shape as `badge` inside `lifecyclestage`. Would otherwise annotate the fax row "phone-button". |
| `property-input-name` in an `ASSOCIATION_V3` card | The associated **company's** `name` property on a contact record. The prefix says "a property input"; only the container scope says "one belonging to the record you are looking at". |

The last three are why the anchor is a **validity check** and not merely an
insertion point. Measured on a live panel: 101 nodes match the row selector, 33
carry the anchor, 33 carry a label, and it is the same 33. Turning the anchor
into a fallback that places the name somewhere else would ship all of them.

### The strip's composite item

`highlight-property-item-jobtitle-and-company` wraps the same
`highlight-property-display-jobtitle` id around the value twice, one span inside
the other, which is what a live contact rendered. The strip is the one surface
with no anchor, so nothing filtered the repeat and the name printed twice,
stacked. Two rules carry the fix, and the fixture pins both: a name the
container already carries in a pass is declined (safe because the repeat is the
SAME name; the anchored surfaces keep the anchor filter instead, which is what
excludes `phone-button`, where the names differ), and every container pass ends
by sweeping out any of our nodes the pass did not stand behind, which is what
removes a node stranded in an old parent when React rebuilds a wrapper.

### The three label surfaces

Contact profile (`PROPERTIES_LIST`), Data highlights (`DATA_HIGHLIGHTS`), and the
Property history modal (`property-info-table`) put no internal name in the page
at all, so their rows are resolved by matching the rendered label against
HubSpot's property metadata. The fixture stands that metadata up in
`record-properties.test.js` rather than here.

| Row | Why it exists |
|---|---|
| "Company name" | Resolves, and the casing differs from the property's own label ("Company Name"). Matching folds case for exactly this reason: exact matching resolved 3 of 6 rows on a live card, folding case resolved 6 of 6. |
| "City", "Create Date", "Lifecycle Stage" | The happy path on both cards. |
| "Not A Real Label" (on both cards) | A label no property carries. Skipped: not found is not a guess. |
| "Shared Label" | Two properties carry it. Ambiguity withdraws the row, which is the whole reason one source is allowed on these surfaces. |

The Data highlights rows are two `<p>` children per row, and the annotation goes
between them. The anchor is `p:nth-of-type(2)` rather than `p + p` deliberately:
inserting our `<code>` breaks the adjacency, so `p + p` would match on the first
pass and never again, leaving the row uncorrectable on re-render.

The Property history rows carry the label as a bare text node in
`property-label-cell`, with nothing to insert ahead of, so the name is **appended
into that cell** instead. It is the only surface where our node ends up inside the
node the label is read from, which is what `labelText` in `record-properties.js`
exists for. The fixture repeats "Create Date" twice on purpose: a history lists one
property once per change, so a repeat is the normal case there, and each row has to
be annotated on its own.

## `create-form.synthetic.html`

The create-record dialog, scoped by `[data-selenium-test="creator"]`. HubSpot
draws it in a same-origin iframe of its own
(`/object-builder/{portalId}/{objectTypeId}/embed`), which is why the manifest
gives the overlay a second entry with `all_frames: true`. Each field is a
`[data-test-id="FormControl"]` holding one
`data-selenium-test="property-input-{name}"` control, which is `NAME_FROM.PREFIX`
on a different attribute. No property metadata is involved, so this surface works
on every object including custom ones and on pages that are not record pages.

| Row | Why it exists |
|---|---|
| `property-input-domain` | The happy path, on a textarea. |
| `property-input-label-foo` | The prefix trap, stripped by length rather than by replace or a split on `-`. |
| `property-input-hubspot_owner_id` | A dropdown, whose control is a `<button>` nesting a caret and a typeahead item. Matched on the attribute alone, never on tag or position. |
| `property-input-city`, disabled | The whole secondary fieldset renders disabled until a name is typed. Real properties, so they annotate. "Disabled fields are different" is the obvious wrong guess. |
| `property-input-fax` **plus** `property-input-phone-button` | Two prefixed controls in one field. Taking the first would be a guess, so the field is declined. Unobserved here, but the All properties panel renders exactly this shape. |
| A field with no source | Something in the form that is not a property field. |
| A field with no anchor | Readable, nowhere to put the name. |
| A `FormControl` outside the dialog | Container scoping is the only thing that excludes it. |

Every row carries a label whose own id is `FormControl-property-input-input-40`.
It **contains** the prefix and is not a name: the tail is the DOM id of the input.
It costs nothing to refuse, because `afterPrefix` requires the value to *start*
with the prefix. It is in the fixture so that relaxing a selector into a substring
match fails loudly.
