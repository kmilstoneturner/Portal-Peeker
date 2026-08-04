# Portal Peeker privacy policy

Last updated: 2026-08-04. Applies to the Portal Peeker Chrome extension, all versions.

## The short version

Portal Peeker reads the JSON that HubSpot's workflow editor exchanges with HubSpot's own
API, holds it in the memory of the tab you are looking at, and shows you what is in it. It
does not send that data anywhere. There is no server, no account, no telemetry, and no
analytics. The developer cannot see your workflows, and there is no mechanism by which they
could.

## What Portal Peeker reads

It runs on three kinds of HubSpot page and nowhere else: `*://*.hubspot.com/workflows/*`,
`*://*.hubspot.com/property-settings/*`, and `*://*.hubspot.com/contacts/*`. What it does on
each is different, and only the first involves reading any request.

`*://*.hubspot.com/contacts/*` is broader than the pages the extension actually annotates,
which are CRM record pages. HubSpot opens a record from a list without reloading the page, and
a narrower pattern would simply fail to load when you got there. On any other page under that
path, including every list and index view, the extension checks the address, finds no record,
and does nothing further.

On pages matching `*://*.hubspot.com/workflows/*` it observes two requests that HubSpot's
editor makes to HubSpot:

- `GET /api/automationplatform/v1/hybrid/{flowId}`, which the editor issues when a workflow
  opens.
- `POST /api/automationplatform/v1/hybrid/batch`, which the editor issues when you save.

It keeps the **response** to those requests. Every other request the page makes is ignored.
Requests and responses are never modified, blocked, or delayed.

The response is a workflow definition. Depending on what your workflow does, it can contain
things like flow and portal identifiers, action configuration, filter criteria, email and
task bodies, and the numeric HubSpot user IDs of people the workflow refers to. Portal
Peeker treats all of it as opaque text.

## Where that data lives

In the memory of the content script running in that one browser tab, and nowhere else.

- It is **not** written to `chrome.storage`. The extension does now hold one storage
  permission, for the checkbox states described below, so this is no longer something you
  have to take on trust: the build fails if either capture script so much as mentions
  `chrome.storage`.
- It is **not** written to disk unless you press Download.
- It is **not** sent to the extension's developer or to any third party, because the
  extension contains no code that could do so.
- Reloading the page or closing the tab discards it. There is no history and no way to
  recover a previous capture.

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

Pressing **Refresh** sends a `GET` to HubSpot's own API, on the HubSpot origin you are
already signed in to, to fetch the current saved state of the workflow you are looking at.
It is the same request the editor itself makes. It goes to HubSpot and to nobody else.

Nothing else the extension does generates network traffic. `host_permissions` is
`*://*.hubspot.com/*` and nothing else, which you can confirm for yourself at
`chrome://extensions`, and the project's build fails on any absolute URL to a non-HubSpot
host anywhere in the shipped code.

## Data you export yourself

**Copy** puts the export on your clipboard. **Download** writes it to your Downloads folder
through the browser's normal download flow. In both cases you have chosen to move that data,
and where it goes next is up to you. Portal Peeker has no visibility into either.

Workflow JSON can contain business logic and free text written by your colleagues. Treat an
exported file the way you would treat any other export from your CRM, particularly before
pasting one into a third-party tool such as an AI assistant.

## Cookies

Portal Peeker reads one cookie value, `csrf.app`, on the HubSpot origin, and only when you
press Refresh. HubSpot's API rejects the request without it. The value is placed in the
`x-hubspot-csrf-hubspotapi` header of that one request back to HubSpot. It is not stored,
not logged, and not sent anywhere else. The extension does not request the `cookies`
permission; the value is read from `document.cookie` on the page you are already on.

## Permissions

The extension declares exactly one entry under `permissions`: `storage`, which holds the
state of its checkboxes and nothing else. Chrome shows no warning for it, because it grants
no access to your data: it is a private key-value store belonging to the extension. Its only
other privilege is the host permission `*://*.hubspot.com/*`. It cannot read any other site,
and it has no access to your browsing history, bookmarks, downloads, or other tabs.

The build pins that list to exactly `["storage"]` and fails on anything else, including
`optional_permissions`, which would be a way to widen the grant after you had checked it.

## Showing API names on property settings and record pages

If you turn on **Show internal API names**, then on `*://*.hubspot.com/property-settings/*`
and on CRM record pages under `*://*.hubspot.com/contacts/*`, Portal Peeker adds each
property's internal name underneath its label.

That name is already on the page. HubSpot renders it into the page's own HTML attributes; the
extension reads what is in front of you and displays it more legibly. **No request is made,
and nothing is read that was not already loaded in your browser.** Nothing about the
properties, the object, the record, or the portal is stored or transmitted, and the only thing
saved anywhere is whether the checkbox is ticked.

On a record page the extension reads property names and the record's object type, both from
HTML attributes. It does not read, store, or transmit the record's values, and it makes no use
of whose record it is.

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
