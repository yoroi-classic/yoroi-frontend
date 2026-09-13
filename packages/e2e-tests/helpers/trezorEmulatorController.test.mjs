import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrezorEmulatorController } from './trezorEmulatorController.js';

const logger = Object.freeze({
  info() {},
  warn() {},
  error() {},
});

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    this.closeCount = 0;
    FakeWebSocket.instances.push(this);
  }

  open(message) {
    this.readyState = FakeWebSocket.OPEN;
    if (message) this.message(message);
    this.onopen?.();
  }

  send(payload) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error('socket is not open');
    this.sent.push(JSON.parse(payload));
  }

  message(payload) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closeCount += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.();
  }
}

const makeController = (responseTimeout = 25) =>
  new TrezorEmulatorController(logger, { WebSocketImpl: FakeWebSocket, responseTimeout });

const connect = async (controller, firstMessage) => {
  const connecting = controller.connect();
  const socket = FakeWebSocket.instances.at(-1);
  socket.open(firstMessage);
  await connecting;
  return socket;
};

test.beforeEach(() => {
  FakeWebSocket.instances = [];
});

test('queues the initial event and correlates a successful response by id', async () => {
  const controller = makeController();
  const socket = await connect(controller, { type: 'client' });

  await assert.doesNotReject(async () => {
    assert.deepEqual(await controller.getLastEvent(), { type: 'client' });
  });

  const response = controller.ping();
  assert.deepEqual(socket.sent, [{ type: 'ping', id: 0 }]);
  socket.message({ id: 0, success: true });
  assert.deepEqual(await response, { id: 0, success: true });
  controller.closeWsConnection();
});

test('ignores background and wrong-id messages until the matching response arrives', async () => {
  const controller = makeController();
  const socket = await connect(controller);
  const response = controller.ping();
  let settled = false;
  response.finally(() => {
    settled = true;
  });

  socket.message({ background_check: true });
  socket.message({ id: 99, success: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(settled, false);

  socket.message({ id: 0, success: true });
  await response;
  controller.closeWsConnection();
});

test('rejects a command when its bounded response timeout expires', async () => {
  const controller = makeController(10);
  await connect(controller);

  await assert.rejects(controller.ping(), /ping: no response after 10ms/);
  controller.closeWsConnection();
});

test('bounds a connection that never opens and closes its socket', async () => {
  const controller = makeController(10);
  const connecting = controller.connect();
  const socket = FakeWebSocket.instances.at(-1);

  await assert.rejects(connecting, /connect: no connection after 10ms/);
  assert.equal(socket.closeCount, 1);
});

test('rejects commands immediately when the socket is absent or closed', async () => {
  const controller = makeController();
  await assert.rejects(controller.ping(), /Trezor WebSocket is not open/);

  await connect(controller);
  controller.closeWsConnection();
  await assert.rejects(controller.ping(), /Trezor WebSocket is not open/);
});

test('close is idempotent and rejects pending work after partial initialization', async () => {
  const controller = makeController();
  const socket = await connect(controller);
  const response = controller.ping();

  controller.closeWsConnection();
  controller.closeWsConnection();

  await assert.rejects(response, /Trezor WebSocket closed/);
  assert.equal(socket.closeCount, 1);
});

test('unexpected close does not leak queued events into a reconnected socket', async () => {
  const controller = makeController();
  const firstSocket = await connect(controller, { type: 'stale-client' });

  firstSocket.close();
  const secondSocket = await connect(controller, { type: 'current-client' });

  assert.deepEqual(await controller.getLastEvent(), { type: 'current-client' });
  secondSocket.close();
});

test('connecting again replaces an open socket and rejects its pending work', async () => {
  const controller = makeController();
  const firstSocket = await connect(controller);
  const firstResponse = controller.ping();
  const firstRejected = assert.rejects(firstResponse, /Trezor WebSocket closed/);

  const reconnecting = controller.connect();
  const secondSocket = FakeWebSocket.instances.at(-1);
  secondSocket.open({ type: 'current-client' });
  await reconnecting;

  await firstRejected;
  assert.equal(firstSocket.closeCount, 1);
  assert.deepEqual(await controller.getLastEvent(), { type: 'current-client' });
  controller.closeWsConnection();
});

test('connecting again promptly retires an attempt that is still connecting', async () => {
  const controller = makeController();
  const firstConnecting = controller.connect();
  const firstRejected = assert.rejects(firstConnecting, /superseded by a newer connection/);
  const firstSocket = FakeWebSocket.instances.at(-1);

  const secondConnecting = controller.connect();
  const secondSocket = FakeWebSocket.instances.at(-1);
  secondSocket.open();

  await firstRejected;
  await secondConnecting;
  assert.equal(firstSocket.closeCount, 1);
  controller.closeWsConnection();
});

test('pre-open error fails closed and ignores a late open or message', async () => {
  const controller = makeController();
  const connecting = controller.connect();
  const rejected = assert.rejects(connecting, /pre-open failure/);
  const failedSocket = FakeWebSocket.instances.at(-1);

  failedSocket.onerror?.(new Error('pre-open failure'));
  await rejected;
  assert.equal(failedSocket.closeCount, 1);

  failedSocket.message({ type: 'late-stale-event' });
  failedSocket.onopen?.();
  const currentSocket = await connect(controller, { type: 'current-client' });

  assert.deepEqual(await controller.getLastEvent(), { type: 'current-client' });
  currentSocket.close();
});

test('late activity from a replaced socket cannot affect the current session', async () => {
  const controller = makeController();
  const firstSocket = await connect(controller, { type: 'stale-client' });

  const reconnecting = controller.connect();
  const secondSocket = FakeWebSocket.instances.at(-1);
  secondSocket.open({ type: 'current-client' });
  await reconnecting;

  const response = controller.ping();
  const requestId = secondSocket.sent.at(-1).id;
  firstSocket.message({ type: 'late-stale-event' });
  firstSocket.onerror?.(new Error('late stale error'));
  firstSocket.onclose?.();
  secondSocket.message({ id: requestId, success: true });

  assert.deepEqual(await response, { id: requestId, success: true });
  assert.deepEqual(await controller.getLastEvent(), { type: 'current-client' });
  controller.closeWsConnection();
});

test('bounds exit when the controller service does not close the socket', async () => {
  const controller = makeController(10);
  const socket = await connect(controller);

  await assert.rejects(controller.exit(), /exit: socket did not close after 10ms/);
  assert.deepEqual(socket.sent, [{ type: 'exit', id: 0 }]);
  controller.closeWsConnection();
});
