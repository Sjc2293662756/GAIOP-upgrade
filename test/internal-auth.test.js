const test = require('node:test');
const assert = require('node:assert/strict');

function loadMiddleware(token) {
  process.env.GAIOP_UPGRADE_INTERNAL_TOKEN = token;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/middleware/auth')];
  return require('../src/middleware/auth');
}

function run(middleware, path, headers = {}) {
  const req = { path, headers, ip: '127.0.0.1' };
  let status = null;
  let body = null;
  let nextCalled = false;
  const res = {
    status(code) { status = code; return this; },
    json(value) { body = value; return this; },
  };
  middleware(req, res, () => { nextCalled = true; });
  return { req, status, body, nextCalled };
}

test('internal token protects upgrade routes and keeps health probe available', () => {
  const middleware = loadMiddleware('test-only-token');
  assert.equal(run(middleware, '/health').nextCalled, true);
  assert.equal(run(middleware, '/api/v1/upgrade/status').status, 401);
  const allowed = run(middleware, '/api/v1/upgrade/status', {
    'x-gaiop-upgrade-token': 'test-only-token',
    'x-gaiop-upgrade-actor': 'admin',
  });
  assert.equal(allowed.nextCalled, true);
  assert.equal(allowed.req.operator, 'admin');
});
