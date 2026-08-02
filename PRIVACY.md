# Portal Peeker privacy policy

Last updated: 2026-08-02. Applies to the Portal Peeker Chrome extension, all versions.

## The short version

Portal Peeker reads the JSON that HubSpot's workflow editor exchanges with HubSpot's own
API, holds it in the memory of the tab you are looking at, and shows you what is in it. It
does not send that data anywhere. There is no server, no account, no telemetry, and no
analytics. The developer cannot see your workflows, and there is no mechanism by which they
could.

## What Portal Peeker reads

On pages matching `*://*.hubspot.com/workflows/*`, and nowhere else, it observes two
requests that HubSpot's editor makes to HubSpot:

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

- It is **not** written to `chrome.storage`.
- It is **not** written to disk unless you press Download.
- It is **not** sent to the extension's developer or to any third party, because the
  extension contains no code that could do so.
- Reloading the page or closing the tab discards it. There is no history and no way to
  recover a previous capture.

The only thing Portal Peeker stores between sessions is the state of the four export
checkboxes, kept in the popup's own `localStorage`. That is four true/false values. It
contains nothing about any workflow, portal, or person.

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

The extension declares **no** entries under `permissions`. Its only privilege is the host
permission `*://*.hubspot.com/*`. It cannot read any other site, and it has no access to
your browsing history, bookmarks, downloads, or other tabs.

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
