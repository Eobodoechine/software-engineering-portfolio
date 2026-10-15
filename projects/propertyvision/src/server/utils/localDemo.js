// Optional local or cloud credentials and persistent request limits for a bounded demo.
// Tokens are minted for a dedicated service account and never logged or written.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const runFile = promisify(execFile);
let tokenPromise;
let cachedToken;
let tokenExpiresAt = 0;

export function localDemoEnabled() {
  return process.env.PV_LOCAL_DEMO === 'true';
}

export function assertDemoOpen() {
  if (!localDemoEnabled()) return;
  // Explicit ongoing-hosting approval removes only the date cutoff, not usage limits.
  if (process.env.PV_DEMO_EXPIRES_AT === 'none') return;
  const expiresAt = Date.parse(process.env.PV_DEMO_EXPIRES_AT || '');
  if (!Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    throw new Error('DEMO_CLOSED: The authorized demo window has ended.');
  }
}

export async function getLocalDemoToken() {
  assertDemoOpen();
  if (process.env.PV_DEMO_AUTH === 'metadata') {
    if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
    if (!tokenPromise) {
      tokenPromise = fetch('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token', {
        headers: { 'Metadata-Flavor': 'Google' }, signal: AbortSignal.timeout(5000),
      }).then(async response => {
        if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') throw new Error('DEMO_AUTH_FAILED');
        const token = await response.json();
        if (typeof token.access_token !== 'string' || !Number.isFinite(token.expires_in) || token.expires_in < 120) throw new Error('DEMO_AUTH_FAILED');
        cachedToken = token.access_token;
        tokenExpiresAt = Date.now() + (Math.min(token.expires_in, 3600) - 60) * 1000;
        return cachedToken;
      }).catch(() => { throw new Error('DEMO_AUTH_FAILED: Cloud identity is unavailable.'); })
        .finally(() => { tokenPromise = undefined; });
    }
    return tokenPromise;
  }
  const account = process.env.PV_GCLOUD_ACCOUNT;
  const serviceAccount = process.env.PV_GCLOUD_SERVICE_ACCOUNT;
  if (!account || !serviceAccount?.endsWith('.iam.gserviceaccount.com')) {
    throw new Error('DEMO_AUTH_CONFIG: A dedicated service account is required.');
  }
  if (cachedToken && Date.now() < tokenExpiresAt) return cachedToken;
  if (!tokenPromise) {
    tokenPromise = runFile(process.env.PV_GCLOUD_BIN || 'gcloud', [
      'auth', 'print-access-token', `--account=${account}`,
      `--impersonate-service-account=${serviceAccount}`, '--quiet',
    ], { timeout: 30000, maxBuffer: 65536 }).then(({ stdout }) => {
      const value = stdout.trim();
      if (!value || /\s/.test(value)) throw new Error('DEMO_AUTH_FAILED');
      cachedToken = value;
      tokenExpiresAt = Date.now() + 50 * 60 * 1000;
      return value;
    }).catch(() => {
      // Child-process errors can include stdout, so never propagate them.
      throw new Error('DEMO_AUTH_FAILED: Refresh the approved Google login.');
    }).finally(() => { tokenPromise = undefined; });
  }
  return tokenPromise;
}

// All money values are integer microdollars. Google budget alerts remain a second layer.
// Conservative ceiling: <=32k UTF-8 input bytes, <=8192 output tokens, Gemini 2.5 Flash.
const VERTEX_MONTHLY = 9_000_000;
const MAPS_MONTHLY = 1_000_000;
const VERTEX_RESERVATION = 40_000;
const GROUNDING_RESERVATION = 35_000;
const MAPS_RESERVATION = 5_000;

