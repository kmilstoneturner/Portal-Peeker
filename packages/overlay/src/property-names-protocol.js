// The one message contract between the property-names interceptor and the
// overlay. One file, so a rename cannot silently desync two sides of a channel,
// which is the same reason packages/capture/src/protocol.js exists.
//
// This is a SEPARATE channel from the capture one on purpose. They carry
// different things to different consumers, and sharing a channel would mean a
// bridge and an overlay each having to ignore the other's traffic.

/** Namespaced, so unrelated page postMessages are rejected in one comparison. */
export const PROPERTY_NAMES_CHANNEL = 'portal-peeker/property-names/v1';

// Two directions, and the REQUEST one is the point.
//
// The interceptor buffers what it sees and sends NOTHING until asked. The
// overlay asks only once the user has switched the setting on. So on a record
// page with the feature off, which is the default, nothing crosses the world
// boundary at all: the buffer lives in the page's own memory, holding a copy of
// something the page already has, and dies with the tab.
export const PROPERTY_NAMES_MSG = {
  /** overlay -> interceptor: send me what you have, and anything that follows. */
  REQUEST: 'properties-request',
  /** interceptor -> overlay */
  LOADED: 'properties-loaded',
};
