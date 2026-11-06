// @flow

import TrezorConnect from 'trezor-connect-flow';
import { handleTrezorConnectMessage } from './trezorConnect';
import { TREZOR_CONNECT_REQUEST_TYPE } from '../../../app/stores/lib/TrezorWrapper';

describe('handleTrezorConnectMessage', () => {
  const extensionId = 'test-extension-id';
  const sender = {
    id: extensionId,
    url: `chrome-extension://${extensionId}/main_window.html`,
  };

  beforeEach(() => {
    global.chrome = {
      runtime: {
        id: extensionId,
        getURL: () => `chrome-extension://${extensionId}/`,
      },
    };
  });

  afterEach(() => {
    delete global.chrome;
    jest.restoreAllMocks();
  });

  it('initializes Trezor Connect in the service worker and dispatches an allowed method', async () => {
    const response = { success: true, payload: { address: 'addr1test' } };
    const init = jest.spyOn(TrezorConnect, 'init').mockResolvedValue(undefined);
    const getAddress = jest.spyOn(TrezorConnect, 'cardanoGetAddress').mockResolvedValue(response);
    const dispose = jest.spyOn(TrezorConnect, 'dispose').mockResolvedValue(undefined);
    const params = { addressParameters: { addressType: 0 } };

    await expect(
      handleTrezorConnectMessage({ type: TREZOR_CONNECT_REQUEST_TYPE, method: 'cardanoGetAddress', params }, sender)
    ).resolves.toBe(response);

    expect(init).toHaveBeenCalledWith({
      manifest: expect.objectContaining({ appName: expect.any(String) }),
      coreMode: 'suite-web',
    });
    expect(getAddress).toHaveBeenCalledWith(params);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('dispatches feature requests through the service worker', async () => {
    const response = { success: true, payload: { capabilities: [] } };
    const init = jest.spyOn(TrezorConnect, 'init').mockResolvedValue(undefined);
    const getFeatures = jest.spyOn(TrezorConnect, 'getFeatures').mockResolvedValue(response);
    jest.spyOn(TrezorConnect, 'dispose').mockResolvedValue(undefined);

    await expect(
      handleTrezorConnectMessage({ type: TREZOR_CONNECT_REQUEST_TYPE, method: 'getFeatures', params: {} }, sender)
    ).resolves.toBe(response);

    expect(init).toHaveBeenCalledTimes(1);
    expect(getFeatures).toHaveBeenCalledTimes(1);
  });

  it('rejects requests from outside the extension', async () => {
    const init = jest.spyOn(TrezorConnect, 'init');

    await expect(
      handleTrezorConnectMessage(
        { type: TREZOR_CONNECT_REQUEST_TYPE, method: 'cardanoGetAddress', params: {} },
        { ...sender, url: 'https://example.com/' }
      )
    ).resolves.toMatchObject({ success: false });

    expect(init).not.toHaveBeenCalled();
  });

  it('rejects unsupported methods before initializing Trezor Connect', async () => {
    const init = jest.spyOn(TrezorConnect, 'init');

    await expect(
      handleTrezorConnectMessage({ type: TREZOR_CONNECT_REQUEST_TYPE, method: 'dispose', params: {} }, sender)
    ).resolves.toMatchObject({ success: false });

    expect(init).not.toHaveBeenCalled();
  });
});
