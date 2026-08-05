# Portal Peeker

A Chrome extension for HubSpot admins. It captures the JSON behind a HubSpot workflow as
you open and save it, and lets you copy or download those exact bytes.

<img width="341" height="477" alt="Portal-Peeker" src="https://github.com/user-attachments/assets/c4078b7a-35a7-4c7d-8d8b-8e30d48e0dde" />


**The extension talks to no host but HubSpot.** No telemetry, no analytics, no error
reporting, no third party of any kind. The only request it ever makes is Refresh refetching
the flow from HubSpot's own API, on a click, and nothing else it does leaves your machine.
`host_permissions` is `*://*.hubspot.com/*` and nothing else, which you can verify yourself
in `chrome://extensions`. CI fails the build on any absolute URL to a non-HubSpot host in
the bundle.

`permissions` is `["storage"]` and nothing else. It holds the state of the Settings page
checkboxes, in `chrome.storage.local`, so they stay on this machine: never
`chrome.storage.sync`, which would put them on Google's servers. Chrome shows no warning for
`storage` because it grants no access to your data. Nothing about a capture goes in it, and
the build fails if either capture script, or the record-page property reader, so much as
mentions `chrome.storage`.

## What v1 does

- Captures the response of `GET /api/automationplatform/v1/hybrid/{flowId}` on editor load.
- Captures the response of `POST /api/automationplatform/v1/hybrid/batch` on save. The
  response, not the request: the request is only a proposal, and HubSpot allocates real
  objects while handling it. A stored request body is therefore never a snapshot, and is
  never replayed.
- Shows flow name, flow ID, portal ID, version, capture time, byte count, and an estimated
  token count in the popup.
- **Copy** puts the response body on the clipboard. With every checkbox off, verbatim: no
  pretty-printing, no inflating of embedded JSON.
- **Download** saves the same bytes as `YYYY-MM-DD-{flowId}.json` (local date), plus a
  suffix naming whatever was applied.
- **Trim to workflow logic**, an optional checkbox. Roughly 37 percent smaller, 42 with the
  HTML toggle. See below.
- **Add editor numbers** and **Add AI context**, two more checkboxes, both about handing the
  file to a person or a model. See below.
- **Refresh** refetches saved state from HubSpot, from the content script so cookies ride
  along. A failed refresh never overwrites the capture you already have.

Not in v1: JSON preview, diffing, snapshot history, copilot capture, validation errors, and
any write capability whatsoever.

## What v1.2 adds

A left icon rail in the popup with two pages, Home and Settings, and the first thing on the
Settings page.

**Show internal API names.** On HubSpot's property settings page, each property's internal
name appears in monospace under its label, above the field type:

```
Annual Revenue
annualrevenue
Single-line text
```

On a record page the same name appears under each field's label:

```
Lead Status
hs_lead_status
--
```

Three places there: the **Key information** card in the left sidebar, the **View all properties**
panel including every property group in it, and the **highlights strip** at the top of the
record.

On those three, the name is already on the page. HubSpot writes it into the page's own HTML
attributes and simply does not display it, so this reads what is in front of you and makes it
legible. It is display only, it is undone the moment you untick the box, and it is off until
you turn it on.

**Portal Peeker still makes no request of its own.** Where a name is not in the page at all,
it reads a reply HubSpot's page already received. See below, and PRIVACY.md.

The honest limit: this reads an internal HubSpot UI with no version and no stability promise.
The name has to identify itself before it is shown, so when HubSpot changes its markup **the
annotation disappears rather than showing you the wrong name**. Anything it cannot read with
confidence is skipped and the rest of the page is still annotated.

That rule costs coverage, deliberately, and there are two gaps worth naming.

**Contact profile and Data highlights work differently.** HubSpot puts no internal name in the
page for those two cards, only the label. So the label is matched against your portal's
property list, which HubSpot's own page already fetched while loading. The extension reads
that reply rather than asking for it, and only if you have the setting switched on.

A label matching no property, or matching two, leaves the row unannotated. That is the same
rule as everywhere else here: a blank is fine, a wrong name is not.

**Association cards are still skipped**, because the properties they show belong to the
associated record rather than the one you are looking at.

