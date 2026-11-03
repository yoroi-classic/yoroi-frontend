import { withTrezorConnect } from './TrezorWrapper';

describe('withTrezorConnect', () => {
  const originalChrome = global.chrome;

  afterEach(() => {
    if (originalChrome === undefined) {
      delete global.chrome;
    } else {
      global.chrome = originalChrome;
    }
  });

  it('routes Trezor API calls to the background service worker', async () => {
    const response = { success: true, payload: { address: 'addr1test' } };
    const sendMessage = jest.fn((_message, callback) => callback(response));
    const params = { addressParameters: { addressType: 0 } };
    global.chrome = { runtime: { sendMessage } };

    await expect(withTrezorConnect(trezor => trezor.cardanoGetAddress(params))).resolves.toBe(response);

    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'yoroi-trezor-connect', method: 'cardanoGetAddress', params },
      expect.any(Function)
    );
  });

  it('routes feature requests to the background service worker', async () => {
    const response = { success: true, payload: { capabilities: [] } };
    const sendMessage = jest.fn((_message, callback) => callback(response));
    global.chrome = { runtime: { sendMessage } };

    await expect(withTrezorConnect(trezor => trezor.getFeatures())).resolves.toBe(response);

    expect(sendMessage).toHaveBeenCalledWith(
      { type: 'yoroi-trezor-connect', method: 'getFeatures', params: {} },
      expect.any(Function)
    );
  });

  it('rejects when the extension service worker cannot answer', async () => {
    const sendMessage = jest.fn((_message, callback) => {
      global.chrome.runtime.lastError = { message: 'Could not establish connection' };
      callback();
    });
    global.chrome = { runtime: { sendMessage } };

    await expect(withTrezorConnect(trezor => trezor.cardanoGetAddress({ addressParameters: {} }))).rejects.toThrow(
      'Could not establish connection'
    );
  });
});