function updateLedger(action) {
  const path = process.env.PV_DEMO_LEDGER;
  if (!path) throw new Error('DEMO_LEDGER_REQUIRED');
  let lock;
  try {
    try { lock = fs.openSync(`${path}.lock`, 'wx', 0o600); }
    catch { throw new Error('DEMO_BUSY: Another request is updating usage. Please retry shortly.'); }
    const state = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (!['vertex', 'maps', 'grounded'].every(k => Number.isSafeInteger(state[k]) && state[k] >= 0)) {
      throw new Error('DEMO_LEDGER_INVALID: Usage accounting is unavailable.');
    }
    const month = new Date().toISOString().slice(0, 7);
    if (!state.monthly) {
      // Preserve all previous charges conservatively; never reset legacy usage on upgrade.
      state.monthly = { month, vertexMicros: state.vertex * VERTEX_RESERVATION + state.grounded * GROUNDING_RESERVATION, mapsMicros: state.maps * MAPS_RESERVATION, reservations: {} };
    }
    const m = state.monthly;
    if (!/^\d{4}-\d{2}$/.test(m.month) || !['vertexMicros','mapsMicros'].every(k => Number.isSafeInteger(m[k]) && m[k] >= 0) || !m.reservations || typeof m.reservations !== 'object') {
      throw new Error('DEMO_LEDGER_INVALID: Usage accounting is unavailable.');
    }
    if (m.month > month) throw new Error('DEMO_LEDGER_INVALID: Usage month is ahead of the server clock.');
    if (m.month < month && !state.activeAnalysis && Object.keys(m.reservations).length === 0) {
      state.monthlyHistory = { ...state.monthlyHistory, [m.month]: m };
      state.monthly = { month, vertexMicros: 0, mapsMicros: 0, reservations: {} };
    }
    const result = action(state);
    state.updatedAt = new Date().toISOString();
    const tmp = `${path}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, path);
    return result;
  } finally {
    if (lock !== undefined) { fs.closeSync(lock); fs.unlinkSync(`${path}.lock`); }
  }
}

export function reserveDemoProviderCall(kind, payload, model = process.env.VERTEX_MODEL) {
  if (!localDemoEnabled()) return;
  assertDemoOpen();
  if (!['vertex', 'maps'].includes(kind)) throw new Error('DEMO_INVALID_PROVIDER');
  if (kind === 'vertex' && (Buffer.byteLength(JSON.stringify(payload || {})) > 32000 || (!Number.isSafeInteger(payload?.generationConfig?.maxOutputTokens) || payload.generationConfig.maxOutputTokens < 1 || payload.generationConfig.maxOutputTokens > 8192) || payload?.generationConfig?.thinkingConfig?.thinkingBudget !== (model === 'gemini-2.5-pro' ? 128 : 0) || !['gemini-2.5-flash', 'gemini-2.5-pro'].includes(model))) {
    throw new Error('DEMO_INPUT_LIMIT: Request exceeds the configured model or input allowance.');
  }
  return updateLedger(state => {
    const grounded = kind === 'vertex' && Boolean(payload?.tools?.length);
    const cost = kind === 'maps' ? MAPS_RESERVATION : (model === 'gemini-2.5-pro' ? 130_000 : VERTEX_RESERVATION) + (grounded ? GROUNDING_RESERVATION : 0);
    const field = kind === 'maps' ? 'mapsMicros' : 'vertexMicros';
    const cap = kind === 'maps' ? MAPS_MONTHLY : VERTEX_MONTHLY;
    if (state.monthly[field] + cost > cap) throw new Error('DEMO_REQUEST_LIMIT: The monthly analysis budget is exhausted. Saved reports remain available.');
    state.monthly[field] += cost;
    state[kind] += 1;
    if (grounded) state.grounded += 1;
    if (kind === 'maps') return undefined;
    const id = `${Date.now()}-${process.pid}-${state.vertex}`;
    state.monthly.reservations[id] = { cost, grounded, model };
    return id;
  });
}

export function settleDemoProviderCall(id, response) {
  if (!localDemoEnabled() || !id) return;
  updateLedger(state => {
    const reservation = state.monthly.reservations[id];
    if (!reservation) return;
    const usage = response?.usageMetadata;
    const input = usage?.promptTokenCount;
    const output = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0);
    // Google does not bill explicit 4xx/5xx responses. Unknown network outcomes
    // retain their reservation; only verified responses can release money.
    if (Number.isInteger(response?.error?.code) && response.error.code >= 400 && response.error.code <= 599) {
      state.monthly.vertexMicros -= reservation.cost;
    } else if (response?.candidates?.length && Number.isSafeInteger(input) && input >= 0 && Number.isSafeInteger(output) && output >= 0) {
      const actual = Math.ceil(input * (reservation.model === 'gemini-2.5-pro' ? 1.25 : 0.30) + output * (reservation.model === 'gemini-2.5-pro' ? 10 : 2.50)) + (reservation.grounded ? GROUNDING_RESERVATION : 0);
      state.monthly.vertexMicros -= Math.max(0, reservation.cost - actual);
    }
    delete state.monthly.reservations[id];
  });
}

export function reserveDemoAnalysis(id) {
  if (!localDemoEnabled()) return;
  assertDemoOpen();
  if (!id) throw new Error('DEMO_INVALID_ANALYSIS');
  updateLedger(state => {
    if (state.activeAnalysis) throw new Error('DEMO_BUSY: Another analysis is running. Please try again when it finishes.');
    if (state.monthly.vertexMicros > VERTEX_MONTHLY - 500_000 || state.monthly.mapsMicros > MAPS_MONTHLY - 100_000) {
      throw new Error('DEMO_REQUEST_LIMIT: The monthly analysis budget is nearly used. Saved reports remain available.');
    }
    state.activeAnalysis = id;
    state.lastAnalysisAt = Date.now();
  });
}

export function releaseDemoAnalysis(id) {
  if (!localDemoEnabled() || !id) return;
  updateLedger(state => { if (state.activeAnalysis === id) delete state.activeAnalysis; });
}