**The contact owner field is skipped** in the Key information card. Its control renders
differently from every other field there and carries the name only once, and one unconfirmed
copy is not enough on a surface where the surrounding markup would let a wrong guess through.

Settings are stored in `chrome.storage.local`, which is the one permission the extension asks
for. See the privacy note above.

## Trimming

A captured workflow is mostly not workflow logic. Tick **Trim to workflow logic** and Copy
and Download emit a smaller payload intended for handing to a person or a model.

It **removes fields and never changes them**. No renaming, no restructuring, no reordering,
no inflating of embedded JSON, so the whole feature is testable as one property: every leaf
in the output exists in the input, at the same path, with an identical value. That property
is asserted against every fixture on every test run.

What goes: audit metadata, allocator counters, per-action ids that repeat the root, verified
duplicates, escaped-JSON blobs that shadow a richer sibling, nulls, and empty collections.

What stays, deliberately: `defaultConnection: null`, because records failing every branch
leave the workflow and that is a common silent bug. Empty recipient lists, because "nobody
is configured" is the answer to why a notification reaches no one, and deleting the field
turns that into "not specified".

**No dedupe rule fires on belief.** Each one deep-compares the two values, order-insensitively,
and keeps the field on mismatch. Three rules derived from a four-action workflow turned out to
be wrong against a 201-action one, which is why: `filterBranchType` looked like a copy of
`filterBranchOperator` and is really a discriminator; `associatedLists[].filterBranch` looked
redundant and carries unique goal criteria on a goal list; `inputValueFields` looked like
pure duplication and holds the entire configuration of extension actions.

If the parser cannot recognize the payload, **trimming withdraws itself** rather than
producing a partial result, and raw Copy and Download keep working. A large untrimmed file
is a nuisance; a trimmed file that silently lost fields the rules never reached is a trap.

### Strip HTML from email bodies

A second checkbox, only available on top of a trim. It converts rather than deletes:
`<strong>` to `**`, list items to bullets, links to markdown. Merge tokens are text rather
than markup and are untouched either way.

This one rewrites values, so it cannot carry the property above. That is the entire reason
it is a separate toggle, and why it rides on top of the trim rather than on raw output.

### Add editor numbers

The workflow editor labels every card on the canvas with a number, and those numbers appear
nowhere in the JSON. This computes them and appends each one to its action as a `uiNumber`
field, so a model handed the file can say "action 12" and mean the card you are looking at.

The numbers are the breadth-first reading order of the STANDARD-edge tree from
`firstActionId`, which is what the editor paints. They are computed from the capture, never
fetched. They are also volatile: adding, moving, or removing an action renumbers everything
after it, so they are valid for one capture only. `actionId` is the stable handle, and the
field is named to keep that distinction visible.

Works with or without a trim. Each number is inserted into the text immediately before its
action's closing brace, rather than by reparsing and rewriting the document, so on an
untrimmed capture every original byte survives: same whitespace, same key order, same number
formatting. Strip the inserted spans and you have the capture back exactly.

If the graph has a connection shape the walker does not recognize, or an action it cannot
reach, the checkbox withdraws rather than numbering some cards and not others.

### Add AI context

Inserts an `_aiContext` object as the first key of the export: what the file is, when it was
captured and from what (editor load, save, or refresh), the flow and portal it belongs to,
which of these options ran, and a short set of instructions for whoever reads it next. The
instructions are mostly about the distinction above: refer to a card by `uiNumber` when
talking to a person, use `actionId` when correlating across versions.

Like the editor numbers, this works with trimming off, because it does not rewrite anything.
The block is spliced in as text after the opening brace, so every original byte survives
untouched. Delete that one key and you have the bytes you would have had without it, exactly.

The block never claims the file is current: it states the capture time and says that unsaved
editor edits are not in it. It withdraws if the body is not a JSON object, or if the payload
already carries an `_aiContext` key.

### What the checkboxes cost you

**With every checkbox off, Copy and Download give you byte-identical bytes to what HubSpot
sent, always.** Ticking a box is the only way to change that, and every processed file says
so in its name:

