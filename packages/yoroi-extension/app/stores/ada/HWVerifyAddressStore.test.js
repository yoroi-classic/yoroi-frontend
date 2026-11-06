import HWVerifyAddressStore from './HWVerifyAddressStore';
import { withTrezorConnect } from '../lib/TrezorWrapper';

jest.mock('../lib/TrezorWrapper', () => ({
  withTrezorConnect: jest.fn(),
}));
jest.mock('../../utils/logging', () => ({
  Logger: { info: jest.fn(), error: jest.fn() },
  stringifyError: String,
}));
jest.mock('../../api/ada/lib/cardanoCrypto/cmlAddress', () => ({
  normalizeAddressToHex: jest.fn(() => 'ab'.repeat(29)),
}));
jest.mock('../../api/ada/lib/storage/database/prepackaged/networks', () => ({
  getCardanoHaskellBaseConfig: jest.fn(() => [{ ByronNetworkId: '764824073', ChainNetworkId: '1' }]),
  getNetworkById: jest.fn(),
}));
jest.mock('../../api/ada/transactions/shelley/trezorTx', () => ({
  toTrezorAddressParameters: jest.fn(() => ({})),
}));
jest.mock('../stateless/addressStores', () => ({
  genAddressingLookup: jest.fn(),
}));
jest.mock('../../domain/TrezorLocalizedError', () => ({
  convertToLocalizableError: error => ({ message: String(error) }),
}));

describe('HWVerifyAddressStore', () => {
  it('shows the address on the device and reports a failed response', async () => {
    const store = new HWVerifyAddressStore({}, {});
    const cardanoGetAddress = jest.fn(async () => ({
      success: false,
      payload: { error: 'Cancelled' },
    }));
    withTrezorConnect.mockImplementation(async callback => callback({ cardanoGetAddress }));

    await store.trezorVerifyAddress([], 'addr1fixture', {});

    expect(cardanoGetAddress).toHaveBeenCalledWith(expect.objectContaining({ address: 'addr1fixture', showOnTrezor: true }));
    expect(store.error).toEqual({
      message: expect.stringContaining('Cancelled'),
    });
  });
});
