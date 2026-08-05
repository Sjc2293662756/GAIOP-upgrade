const fs = require('fs');

const ATTRIBUTION_SCHEMA = 'gaiop.report-attribution.v1';

function checkReportAttributionGuard(config, now = Date.now()) {
  if (!config.reportAttributionRequired) return { enabled: false };
  const indexPath = config.reportAttributionIndexPath;
  if (!indexPath || !fs.existsSync(indexPath)) {
    throw new Error('报告归属适配服务不可用: 归属索引不存在');
  }
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    throw new Error('报告归属适配服务不可用: 归属索引不是有效 JSON');
  }
  if (payload?.schemaVersion !== ATTRIBUTION_SCHEMA || !Array.isArray(payload.entries)) {
    throw new Error('报告归属适配服务不可用: 归属索引契约不兼容');
  }
  const updatedAt = Date.parse(String(payload.updatedAt || ''));
  const maxAgeMs = Number(config.reportAttributionMaxAgeMs || 30000);
  if (!Number.isFinite(updatedAt) || now - updatedAt > maxAgeMs || updatedAt - now > 5000) {
    throw new Error('报告归属适配服务不可用: 归属索引已停止刷新');
  }
  return { enabled: true, entries: payload.entries.length, updatedAt };
}

module.exports = { ATTRIBUTION_SCHEMA, checkReportAttributionGuard };