| Applied | Filename suffix |
| --- | --- |
| nothing | none |
| editor numbers | `-numbered` |
| AI context | `-ai` |
| trim | `-trimmed` |
| trim, HTML strip | `-trimmed-stripped` |
| everything | `-trimmed-stripped-numbered-ai` |

The two additive options are **insertions, not rewrites**. Only trimming and HTML stripping
change what is already in the file, and they are the only two that need one another. So the
sharper version of the guarantee is: **without a trim, nothing the extension does removes or
alters a single byte HubSpot sent.** It can only add, and both additions are removable.

The extension writes exactly two keys into the JSON itself, `uiNumber` and `_aiContext`,
each behind its own checkbox and its own suffix. Nothing else it does is in-band.

That last claim is checked mechanically, not by memory. The list of ways an export can
differ from the capture lives in one table in `packages/core/src/ai-context.js`, the popup
takes its filename suffixes, its status text, and the flags it reports from that table, and
`npm run check:ai-context` fails the build if a new export option ever appears in the popup
without an entry there. The tests fail too, if an entry exists but has nothing to say for
itself. A block that quietly describes the file as it was one feature ago is the exact
failure this is built to make impossible.

### It is not scrubbing

Trimming is about size. It is not a privacy feature and the UI never calls it "clean" or
"safe". It happens to drop the editor referrer URL and reduce the provenance envelope, but
the free-text fields it keeps are exactly where anything sensitive would be.

### It does not solve large workflows

Trimming is a constant factor. A 201-action workflow goes from about 78,000 tokens to about
48,000, which is smaller and still far too large. The lever for that is slicing the action
graph, and it is not built.

## Where the capture lives

In the bridge content script's memory, and nowhere else. Nothing is written to
`chrome.storage`. The capture exists exactly as long as the page does: reload or close the
tab and it is gone.

That is deliberate. These payloads carry notification bodies, task instructions, and a
client's full business logic. People appear in them as bare numeric user ids rather than
names, but the free text is sensitive on its own.

## Build and install

Requires Node 20 or newer.

```bash
npm install && npm run verify
```

That builds `extension/dist`, runs the safety checks against it (no network calls, no real
portal data, permissions pinned, settings declared), and runs the tests. Then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/dist` folder

Open a HubSpot workflow. A check mark appears on the extension icon once something has been
captured. Note that the extension only sees requests made after it loads, so a tab that was
already open when you installed needs a reload.

### After rebuilding, reload two things

This catches people out, because the symptom looks like a bug in whatever you just changed.

Chrome serves `popup.html`, `popup.js`, and `popup.css` **fresh from disk every time the
popup opens**, but it parses `manifest.json` **only when the extension is loaded**. So after
a rebuild that touched the manifest you can be looking at a brand new popup running under the
old manifest: a permission it needs is missing, and a content script it declares was never
registered. Settings appear not to persist and page annotations never show up, neither of
which is what is actually wrong.

So, in order:

1. Hit the reload arrow on the Portal Peeker card in `chrome://extensions`.
2. Reload the HubSpot tab. Reloading the extension does not re-inject content scripts into
   tabs that are already open.

To tell which manifest is actually running, right-click the popup, choose **Inspect**, and
run `chrome.runtime.getManifest().version` in its console. If that does not match
`extension/manifest.json`, step 1 has not happened yet.

## Repo layout

```
packages/core/          summary, trim, html strip, numbers, AI context, span scan. pure.
packages/capture/       MAIN-world interceptor + isolated-world bridge. shared.
packages/overlay/       settings table, annotations drawn on HubSpot's own pages, and
                        the MAIN-world reader for the one response they need.
extension/              manifest, popup. hubspot.com only. no network.
tools/                  build, icon generation, the CI safety checks.
```

npm workspaces. No monorepo tooling.

### Why there is a build step

Content scripts are not ES modules, so a file listed in `manifest.content_scripts` cannot
import anything. But `protocol.js` and `endpoints.js` are needed by both the MAIN-world
interceptor and the isolated-world bridge, and duplicating them is exactly how the two ends
of a message channel drift apart.

