// The explicit Live host command: the one place a designation changes.
//
// It reads the node's current revision and writes with THAT one, in one call.
// The store is a compare-and-swap (lib/live-host/store.js): a revision read in
// an earlier render is a 409 by construction, so "GET first" is not politeness,
// it is the contract.
//
// Outcomes are i18n KEYS, never sentences: the caller shows them where it has
// room (a notice line, a popup status). Nothing here touches the DOM, and the API
// is injected so the mapping can be tested without a server.
import { getLiveHost, designateHostCell, clearHostCell } from './api.js';
import { hostDesignationFailureMessage } from './host-designation.js';

export function liveHostCommandErrorKey(error) {
  const status = error && error.status;
  const reason = error && error.data && typeof error.data === 'object' ? error.data.reason : null;
  if (reason === 'live-host-not-granted') return 'live-host-not-granted';
  if (status === 409) return 'live-host-stale-revision';
  if (status === 404) return 'live-host-not-local';
  if (status === 503) return 'live-host-unavailable';
  return hostDesignationFailureMessage(error);
}

export async function runLiveHostCommand({ action, cellId, route = [], token, api = {} } = {}) {
  const read = api.getLiveHost || ((r) => getLiveHost(token, r));
  const designate = api.designateHostCell || ((id, revision, r) => designateHostCell(token, id, revision, r));
  const clear = api.clearHostCell || ((revision, r) => clearHostCell(token, revision, r));
  let current;
  try {
    current = await read(route);
  } catch (error) {
    // Nothing was written: the revision is unknown, so there is nothing to write
    // with — and saying so is an outcome, not a failure of the command.
    return { ok: false, messageKey: liveHostCommandErrorKey(error), error };
  }
  const revision = Number.isInteger(current && current.revision) ? current.revision : 0;
  try {
    if (action === 'remove') {
      const out = await clear(revision, route);
      return {
        ok: true, messageKey: 'live-host-cleared',
        hostCell: out && typeof out.hostCell === 'string' ? out.hostCell : null,
        revision: out && out.revision,
      };
    }
    const out = await designate(cellId, revision, route);
    return {
      ok: true, messageKey: 'live-host-designated',
      hostCell: out && typeof out.hostCell === 'string' ? out.hostCell : cellId,
      revision: out && out.revision,
    };
  } catch (error) {
    return { ok: false, messageKey: liveHostCommandErrorKey(error), error };
  }
}
