import { describe, expect, it } from 'vitest';
import { classifyUrl, hybridUrl, inbounddbListUrl, idsFromPageUrl } from '../src/endpoints.js';

const PAGE = 'https://app.hubspot.com/workflows/12345678/platform/flow/1000000001/edit';
const LIST_PAGE = 'https://app.hubspot.com/contacts/12345678/objectLists/4242/filters';
const RECORD_PAGE = 'https://app.hubspot.com/contacts/12345678/record/0-1/9101';

describe('classifyUrl: workflows', () => {
  it('matches the editor-load GET and pulls the flow ID from the path', () => {
    const hit = classifyUrl('/api/automationplatform/v1/hybrid/1000000001?portalId=12345678', PAGE);
    expect(hit.kind).toBe('load');
    expect(hit.domain).toBe('flow');
    expect(hit.flowId).toBe('1000000001');
    expect(hit.listId).toBeNull();
  });

  it('matches the save POST, which has no flow ID in the path', () => {
    const hit = classifyUrl(
      'https://app.hubspot.com/api/automationplatform/v1/hybrid/batch?sourceapp=WORKFLOWS_APP',
      PAGE,
    );
    expect(hit.kind).toBe('save');
    expect(hit.domain).toBe('flow');
    expect(hit.flowId).toBeNull();
  });

  it('ignores allOutputs, which carries no flow state', () => {
    expect(
      classifyUrl('/api/automationplatform/v1/output-fields/flow/1000000001/allOutputs', PAGE),
    ).toBeNull();
  });

  it('ignores the copilot gateway in v1', () => {
    expect(
      classifyUrl(
        '/api/chirp-frontend-app/v1/gateway/com.hubspot.workflows.copilot.rpc.WorkflowsCopilot/fetchInteractiveModeContextForFlow',
        PAGE,
      ),
    ).toBeNull();
  });

  it('rejects unrelated traffic cheaply', () => {
    expect(classifyUrl('/hubfs/logo.png', PAGE)).toBeNull();
    expect(classifyUrl('', PAGE)).toBeNull();
    expect(classifyUrl(null, PAGE)).toBeNull();
    expect(classifyUrl('not a url')).toBeNull();
  });

  it('does not match a longer path that merely starts with the hybrid prefix', () => {
    expect(classifyUrl('/api/automationplatform/v1/hybrid/1000000001/extra', PAGE)).toBeNull();
  });
});

describe('classifyUrl: segments (lists)', () => {
  it('matches the definition GET and pulls the list ID from the path', () => {
    // The request segments-ui makes when a list opens, observed August 2026,
    // on a regional app origin.
    const hit = classifyUrl(
      'https://app-na2.hubspot.com/api/inbounddb-lists/v1/lists/4242?portalId=12345678&clienttimeout=14000&hs_static_app=segments-ui',
      LIST_PAGE,
    );
    expect(hit.kind).toBe('load');
    expect(hit.domain).toBe('list');
    expect(hit.listId).toBe('4242');
    expect(hit.flowId).toBeNull();
  });

  it('classifies a write to the same path as a save', () => {
    // One path serves reads and writes, so the method is the discriminator.
    for (const method of ['PUT', 'put', 'POST', 'PATCH']) {
      const hit = classifyUrl('/api/inbounddb-lists/v1/lists/4242', LIST_PAGE, undefined, method);
      expect(hit.kind, method).toBe('save');
      expect(hit.domain, method).toBe('list');
      expect(hit.listId, method).toBe('4242');
    }
    expect(classifyUrl('/api/inbounddb-lists/v1/lists/4242', LIST_PAGE, undefined, 'GET').kind).toBe('load');
  });

  it('does not capture verbs that cannot answer with a definition', () => {
    // A DELETE's acknowledgment captured as a "save" would overwrite the one
    // copy of a list that no longer exists in HubSpot.
    for (const method of ['DELETE', 'delete', 'HEAD', 'OPTIONS']) {
      expect(classifyUrl('/api/inbounddb-lists/v1/lists/4242', LIST_PAGE, undefined, method), method).toBeNull();
    }
  });

  it('classifies the responses that load beside a definition as sidecars, never subjects', () => {
    // All three fired alongside the definition GET when a list opened. None of
    // them is the definition, and treating any of them as the subject would
    // replace it; as sidecars they ride along for the bundled export instead.
    const batch = classifyUrl(
      '/api/inbounddb-lists/v1/lists/getBatch?portalId=12345678&clienttimeout=14000',
      LIST_PAGE,
    );
    expect(batch.role).toBe('sidecar');
    expect(batch.sidecarKind).toBe('listBatches');
    // No id in the path: the bridge ties it to the page URL or not at all.
    expect(batch.listId).toBeNull();

    const suppression = classifyUrl(
      '/api/inbounddb-lists/v1/lists/4242/suppression?portalId=12345678',
      LIST_PAGE,
    );
    expect(suppression.role).toBe('sidecar');
    expect(suppression.sidecarKind).toBe('suppression');
    expect(suppression.listId).toBe('4242');

    const membership = classifyUrl(
      '/api/inbounddb-lists/v1/list-membership-search/list/4242/3/current-state',
      LIST_PAGE,
    );
    expect(membership.role).toBe('sidecar');
    expect(membership.sidecarKind).toBe('membershipCounts');
    expect(membership.listId).toBe('4242');

    // Subjects say so explicitly, so a missing role can never read as one.
    expect(classifyUrl('/api/inbounddb-lists/v1/lists/4242', LIST_PAGE).role).toBe('subject');
  });

  it('still ignores what is neither a definition nor a known sidecar', () => {
    for (const url of [
      // the grid's saved-view configuration
      '/api/sales/v4/views/0-1/all?namespace=LISTS&portalId=12345678',
      // legacy-id mapping lives one path segment deeper and uses another id space
      '/api/inbounddb-lists/v1/lists/771000001/ilsMapping',
      // membership search endpoints that are not the count rollup
      '/api/inbounddb-lists/v1/list-membership-search/list/4242/3/members',
      // crm-search resolves suppression-list names on this page, but the same
      // URL serves every CRM search, the members table included, and this
      // module classifies by URL alone: capturing it could keep record rows.
      '/api/crm-search/search?portalId=12345678&clienttimeout=14000',
    ]) {
      expect(classifyUrl(url, LIST_PAGE), url).toBeNull();
    }
  });
});

