# Portal Peeker privacy policy

Last updated: 2026-08-28. Applies to the Portal Peeker Chrome extension, all versions.

## The short version

Portal Peeker reads the JSON that HubSpot's workflow editor and lists (segments) tool
exchange with HubSpot's own API, holds it in the memory of the tab you are looking at, and
shows you what is in it. If you switch on the API names setting, it also reads your
portal's property configuration from responses HubSpot's own record page already fetched.
It does not send any of that anywhere. There is no server, no account, no telemetry, and no
analytics. The developer cannot see your workflows or segments, and there is no mechanism
by which they could.

## What Portal Peeker reads

It runs on five kinds of HubSpot page and nowhere else: `*://*.hubspot.com/workflows/*`,
`*://*.hubspot.com/contacts/*`, `*://*.hubspot.com/lists/*` and
`*://*.hubspot.com/segments/*` (the roots HubSpot's renamed Lists tool uses),
`*://*.hubspot.com/property-settings/*`, and `*://*.hubspot.com/object-builder/*`, which is
the frame HubSpot itself draws the create record dialog in. What it does on each is
different. On the property settings page and in the create record dialog it reads only what
is already in the page's own markup.

`*://*.hubspot.com/contacts/*` is broader than the pages the extension actually uses, which
are CRM record pages (for the optional API names annotation) and segment pages (for
capture). HubSpot opens a record from a list without reloading the page, and a narrower
pattern would simply fail to load when you got there. On any other page under that path the
extension checks the address, finds neither a record nor a segment definition in the
traffic it watches for, and does nothing further. The same applies under
`*://*.hubspot.com/object-builder/*`: if no create dialog is on screen, the script finds
nothing to read and does nothing.

On pages matching `*://*.hubspot.com/workflows/*` it observes two requests that HubSpot's
editor makes to HubSpot:

- `GET /api/automationplatform/v1/hybrid/{flowId}`, which the editor issues when a workflow
  opens.
- `POST /api/automationplatform/v1/hybrid/batch`, which the editor issues when you save.

On segment (list) pages it observes four requests that HubSpot's own page makes:

- `GET /api/inbounddb-lists/v1/lists/{listId}`, which the lists tool issues when a segment
  opens. A write to that same path, should HubSpot save through it, is kept the same way.
- `/api/inbounddb-lists/v1/lists/getBatch`, the call the page makes to load the full
  definitions of lists the open segment references in its filters.
- `/api/inbounddb-lists/v1/lists/{listId}/suppression`, the segment's suppression settings.
- the membership-count rollup under `/api/inbounddb-lists/v1/list-membership-search/`.

The first is the capture. The other three are kept **beside** it, tied to the segment the
page URL names, and are only ever written into an export when the "Include referenced
lists" checkbox is on; the file then carries a `-related` suffix. They live in the same
tab memory as the capture and go when it does.

It keeps the **response** to those requests. Every other request the page makes is
ignored. Requests and responses are never modified, blocked, or delayed.

The response is a workflow or segment definition. Depending on what it does, it can contain
things like flow, list, and portal identifiers, action configuration, filter criteria and
the values filters compare against, email and task bodies, and the numeric HubSpot user IDs
of people it refers to. Portal Peeker treats all of it as opaque text.

On CRM record pages under `*://*.hubspot.com/contacts/*`, and **only if you have switched on
Show internal API names**, it observes one further kind of request that HubSpot itself makes:

- `GET /api/properties/v4/groups/{objectTypeId}/properties`, which the page issues while it
  loads, once for each type of object it needs. A deal record, for example, also fetches the
  list for its line items, and the extension keeps each reply under the object type it
  belongs to so one type's labels are never used to resolve another's.

Those responses are your portal's **property configuration**: the internal name, label and
type of each property on that object type. They are not record data. They contain no contact,
company or deal values, and nothing about the person whose record you are looking at.

Two things about it are worth stating precisely, because they are the reason it is acceptable
at all. **Portal Peeker does not request it.** HubSpot's own page does, to draw the page you
are already looking at, and the extension reads the replies. And **they are only read if you
asked for the feature.** With the setting off, which is how it ships, the extension never asks
for those responses and never receives them.

They are used for one thing: three places on a record page display a property's label without
its internal name anywhere in the page (the "Contact profile" card, the "Data highlights"
card, and the Property history window), so the label is looked up against that list. The
result is held in memory for as long as the tab is open and is never written anywhere.

## Where that data lives

In the memory of the content script running in that one browser tab, and nowhere else.

- It is **not** written to `chrome.storage`. The extension does now hold one storage
  permission, for the checkbox states described below, so this is no longer something you
  have to take on trust: the build fails if either capture script, or the record-page
  property reader, so much as mentions `chrome.storage`.
- It is **not** written to disk unless you press Download.
- It is **not** sent to the extension's developer or to any third party, because the
  extension contains no code that could do so.
- Reloading the page or closing the tab discards it. There is no history and no way to
  recover a previous capture.

The same is true of the property list described above, on record pages. It is held in the
memory of that one tab, is never written to `chrome.storage` or to disk, and goes when the
tab does. The build greps that script for `chrome.storage` alongside the two capture scripts.

The only thing Portal Peeker stores between sessions is the state of its checkboxes: the four
export options, kept in the popup's own `localStorage`, and the Settings page toggles, kept in
`chrome.storage.local`. That is a handful of true/false values. It contains nothing about any
workflow, portal, or person, and no property name, label, or id ever reaches either store.

The Settings toggles are in `chrome.storage` rather than alongside the others for one reason:
they are obeyed by a script running on hubspot.com, which is a different origin and cannot
read the popup's `localStorage`. It is `chrome.storage.local`, never `chrome.storage.sync`,
so they stay on this machine. A build check enforces both the area and the exact set of keys.

## What leaves your computer

One thing, and only when you ask for it.

Pressing **Refresh**, or **Fetch from HubSpot** on the empty state, sends a `GET` to
HubSpot's own API, on the HubSpot origin you are already signed in to, to fetch the current
saved state of the workflow or segment you are looking at. It is the same request the page
itself makes. It goes to HubSpot and to nobody else.

Nothing else the extension does generates network traffic. `host_permissions` is
`*://*.hubspot.com/*` and nothing else, which you can confirm for yourself at
`chrome://extensions`, and the project's build fails on any absolute URL to a non-HubSpot
host anywhere in the shipped code.

## Data you export yourself

**Copy** puts the export on your clipboard. **Download** writes it to your Downloads folder
through the browser's normal download flow. In both cases you have chosen to move that data,
and where it goes next is up to you. Portal Peeker has no visibility into either.

Workflow and segment JSON can contain business logic, filter values, and free text written
by your colleagues. Treat an exported file the way you would treat any other export from
your CRM, particularly before pasting one into a third-party tool such as an AI assistant.

## Cookies

Portal Peeker reads one cookie value, `csrf.app`, on the HubSpot origin, and only when you
press Refresh or Fetch. HubSpot's API rejects the request without it. The value is placed
in the `x-hubspot-csrf-hubspotapi` header of that one request back to HubSpot. It is not
stored, not logged, and not sent anywhere else. The extension does not request the
`cookies` permission; the value is read from `document.cookie` on the page you are already
on.

## Permissions

The extension declares exactly one entry under `permissions`: `storage`, which holds the
state of its checkboxes and nothing else. Chrome shows no warning for it, because it grants
no access to your data: it is a private key-value store belonging to the extension. Its only
other privilege is the host permission `*://*.hubspot.com/*`. It cannot read any other site,
and it has no access to your browsing history, bookmarks, downloads, or other tabs.

The build pins that list to exactly `["storage"]` and fails on anything else, including
`optional_permissions`, which would be a way to widen the grant after you had checked it.

## Showing API names on property settings, record pages, and the create dialog

If you turn on **Show internal API names**, then on `*://*.hubspot.com/property-settings/*`,
on CRM record pages under `*://*.hubspot.com/contacts/*`, and in the create record dialog
(which HubSpot draws in its own frame under `*://*.hubspot.com/object-builder/*`), Portal
Peeker adds each property's internal name underneath its label.

**Portal Peeker makes no request of its own on any of these pages.** For most properties the
name is already on the page: HubSpot renders it into the page's own HTML attributes, and the
extension reads what is in front of you and displays it more legibly. The create record
dialog is read entirely this way. Nothing is stored or transmitted, and the only thing saved
anywhere is whether the checkbox is ticked.

Three places on a record page show a property's label and put its internal name nowhere in the
page: the "Contact profile" card, the "Data highlights" card, and the Property history window.
For those, and only when this setting is on, the label is matched against the property list
HubSpot's own page already fetched, as described under "What Portal Peeker reads" above. That list is portal configuration, not
record data, and it is held in memory only until the tab closes.

The extension reads property names, property labels and the record's object type. It does not
read, store, or transmit the record's values, and it makes no use of whose record it is.

The change is display only and it is undone the moment you untick the box or leave the page.
Portal Peeker only ever adds elements of its own here: it does not remove, move, or alter
anything HubSpot drew, and it makes no change to your data or your portal.

This setting is off until you turn it on.

## What Portal Peeker never does

- It never sends your data to the developer or to any third party.
- It never uses analytics, telemetry, crash reporting, or advertising of any kind.
- It never sells or transfers your data. There is no data flow in which it could.
- It never writes to your HubSpot portal. It has no create, edit, or delete capability of
  any kind, and it never replays a captured request.
- It never loads or executes remotely hosted code.

## One thing it is not

The optional **Trim to workflow logic** checkbox makes an export smaller by dropping fields.
It is a size feature. It is not redaction, it does not remove personal data, and it does not
make an exported file safe to share. The free-text fields it keeps are exactly where
sensitive content lives.

## Children

Portal Peeker is a tool for HubSpot administrators and is not directed at children.

## Changes to this policy

Material changes will be published here and the date at the top will change. The extension's
Chrome Web Store listing links to this file.

## Contact

Ken Milstone-Turner, ken@kenmilstoneturner.com
