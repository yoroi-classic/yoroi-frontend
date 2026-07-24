import assert from 'node:assert/strict';
import test from 'node:test';

import { closeMockServer, getMockServer } from './mockServer.js';

test('waits for shutdown before reusing the mock server port', async t => {
  const firstServer = await getMockServer({ port: 0 });
  const { port } = firstServer.address();

  await closeMockServer(firstServer);
  assert.equal(firstServer.listening, false);

  const secondServer = await getMockServer({ port });
  t.after(() => closeMockServer(secondServer));

  assert.equal(secondServer.address().port, port);
  const response = await fetch(`http://localhost:${port}/mock-dapp`);
  assert.equal(response.status, 200);
});

test('rejects immediately when the requested port is still occupied', async t => {
  const activeServer = await getMockServer({ port: 0 });
  t.after(() => closeMockServer(activeServer));

  await assert.rejects(getMockServer({ port: activeServer.address().port }), { code: 'EADDRINUSE' });
});