describe('classifyUrl: records', () => {
  // The request every record page makes, observed August 2026 across 0-1,
  // 0-2, 0-3, 0-27, and a portal-defined custom object, param set identical.
  const BATCH =
    '/api/inbounddb-objects/v1/crm-objects/0-1/batch?portalId=12345678&allPropertiesFetchMode=latest_version&includeAllProperties=true&includeAllValues=true&includeCurrentUserPermissions=true&includeObjectVersion=true&flpViewValidation=false&id=9101';

  it('matches the batch GET, type from the path and id from the query', () => {
    const hit = classifyUrl(BATCH, RECORD_PAGE);
    expect(hit.role).toBe('subject');
    expect(hit.kind).toBe('load');
    expect(hit.domain).toBe('record');
    expect(hit.objectTypeId).toBe('0-1');
    expect(hit.objectId).toBe('9101');
    expect(hit.flowId).toBeNull();
    expect(hit.listId).toBeNull();
  });

  it('matches a portal-defined custom object type the same way', () => {
    const hit = classifyUrl(
      '/api/inbounddb-objects/v1/crm-objects/2-7701/batch?portalId=12345678&id=9303',
      RECORD_PAGE,
    );
    expect(hit.domain).toBe('record');
    expect(hit.objectTypeId).toBe('2-7701');
    expect(hit.objectId).toBe('9303');
  });

  it('captures only GETs on this path', () => {
    // Unlike the list pattern, where a write answers with the updated
    // definition. No write has been observed here, and a mutation
    // acknowledgment stored as the record would be a wrong capture.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(classifyUrl(BATCH, RECORD_PAGE, undefined, method), method).toBeNull();
    }
    expect(classifyUrl(BATCH, RECORD_PAGE, undefined, 'get').domain).toBe('record');
  });

  it('refuses anything but exactly one numeric id in the query', () => {
    for (const url of [
      // batch implies the param can repeat; a multi-record body has no honest
      // answer to "which record is this?"
      '/api/inbounddb-objects/v1/crm-objects/0-1/batch?id=9101&id=9303',
      '/api/inbounddb-objects/v1/crm-objects/0-1/batch?portalId=12345678',
      '/api/inbounddb-objects/v1/crm-objects/0-1/batch?id=',
      '/api/inbounddb-objects/v1/crm-objects/0-1/batch?id=9101x',
    ]) {
      expect(classifyUrl(url, RECORD_PAGE), url).toBeNull();
    }
  });

  it('excludes the singular sibling and every other shape on the service', () => {
    for (const url of [
      // GET /crm-objects/{type}/{id}, observed with flpViewValidation=true on
      // an engagement page. The end anchor exists to keep it out: the batch
      // call accompanied it on every page tested.
      '/api/inbounddb-objects/v1/crm-objects/0-27/9505?flpViewValidation=true',
      '/api/inbounddb-objects/v1/crm-objects/0-1/batch/extra?id=9101',
      // an unhyphenated path segment is not an objectTypeId
      '/api/inbounddb-objects/v1/crm-objects/12345678/batch?id=9101',
    ]) {
      expect(classifyUrl(url, RECORD_PAGE), url).toBeNull();
    }
  });

  it('ignores the record-page traffic that is deliberately not captured', () => {
    for (const url of [
      '/api/contacts/v1/contact/vids/batch?portalId=12345678',
      '/api/companies/v2/companies/batch?portalId=12345678',
      '/api/timeline/v2/object/0-1/9101?limit=20',
      '/api/crm/events/v3/timeline/0-1/9101?portalId=12345678',
      '/api/calls/v1/callees/omnibus/0-1/9101',
      '/api/sales-views/v1/associated-open-objects/CONTACT/9101/DEAL',
      '/api/chirp-frontend-app/v1/gateway/com.hubspot.card.associated.objects.rpc.AssociatedObjectsGatewayRpc/getAssociatedObjectsPaged',
    ]) {
      expect(classifyUrl(url, RECORD_PAGE), url).toBeNull();
    }
  });
});

