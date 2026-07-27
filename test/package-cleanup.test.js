const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanupSuccessfulPackage } = require('../src/services/PackageCleaner');

test('validated package is removed only after a successful upgrade', () => {
  const removed = [];
  const unlink = (value) => removed.push(value);

  assert.equal(cleanupSuccessfulPackage({ status: 'success' }, '/packages/success.zip', unlink), true);
  assert.equal(cleanupSuccessfulPackage({ status: 'failed' }, '/packages/failed.zip', unlink), false);
  assert.equal(cleanupSuccessfulPackage({ status: 'rolled_back' }, '/packages/rollback.zip', unlink), false);
  assert.deepEqual(removed, ['/packages/success.zip']);
});

test('package cleanup failure does not replace a completed upgrade result', () => {
  const unlink = () => { throw new Error('simulated cleanup failure'); };
  assert.equal(cleanupSuccessfulPackage({ status: 'success' }, '/packages/success.zip', unlink), false);
});
