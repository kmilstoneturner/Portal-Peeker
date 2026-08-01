import { describe, expect, it } from 'vitest';
import { classifyUrl, hybridUrl, idsFromPageUrl } from '../src/endpoints.js';

const PAGE = 'https://app.hubspot.com/workflows/12345678/platform/flow/1000000001/edit';

describe('classifyUrl', () => {
  it('matches the editor-load GET and pulls the flow ID from the path', () => {
    const hit = classifyUrl('/api/automationplatform/v1/hybrid/1000000001?portalId=12345678', PAGE);
    expect(hit.kind).toBe('load');
    expect(hit.flowId).toBe('1000000001');
  });

  it('matches the save POST, which has no flow ID in the path', () => {
    const hit = classifyUrl(
      'https://app.hubspot.com/api/automationplatform/v1/hybrid/batch?sourceapp=WORKFLOWS_APP',
      PAGE,
    );
    expect(hit.kind).toBe('save');
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

describe('idsFromPageUrl', () => {
  it('reads portal and flow out of the editor URL', () => {
    expect(idsFromPageUrl(PAGE)).toEqual({
      portalId: '12345678',
      flowId: '1000000001',
      legacyId: null,
    });
  });

  it('does not pass a legacy workflow ID off as a flow ID', () => {
    const ids = idsFromPageUrl('https://app.hubspot.com/workflows/12345678/edit/771000001');
    expect(ids.flowId).toBeNull();
    expect(ids.legacyId).toBe('771000001');
  });

  it('returns nulls on the workflow list page rather than guessing', () => {
    const ids = idsFromPageUrl('https://app.hubspot.com/workflows/12345678');
    expect(ids.portalId).toBe('12345678');
    expect(ids.flowId).toBeNull();
  });

  it('survives a URL it cannot parse', () => {
    expect(idsFromPageUrl('nonsense')).toEqual({ portalId: null, flowId: null, legacyId: null });
  });
});