describe('hybridUrl', () => {
  const url = new URL(hybridUrl('https://app.hubspot.com', '1000000001', '12345678'));

  it('targets the hybrid GET for the flow', () => {
    expect(url.pathname).toBe('/api/automationplatform/v1/hybrid/1000000001');
  });

  it('sends portalId and clienttimeout', () => {
    expect(url.searchParams.get('portalId')).toBe('12345678');
    expect(url.searchParams.get('clienttimeout')).toBe('30000');
  });

  it('omits the telemetry version params', () => {
    // Pinning a version string guarantees a stale-value bug later.
    expect(url.searchParams.get('hs_static_app')).toBeNull();
    expect(url.searchParams.get('hs_static_app_version')).toBeNull();
  });
});

describe('inbounddbListUrl', () => {
  const url = new URL(inbounddbListUrl('https://app-na2.hubspot.com', '4242', '12345678'));

  it('targets the definition GET for the list, on the page own origin', () => {
    expect(url.origin).toBe('https://app-na2.hubspot.com');
    expect(url.pathname).toBe('/api/inbounddb-lists/v1/lists/4242');
  });

  it('sends portalId and the observed clienttimeout', () => {
    expect(url.searchParams.get('portalId')).toBe('12345678');
    expect(url.searchParams.get('clienttimeout')).toBe('14000');
  });

  it('omits the telemetry version params, and its own URL classifies as a list load', () => {
    expect(url.searchParams.get('hs_static_app')).toBeNull();
    expect(url.searchParams.get('hs_static_app_version')).toBeNull();
    // The refetch must land on the same pattern the capture uses, or a refresh
    // could fetch something the interceptor would not have kept.
    expect(classifyUrl(url.href, LIST_PAGE).domain).toBe('list');
  });
});

describe('idsFromPageUrl: workflows', () => {
  it('reads portal and flow out of the editor URL', () => {
    expect(idsFromPageUrl(PAGE)).toEqual({
      app: 'workflows',
      portalId: '12345678',
      flowId: '1000000001',
      legacyId: null,
      listId: null,
      legacyListId: null,
      objectTypeId: null,
      objectId: null,
    });
  });

  it('does not pass a legacy workflow ID off as a flow ID', () => {
    const ids = idsFromPageUrl('https://app.hubspot.com/workflows/12345678/edit/771000001');
    expect(ids.flowId).toBeNull();
    expect(ids.legacyId).toBe('771000001');
  });

  it('returns nulls on the workflow list page rather than guessing', () => {
    const ids = idsFromPageUrl('https://app.hubspot.com/workflows/12345678');
    expect(ids.app).toBe('workflows');
    expect(ids.portalId).toBe('12345678');
    expect(ids.flowId).toBeNull();
  });

  it('survives a URL it cannot parse', () => {
    expect(idsFromPageUrl('nonsense')).toEqual({
      app: null,
      portalId: null,
      flowId: null,
      legacyId: null,
      listId: null,
      legacyListId: null,
      objectTypeId: null,
      objectId: null,
    });
  });
});

