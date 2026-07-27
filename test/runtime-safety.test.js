const test = require('node:test');
const assert = require('node:assert/strict');
const { assertProductionSafety } = require('../src/runtime-safety');

test('production runtime requires the Admin BFF internal token', () => {
  assert.throws(
    () => assertProductionSafety({ NODE_ENV: 'production' }),
    /GAIOP_UPGRADE_INTERNAL_TOKEN/,
  );
  assert.doesNotThrow(() => assertProductionSafety({
    NODE_ENV: 'production',
    GAIOP_UPGRADE_INTERNAL_TOKEN: 'test-only-token',
  }));
  assert.doesNotThrow(() => assertProductionSafety({ NODE_ENV: 'development' }));
});
