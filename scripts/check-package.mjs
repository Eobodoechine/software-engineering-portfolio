import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'provenance.json'), 'utf8'));
for (const entry of manifest.samples) {
  const bytes = fs.readFileSync(path.join(root, entry.sample_path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sample_sha256, entry.sample_path);
}
const forbidden = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}|sk_live_[A-Za-z0-9]{20,}/;
assert.equal(forbidden.test('ghp_' + 'a'.repeat(36)), true, 'Secret-pattern negative control must fire');
const allowed = new Set([
  '.gitignore', 'README.md', 'VERIFICATION.md', 'package.json', 'package-lock.json', 'deno.lock', 'provenance.json',
  'vitest.config.ts', 'scripts/check-package.mjs', 'tests/samples.test.mjs', 'tests/usage-budget.test.mjs',
  'projects/propertyvision/README.md', 'projects/propertyvision/SYSTEM.md',
  'projects/taxahead/README.md', 'projects/pasturepact/README.md',
  ...manifest.samples.map(entry => entry.sample_path),
]);

function walk(dir, prefix = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const relative = prefix + entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), relative + '/');
    else {
      assert.equal(allowed.has(relative), true, 'Unexpected file: ' + relative);
      const text = fs.readFileSync(path.join(dir, entry.name), 'utf8');
      assert.equal(forbidden.test(text), false, 'Credential pattern: ' + relative);
    }
  }
}
walk(root);
console.log('Package checks passed: source hashes, explicit file list, credential-pattern scan, and negative control.');
console.log('This bounded scan is not a guarantee against every possible sensitive-data pattern.');