So sources are authored as plain ES modules and `tools/build.mjs` concatenates each
content-script entry with its dependencies into one classic IIFE. It is about forty lines
and it refuses to guess: a multi-line import or any surviving module syntax is a build
failure, not a warning.

## The two JS worlds

Two pairs of scripts live across this boundary, for the same reason.

`packages/capture/src/interceptor.js` runs in the **MAIN** world at `document_start`. It has
to. A normal content script gets an isolated world with its own `window`, so patching
`window.fetch` there patches a copy nothing calls. `document_start` matters just as much,
because HubSpot's bundle captures a reference to the original `fetch` while it initialises.

`packages/overlay/src/property-names-interceptor.js` is the second, on record pages. Same
world, same timing, and the timing was measured rather than assumed: the response it reads is
fetched once during page load and cached, so a script arriving at `document_idle` has already
missed it.

MAIN-world scripts have no access to `chrome.*` at all, so each interceptor's only exit is
`window.postMessage` to its isolated-world partner: `bridge.js`, which holds the snapshot, and
`property-names-store.js`, which holds the label index. They use separate channels, so neither
side has to ignore the other's traffic. The build asserts that no MAIN bundle contains a
`chrome.` reference in code.

Neither pair can be merged.

## Fixtures and portal data

Fixtures live in [`packages/core/__fixtures__/`](packages/core/__fixtures__/README.md), and
**everything committed there is synthetic.** Three of them are scrubbed copies of real
captures: structure, key order, and HubSpot vocabulary exactly as returned, with every
identifier and every piece of authored content replaced. The other two are entirely
hand-authored: one exercises the cases where a trim rule must *not* fire, the other is built
so that every wrong graph traversal produces a different set of editor numbers.

Two rules, both enforced rather than remembered:

- **Captures from client portals are never committed.** They go in the gitignored
  `__fixtures__/private/`, where the tests pick them up locally and skip silently in CI.
- **No real portal, flow, or user identifier appears anywhere in this repository.**
  `npm run check:no-portal-data` fails the build on any six-or-more-digit number that is not
  on an explicit allowlist of synthetic values, or any `hubspot.com` URL carrying one. It is
  an allowlist rather than a blocklist so that an unscrubbed capture fails immediately, even
  though nobody could predict its identifiers in advance.

The design notes and the reverse-engineering findings for these undocumented APIs are kept
outside this repository. That is why the code carries its reasoning in comments rather than
pointing at documents.

## Known limits in v1

- Endpoint patterns live in `packages/capture/src/endpoints.js` and are not yet
  user-overridable. These are internal APIs and they will change without notice. There is a
  Settings page as of v1.2, so they now have somewhere to go; making them overridable there
  is still v2.
- The API name annotation reads HubSpot's own markup, which carries no stability promise. If
  HubSpot changes it the names stop appearing. That is the intended failure: the annotation
  is withdrawn rather than guessed at. On the two record-page cards that put no name in the
  markup at all, it reads the property list HubSpot's page already fetched, and the same
  posture applies: a label matching no property, or two, leaves the row blank.
- No dirty detection. The popup shows a capture timestamp and a Refresh button and claims
  nothing about currency. The only candidate signal (`allOutputs`) has untested coverage,
  and a dirty flag with holes is worse than none.
- Refresh returns **saved** state. Unsaved edits are not in it, and the popup says so.
- The SPA staleness guard compares the snapshot's flow ID against the flow ID in the page
  URL on every read, so navigating to another workflow shows an empty state rather than the
  previous flow's JSON. On URL shapes where no flow ID can be parsed, the guard cannot fire.
- Platform (non-classic) flow envelopes have never been captured. `summarize` flags
  `isClassicWorkflow: false` as unrecognized. Capture itself is unaffected: it is parser
  free, and Copy and Download work on the raw bytes regardless.

## Licence

**Source available, not open source.** [PolyForm Internal Use License 1.0.0](LICENSE).

You may run this extension and modify it, for yourself and your organisation. You may not
distribute it, in original or modified form. The licensor additionally permits personal,
non-business use on the same terms.

Read [LICENSE](LICENSE) for the actual terms; the paragraph above is orientation, not a
substitute.
