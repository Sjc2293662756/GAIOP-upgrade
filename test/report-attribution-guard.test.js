const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const { checkReportAttributionGuard } = require('../src/services/ReportAttributionGuard');

function config(indexPath, overrides = {}) {
  return {
    reportAttributionRequired: true,
    reportAttributionIndexPath: indexPath,
    reportAttributionMaxAgeMs: 30000,
    ...overrides,
  };
}

describe('ReportAttributionGuard', () => {
  it('disabled deployments remain compatible', () => {
    assert.deepStrictEqual(checkReportAttributionGuard({ reportAttributionRequired: false }), { enabled: false });
  });

  it('accepts a fresh compatible sidecar index', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-attribution-guard-'));
    const indexPath = path.join(directory, 'index.json');
    const now = Date.now();
    fs.writeFileSync(indexPath, JSON.stringify({
      schemaVersion: 'gaiop.report-attribution.v1',
      updatedAt: new Date(now - 1000).toISOString(),
      entries: [{ reportId: 'report-a' }],
    }));
    assert.deepStrictEqual(checkReportAttributionGuard(config(indexPath), now), {
      enabled: true,
      entries: 1,
      updatedAt: now - 1000,
    });
  });

  it('rejects stale or incompatible indexes', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gaiop-attribution-guard-invalid-'));
    const indexPath = path.join(directory, 'index.json');
    const now = Date.now();
    fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: 'old', updatedAt: new Date(now).toISOString(), entries: [] }));
    assert.throws(() => checkReportAttributionGuard(config(indexPath), now), /契约不兼容/);
    fs.writeFileSync(indexPath, JSON.stringify({ schemaVersion: 'gaiop.report-attribution.v1', updatedAt: new Date(now - 60000).toISOString(), entries: [] }));
    assert.throws(() => checkReportAttributionGuard(config(indexPath), now), /停止刷新/);
  });
});
