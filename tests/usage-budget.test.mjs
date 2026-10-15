import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertDemoOpen, reserveDemoProviderCall, settleDemoProviderCall,
  reserveDemoAnalysis, releaseDemoAnalysis,
} from '../projects/propertyvision/usage-budget.js';

const payload = { generationConfig: { maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } } };
function withLedger(run, patch = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'portfolio-budget-'));
  const file = path.join(dir, 'fictional-usage.json');
  const keys = ['PV_LOCAL_DEMO', 'PV_DEMO_EXPIRES_AT', 'PV_DEMO_LEDGER'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PV_LOCAL_DEMO = 'true';
  process.env.PV_DEMO_EXPIRES_AT = 'none';
  process.env.PV_DEMO_LEDGER = file;
  const state = {
    vertex: 0, maps: 0, grounded: 0,
    monthly: { month: new Date().toISOString().slice(0, 7), vertexMicros: 0, mapsMicros: 0, reservations: {} },
    ...patch,
  };
  fs.writeFileSync(file, JSON.stringify(state));
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  try { run({ file, read, state }); }
  finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('PropertyVision reserves estimated usage before a provider call', () => withLedger(({ read }) => {
  const id = reserveDemoProviderCall('vertex', payload, 'gemini-2.5-flash');
  assert.equal(read().monthly.vertexMicros, 40000);
  assert.equal(read().monthly.reservations[id].cost, 40000);
  assert.equal(read().vertex, 1);
}));

test('PropertyVision retains estimated charges when the provider outcome is unknown', () => withLedger(({ read }) => {
  const id = reserveDemoProviderCall('vertex', payload, 'gemini-2.5-flash');
  settleDemoProviderCall(id, {});
  assert.equal(read().monthly.vertexMicros, 40000);
}));

test('PropertyVision rejects exhausted usage allowance without increasing counters', () => withLedger(({ file, read, state }) => {
  state.monthly.vertexMicros = 9000000;
  fs.writeFileSync(file, JSON.stringify(state));
  assert.throws(() => reserveDemoProviderCall('vertex', payload, 'gemini-2.5-flash'), /DEMO_REQUEST_LIMIT/);
  assert.equal(read().vertex, 0);
  assert.equal(read().monthly.vertexMicros, 9000000);
}));

test('PropertyVision rejects oversized input and unknown providers', () => withLedger(({ read }) => {
  assert.throws(() => reserveDemoProviderCall('unknown', payload), /DEMO_INVALID_PROVIDER/);
  assert.throws(() => reserveDemoProviderCall('vertex', { ...payload, text: 'x'.repeat(32001) }, 'gemini-2.5-flash'), /DEMO_INPUT_LIMIT/);
  assert.equal(read().vertex, 0);
}));

test('PropertyVision admits one analysis and requires its identifier to release it', () => withLedger(({ read }) => {
  reserveDemoAnalysis('fictional-job-a');
  assert.throws(() => reserveDemoAnalysis('fictional-job-b'), /DEMO_BUSY/);
  releaseDemoAnalysis('fictional-job-b');
  assert.equal(read().activeAnalysis, 'fictional-job-a');
  releaseDemoAnalysis('fictional-job-a');
  reserveDemoAnalysis('fictional-job-b');
  assert.equal(read().activeAnalysis, 'fictional-job-b');
}));

test('PropertyVision refuses expired access and invalid accounting state', () => withLedger(({ file }) => {
  process.env.PV_DEMO_EXPIRES_AT = '2000-01-01T00:00:00Z';
  assert.throws(assertDemoOpen, /DEMO_CLOSED/);
  process.env.PV_DEMO_EXPIRES_AT = 'none';
  fs.writeFileSync(file, JSON.stringify({ vertex: -1, maps: 0, grounded: 0 }));
  assert.throws(() => reserveDemoProviderCall('maps'), /DEMO_LEDGER_INVALID/);
}));

test('PropertyVision refuses a locked usage ledger', () => withLedger(({ file, read }) => {
  fs.writeFileSync(file + '.lock', 'fictional lock');
  assert.throws(() => reserveDemoProviderCall('maps'), /DEMO_BUSY/);
  assert.equal(read().maps, 0);
}));
