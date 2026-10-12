// ============================================================
// NOMI CORE — A2 CAPABILITY ENGINE
// Server-side reusable capability engine for local instance context
// ============================================================

/**
 * Default capability structure (fail-closed)
 * @returns {{entitled: boolean, ready: boolean, effective: boolean, limit: number|null}}
 */
function buildDefaultCapability() {
  return {
    entitled: false,
    ready: false,
    effective: false,
    limit: null
  };
}

/**
 * Load instance context from local Supabase instance
 * @param {Function} fetchSupabase - The fetcher from proxy.js (REST helper)
 * @returns {Promise<{instance: {tenantId: string, instanceId: string, environment: string, schemaVersion: string, appVersion: string}, capabilities: Object<string,{entitled:boolean,ready:boolean,effective:boolean,limit:number|null}>}>}
 */
export async function loadInstanceContext(fetchSupabase) {
  if (typeof fetchSupabase !== 'function') {
    throw new Error('loadInstanceContext requires fetchSupabase function');
  }

  let metadataRows;
  let capabilitiesRows;

  try {
    metadataRows = await fetchSupabase(
      'instance_metadata?id=eq.1&select=tenant_id,instance_id,environment,schema_version,app_version'
    );
  } catch (e) {
    throw new Error(`Cannot load instance_metadata: ${e.message || 'unknown error'}`);
  }

  try {
    capabilitiesRows = await fetchSupabase(
      'instance_capabilities?select=capability_key,entitled_enabled,entitled_limit_value,ready'
    );
  } catch (e) {
    throw new Error(`Cannot load instance_capabilities: ${e.message || 'unknown error'}`);
  }

  // Metadata validation
  if (!Array.isArray(metadataRows)) {
    throw new Error('instance_metadata response is not an array');
  }
  if (metadataRows.length !== 1) {
    throw new Error(`instance_metadata must have exactly 1 row; found ${metadataRows.length}`);
  }

  const m = metadataRows[0];
  const requiredMetadata = [
    'tenant_id',
    'instance_id',
    'environment',
    'schema_version',
    'app_version'
  ];
  for (const k of requiredMetadata) {
    if (m[k] === undefined || m[k] === null || m[k] === '') {
      throw new Error(`instance_metadata missing/invalid field: ${k}`);
    }
  }

  // Capabilities validation
  if (!Array.isArray(capabilitiesRows)) {
    throw new Error('instance_capabilities response is not an array');
  }

  const capabilities = {};
  for (const row of capabilitiesRows) {
    if (!row || typeof row !== 'object') {
      throw new Error('instance_capabilities contains malformed row');
    }
    if (typeof row.capability_key !== 'string' || row.capability_key.length === 0) {
      throw new Error('instance_capabilities contains row with missing capability_key');
    }

    const entitled = !!row.entitled_enabled;
    const ready = !!row.ready;
    const limit = (row.entitled_limit_value === undefined || row.entitled_limit_value === null)
      ? null
      : Number(row.entitled_limit_value);
    if (limit !== null && Number.isNaN(limit)) {
      throw new Error(`instance_capabilities.invalid_limit for key ${row.capability_key}`);
    }

    capabilities[row.capability_key] = {
      entitled,
      ready,
      effective: entitled && ready,
      limit
    };
  }

  return {
    instance: {
      tenantId: m.tenant_id,
      instanceId: m.instance_id,
      environment: m.environment,
      schemaVersion: m.schema_version,
      appVersion: m.app_version
    },
    capabilities
  };
}

/**
 * Check if capability is effective (fail-closed)
 */
export function isCapabilityEffective(context, key) {
  if (!context || typeof context !== 'object' || !context.capabilities || typeof context.capabilities !== 'object') {
    return false;
  }
  if (typeof key !== 'string' || key.length === 0) {
    return false;
  }
  const cap = context.capabilities[key];
  if (!cap || typeof cap !== 'object') {
    return false;
  }
  return !!cap.effective;
}

/**
 * Get capability limit (fail-closed to null if unknown/invalid)
 */
export function getCapabilityLimit(context, key) {
  if (!context || typeof context !== 'object' || !context.capabilities || typeof context.capabilities !== 'object') {
    return null;
  }
  if (typeof key !== 'string' || key.length === 0) {
    return null;
  }
  const cap = context.capabilities[key];
  if (!cap || typeof cap !== 'object') {
    return null;
  }
  if (cap.limit === null || cap.limit === undefined) {
    return null;
  }
  const num = Number(cap.limit);
  if (Number.isNaN(num)) {
    return null;
  }
  return num;
}
