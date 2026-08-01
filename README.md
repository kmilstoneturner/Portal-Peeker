# Portal Peeker

A Chrome extension for HubSpot admins. It captures the JSON behind a HubSpot workflow as
you open and save it, and lets you copy or download those exact bytes.

Modelled on Salesforce Inspector Reloaded.

**The free build makes zero network calls.** No telemetry, no analytics, no error reporting.
`host_permissions` is `*://*.hubspot.com/*` and nothing else, which you can verify yourself
in `chrome://extensions`. CI fails the build on any absolute URL to a non-HubSpot host in
the bundle.

## What v1 does

- Captures the response of `GET /api/automationplatform/v1/hybrid/{flowId}` on editor load.
- Captures the response of `POST /api/automationplatform/v1/hybrid/batch` on save. The
  response, not the request: the request is only a proposal, and HubSpot allocates real
  objects while handling it. A stored request body is therefore never a snapshot, and is
  never replayed.
- Shows flow name, flow ID, portal ID, version, capture time, and byte count in the popup.
- **Copy** puts the response body on the clipboard. With trimming off, verbatim: no
  pretty-printing, no inflating of embedded JSON.
- **Download** saves the same bytes as `YYYY-MM-DD-{flowId}.json` (local date).
- **Trim to workflow logic**, an optional checkbox. Roughly 37 percent smaller, 42 with the
  HTML toggle. See below.
- **Refresh** refetches saved state from HubSpot, from the content script so cookies ride
  along. A failed refresh never overwrites the capture you already have.

Not in v1: JSON preview, options page, diffing, snapshot history, copilot capture,
validation errors, and any write capability whatsoever.

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

A second checkbox, only available on top of a trim, so that with trimming off the output is
byte-identical to what HubSpot sent, always. It converts rather than deletes: `<strong>` to
`**`, list items to bullets, links to markdown. Merge tokens are text rather than markup and
are untouched either way.

This one rewrites values, so it cannot carry the property above. That is the entire reason
it is a separate toggle.

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

That builds `apps/free/dist`, runs both safety checks against it (no network calls, no real
portal data), and runs the tests. Then:

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `apps/free/dist` folder

Open a HubSpot workflow. A check mark appears on the extension icon once something has been
captured. Note that the extension only sees requests made after it loads, so a tab that was
already open when you installed needs a reload.

## Repo layout

```
packages/core/          normalize, summary, and later diff and graph walk. pure.
packages/capture/       MAIN-world interceptor + isolated-world bridge. shared.
apps/free/              manifest, popup. hubspot.com only. no network.
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

`packages/capture/src/interceptor.js` runs in the **MAIN** world at `document_start`. It has
to. A normal content script gets an isolated world with its own `window`, so patching
`window.fetch` there patches a copy nothing calls. `document_start` matters just as much,
because HubSpot's bundle captures a reference to the original `fetch` while it initialises.

MAIN-world scripts have no access to `chrome.*` at all, so the interceptor's only exit is
`window.postMessage` to `bridge.js`, which runs in the isolated world and holds the
snapshot. The build asserts that the MAIN bundle contains no `chrome.` reference in code.

These two files cannot be merged.

## Fixtures and portal data

Fixtures live in [`packages/core/__fixtures__/`](packages/core/__fixtures__/README.md), and
**everything committed there is synthetic.** Three of them are scrubbed copies of real
captures: structure, key order, and HubSpot vocabulary exactly as returned, with every
identifier and every piece of authored content replaced. The fourth is entirely
hand-authored and exercises the cases where a trim rule must *not* fire.

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
  user-overridable. These are internal APIs and they will change without notice. The options
  page that makes them overridable is v2.
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
