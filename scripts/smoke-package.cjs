const assert = require('node:assert/strict');

async function verify(label, api, headers, standalone) {
  assert.equal(typeof api.default, 'function', `${label}: default export`);
  assert.equal(typeof headers.createHeaderMapFns, 'function', `${label}: header export`);
  assert.equal(typeof standalone.addColumn, 'function', `${label}: standalone export`);
  const data = api.default.fromData([{ id: '1', profile: { name: 'Ada' } }]);
  assert.equal(data.toString({ headerMap: { id: 'ID', 'profile.name': 'Name' } }), 'ID,Name\n1,Ada');
  assert.deepEqual(headers.createHeaderMapFns({ ID: 'id' }).fromRowArr({ ID: '1' }), { id: '1' });
  assert.deepEqual(standalone.addColumn([{ id: 1 }], 'extra', 2), [{ id: 1, extra: 2 }]);
  const input = Array.from({ length: 10001 }, (_, index) => ({ id: 10000 - index }));
  const originalWarn = console.warn;
  let warned = false;
  console.warn = (...args) => { warned = true; originalWarn(...args); };
  try {
    const sorted = await standalone.sortByAsync(input, 'id');
    assert.equal(sorted[0].id, 0);
    assert.equal(warned, false, `${label}: standalone sort used a fallback`);
  } finally {
    console.warn = originalWarn;
  }
}

(async () => {
  await verify('CommonJS', require('@doeixd/csv-utils'), require('@doeixd/csv-utils/headers'), require('@doeixd/csv-utils/standalone'));
  await verify('ES modules', await import('@doeixd/csv-utils'), await import('@doeixd/csv-utils/headers'), await import('@doeixd/csv-utils/standalone'));
  console.log('Package entry points passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
