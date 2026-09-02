'use strict';

/**
 * Device → adapter dispatch.
 *
 * One place that answers "the member said they use a Fitbit and sent us this
 * buffer — who parses it, and what do we tell them if we cannot?"
 *
 * Every adapter is loaded LAZILY and behind a try/catch, matching the pattern
 * routes/wearables.js already uses for the optional PDF extractor. That is not
 * defensiveness for its own sake: adapters are being added incrementally, and a
 * deployment that is missing one must still serve every other device rather than
 * crashing the whole app at require time. A missing adapter produces an honest
 * "we cannot read this here yet" for that one device.
 *
 * Adapter contract (see services/wearables/canonicalDay.js):
 *
 *   module.exports.parse(files, opts) -> { days, workouts, journal, summary, rejected }
 *
 * where `files` is `[{name, text}]` and/or `[{name, buffer}]`. The result MUST pass
 * canonicalDay.validateParsedExport(); this module verifies that on every call, so
 * a non-compliant adapter is caught at the seam rather than corrupting a member's
 * readiness history.
 *
 * @module services/wearables/adapterRegistry
 */

const C = require('./canonicalDay');

/**
 * provider id -> module path, relative to this file.
 *
 * `screenshot` is deliberately absent: vision extraction does not take a file list
 * and is not a drop-in `parse(files)`, so it is dispatched separately by the route
 * through services/wearables/deviceVisionExtract.js.
 */
const ADAPTER_PATHS = {
  whoop: './adapters/whoop',
  oura: './adapters/oura',
  fitbit: './adapters/fitbit',
  garmin: './adapters/garmin',
  polar: './adapters/polar',
  amazfit: './adapters/amazfit',
  apple_health: './adapters/appleHealth',
  health_connect: './adapters/healthConnect',
  samsung_health: './adapters/samsungHealth',
  generic_csv: './adapters/genericCsv'
};

/** Resolved modules, cached. `null` means "we tried and it is not deployed". */
const cache = Object.create(null);

/**
 * Load an adapter, or null when it is not deployed in this build.
 * @param {string} provider
 * @returns {Object|null}
 */
function loadAdapter(provider) {
  const key = String(provider || '');
  if (key in cache) return cache[key];

  const modPath = ADAPTER_PATHS[key];
  if (!modPath) { cache[key] = null; return null; }

  let mod = null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    mod = require(modPath);
  } catch (e) {
    // MODULE_NOT_FOUND is expected while adapters are landing incrementally.
    // Anything else is a real fault in a deployed adapter and must be loud, or a
    // syntax error in one adapter silently degrades that device to "unsupported"
    // and nobody finds out until a member complains.
    const notFound = e && e.code === 'MODULE_NOT_FOUND' && new RegExp(modPath.replace('./', '')).test(String(e.message));
    if (!notFound) {
      console.error('[wearables] adapter "' + key + '" failed to load:', e && e.message);
    }
    mod = null;
  }

  if (mod && typeof mod.parse !== 'function') {
    console.error('[wearables] adapter "' + key + '" does not export parse()');
    mod = null;
  }
  cache[key] = mod;
  return mod;
}

/** Which providers can actually be parsed in THIS deployment, right now. */
function availableProviders() {
  return Object.keys(ADAPTER_PATHS).filter((p) => loadAdapter(p) !== null);
}

/** Is there a working file adapter for this provider in this build? */
function isSupported(provider) {
  return loadAdapter(provider) !== null;
}

/**
 * Parse an upload for a declared device.
 *
 * Never throws. Every failure path returns a contract-valid empty result carrying
 * an explanation in `summary.notes`, plus `ok:false` and a typed `code`, so the
 * route can map it to an honest HTTP status instead of a generic 422.
 *
 * @param {string} provider  a canonicalDay.PROVIDERS id
 * @param {Array}  files     [{name, text}] and/or [{name, buffer}]
 * @param {Object} [opts]    passed through to the adapter
 * @returns {{ok:boolean, code:string|null, provider:string, parsed:Object, contract:Object}}
 */
function parseForDevice(provider, files, opts) {
  const id = String(provider || '');

  if (C.PROVIDERS.indexOf(id) === -1) {
    return {
      ok: false,
      code: 'UNKNOWN_DEVICE',
      provider: id,
      parsed: C.emptyParsedExport('manual', ['"' + id + '" is not a device BodyBank knows about.']),
      contract: { ok: true, errors: [] }
    };
  }

  const adapter = loadAdapter(id);
  if (!adapter) {
    return {
      ok: false,
      code: 'DEVICE_NOT_SUPPORTED_HERE',
      provider: id,
      parsed: C.emptyParsedExport(id, [
        'This deployment cannot read ' + id + ' files yet. Try uploading a screenshot instead.'
      ]),
      contract: { ok: true, errors: [] }
    };
  }

  let parsed;
  try {
    parsed = adapter.parse(files, opts || {});
  } catch (e) {
    // An adapter that throws is a bug, but it must not take the request with it.
    console.error('[wearables] adapter "' + id + '" threw:', e && e.stack);
    return {
      ok: false,
      code: 'ADAPTER_FAILED',
      provider: id,
      parsed: C.emptyParsedExport(id, ['We could not read this file.']),
      contract: { ok: true, errors: [] }
    };
  }

  // The seam check. An adapter that drifts from the contract is caught HERE,
  // before readinessService writes anything, rather than surfacing weeks later as
  // an impossible number in a member's PDF.
  const contract = C.validateParsedExport(parsed);
  if (!contract.ok) {
    console.error('[wearables] adapter "' + id + '" returned a non-compliant result:',
      contract.errors.slice(0, 10));
    return {
      ok: false,
      code: 'ADAPTER_CONTRACT_VIOLATION',
      provider: id,
      parsed: C.emptyParsedExport(id, ['We could not read this file reliably, so nothing was saved.']),
      contract: contract
    };
  }

  return { ok: true, code: null, provider: id, parsed: parsed, contract: contract };
}

module.exports = {
  ADAPTER_PATHS,
  loadAdapter,
  availableProviders,
  isSupported,
  parseForDevice
};