describe('idsFromPageUrl: segments (lists)', () => {
  it('reads portal and list out of the details and filters pages', () => {
    for (const href of [
      'https://app.hubspot.com/contacts/12345678/objectLists/4242',
      'https://app.hubspot.com/contacts/12345678/objectLists/4242/filters',
      'https://app-na2.hubspot.com/contacts/12345678/objectLists/4242/performance',
    ]) {
      const ids = idsFromPageUrl(href);
      expect(ids.app, href).toBe('contacts');
      expect(ids.portalId, href).toBe('12345678');
      expect(ids.listId, href).toBe('4242');
      expect(ids.flowId, href).toBeNull();
    }
  });

  it('does not pass a legacy list ID off as an ILS list ID', () => {
    // /contacts/{portal}/lists/{id} carries the legacy id space, like the
    // legacy workflow URLs. The staleness guard must never compare it against
    // a captured ILS listId.
    const ids = idsFromPageUrl('https://app.hubspot.com/contacts/12345678/lists/771000001');
    expect(ids.listId).toBeNull();
    expect(ids.legacyListId).toBe('771000001');
  });

  it('returns no list id on the lists index page rather than guessing', () => {
    const ids = idsFromPageUrl('https://app.hubspot.com/contacts/12345678/objectLists');
    expect(ids.app).toBe('contacts');
    expect(ids.listId).toBeNull();
  });

  it('reads the number after the portal as the list on the newer lists and segments roots', () => {
    // Provisional, and deliberate: a wrong guess makes the guards hide a
    // valid capture, which a reload recovers; reading nothing would leave the
    // subject-vs-hydration guard inert, and a referenced list could silently
    // take the open segment's place.
    for (const href of [
      'https://app.hubspot.com/segments/12345678/4242',
      'https://app.hubspot.com/segments/12345678/4242/filters',
      'https://app.hubspot.com/lists/12345678/4242',
    ]) {
      const ids = idsFromPageUrl(href);
      expect(ids.portalId, href).toBe('12345678');
      expect(ids.listId, href).toBe('4242');
    }

    // The index pages carry only the portal.
    const index = idsFromPageUrl('https://app.hubspot.com/lists/12345678');
    expect(index.app).toBe('lists');
    expect(index.portalId).toBe('12345678');
    expect(index.listId).toBeNull();
    expect(idsFromPageUrl('https://app.hubspot.com/segments/12345678/4242').app).toBe('segments');
  });

  it('does not read a record page as a list page', () => {
    const ids = idsFromPageUrl('https://app.hubspot.com/contacts/12345678/record/0-1/4242');
    expect(ids.app).toBe('contacts');
    expect(ids.listId).toBeNull();
    expect(ids.flowId).toBeNull();
    // It reads as what it is instead.
    expect(ids.objectTypeId).toBe('0-1');
    expect(ids.objectId).toBe('4242');
  });
});

describe('idsFromPageUrl: records', () => {
  it('reads the type and id pair, with or without a trailing path', () => {
    for (const href of [
      RECORD_PAGE,
      `${RECORD_PAGE}/`,
      // SPA navigation appends query params the initial load does not carry;
      // measured live, and the parser reads the pathname only.
      `${RECORD_PAGE}?portalId=12345678&clienttimeout=14000`,
    ]) {
      const ids = idsFromPageUrl(href);
      expect(ids.app, href).toBe('contacts');
      expect(ids.portalId, href).toBe('12345678');
      expect(ids.objectTypeId, href).toBe('0-1');
      expect(ids.objectId, href).toBe('9101');
      expect(ids.listId, href).toBeNull();
    }
  });

  it('reads a custom object type the same way', () => {
    const ids = idsFromPageUrl('https://app.hubspot.com/contacts/12345678/record/2-7701/9303');
    expect(ids.objectTypeId).toBe('2-7701');
    expect(ids.objectId).toBe('9303');
  });

  it('returns the pair both-or-neither', () => {
    // A truncated record URL yields no pair at all, never half of one: the
    // record guards fail closed, and a partial pair would let a comparison
    // half-fire.
    for (const href of [
      'https://app.hubspot.com/contacts/12345678/record/0-1',
      'https://app.hubspot.com/contacts/12345678/record',
      'https://app.hubspot.com/contacts/12345678/record/01/9101',
    ]) {
      const ids = idsFromPageUrl(href);
      expect(ids.objectTypeId, href).toBeNull();
      expect(ids.objectId, href).toBeNull();
    }
  });

  it('reads no pair from index, board, or workflow pages', () => {
    for (const href of [
      'https://app.hubspot.com/contacts/12345678/objects/0-1/views/all/list',
      'https://app.hubspot.com/contacts/12345678/objectLists/4242',
      PAGE,
    ]) {
      const ids = idsFromPageUrl(href);
      expect(ids.objectTypeId, href).toBeNull();
      expect(ids.objectId, href).toBeNull();
    }
  });
});
