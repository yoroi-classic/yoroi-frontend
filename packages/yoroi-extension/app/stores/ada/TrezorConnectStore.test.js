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
    wrapWithFrame.mockImplementation(async callback =>
      callback({
        cardanoGetPublicKey: async () => ({ success: true, payload: { publicKey: 'pubkey' } }),
        getFeatures: async () => ({
          success: true,
          payload: { vendor: 'Vendor', model: 'Model', device_id: 'DeviceId', label: 'Wallet' },
        }),
      })
    );

    await store._checkAndStoreHWDeviceInfo();

    expect(store.hwDeviceInfo).toEqual({
      publicMasterKey: 'pubkey',
      hwFeatures: { Vendor: 'Vendor', Model: 'Model', DeviceId: 'DeviceId' },
      defaultName: 'Wallet',
    });
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
