import TrezorConnectStore from './TrezorConnectStore';
import { wrapWithFrame } from '../lib/TrezorWrapper';

jest.mock('../../components/widgets/ProgressSteps', () => ({ StepState: { PROCESS: 'PROCESS', ERROR: 'ERROR', LOAD: 'LOAD' } }));
jest.mock('../../utils/logging', () => ({
  Logger: { debug: jest.fn(), info: jest.fn(), error: jest.fn() },
  stringifyError: String,
}));
jest.mock('../../api/thunk', () => ({ createHardwareWallet: jest.fn() }));
jest.mock('../../../posthog', () => ({ captureEvent: jest.fn() }));

jest.mock('../lib/TrezorWrapper', () => ({
  wrapWithFrame: jest.fn(),
}));

describe('TrezorConnectStore', () => {
  let store;

  beforeEach(() => {
    jest.clearAllMocks();
    store = new TrezorConnectStore({}, {});
    store.setup();
  });

  it('stores device features returned by Trezor Connect', async () => {
    const publicKey = 'b'.repeat(64);
    const chainCode = 'a'.repeat(64);
    wrapWithFrame.mockImplementation(async callback =>
      callback({
        cardanoGetPublicKey: async () => ({
          success: true,
          payload: { publicKey, node: { public_key: publicKey, chain_code: chainCode } },
        }),
        getFeatures: async () => ({
          success: true,
          payload: { vendor: 'Vendor', model: 'Model', device_id: 'DeviceId', label: 'Wallet' },
        }),
      })
    );

    await store._checkAndStoreHWDeviceInfo();

    expect(store.hwDeviceInfo).toEqual({
      publicMasterKey: `${publicKey}${chainCode}`,
      hwFeatures: { Vendor: 'Vendor', Model: 'Model', DeviceId: 'DeviceId' },
      defaultName: 'Wallet',
    });
  });

  it('preserves an already serialized extended public key', () => {
    const publicMasterKey = 'c'.repeat(128);

    expect(
      store._normalizeHWResponse({
        trezorResp: {
          success: true,
          payload: { publicKey: publicMasterKey, node: { public_key: 'b'.repeat(64), chain_code: 'a'.repeat(64) } },
        },
        trezorFeatures: undefined,
      }).publicMasterKey
    ).toBe(publicMasterKey);
  });

  it('rejects malformed extended public keys before entering the save step', async () => {
    wrapWithFrame.mockImplementation(async callback =>
      callback({
        cardanoGetPublicKey: async () => ({
          success: true,
          payload: { publicKey: 'not-an-extended-key', node: { public_key: 'bad', chain_code: 'bad' } },
        }),
      })
    );

    await store._checkAndStoreHWDeviceInfo();

    expect(store.hwDeviceInfo).toBeUndefined();
    expect(store.progressInfo.currentStep).toBe(1);
    expect(store.progressInfo.stepState).toBe('ERROR');
  });

  it('does not request features when public-key export fails', async () => {
    const getFeatures = jest.fn();
    wrapWithFrame.mockImplementation(async callback =>
      callback({
        cardanoGetPublicKey: async () => ({ success: false, payload: { error: 'rejected' } }),
        getFeatures,
      })
    );

    await store._checkAndStoreHWDeviceInfo();

    expect(getFeatures).not.toHaveBeenCalled();
    expect(store.hwDeviceInfo).toBeUndefined();
  });
});
