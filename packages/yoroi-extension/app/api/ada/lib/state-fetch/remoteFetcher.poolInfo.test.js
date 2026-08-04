// @flow
import '../test-config.forTests';

import { bech32 } from 'bech32';
import { GetPoolInfoApiError } from '../../../common/errors';
import { Logger } from '../../../../utils/logging';
import { RemoteFetcher } from './remoteFetcher';

const POOL_ID_HEX = '11'.repeat(28);
const POOL_ID = bech32.encode('pool', bech32.toWords(Buffer.from(POOL_ID_HEX, 'hex')), 1000);

const network = ({
  NetworkFeatureName: 'mainnet',
  Backend: {
    BackendService: 'http://legacy.invalid',
  },
}: any);

const successfulJsonResponse = body =>
  Promise.resolve({
    ok: true,
    headers: {
      get: () => null,
    },
    json: () => Promise.resolve(body),
  });

describe('cardano-wallet-backend pool info', () => {
  const originalCardanoWalletBackend = { ...(global: any).CONFIG.cardanoWalletBackend };

  beforeEach(() => {
    (global: any).CONFIG.cardanoWalletBackend = {
      enabled: true,
      mainnet: 'http://localhost:3010/',
      preprod: 'http://localhost:3011/',
    };
    (AbortSignal: any).timeout = jest.fn(() => new AbortController().signal);
    jest.spyOn(Logger, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    (global: any).CONFIG.cardanoWalletBackend = originalCardanoWalletBackend;
    jest.restoreAllMocks();
  });

  test('maps metadata and live display values by the wallet pool key hash', async () => {
    (global: any).fetch = jest.fn(() =>
      successfulJsonResponse([
        {
          poolId: POOL_ID,
          poolIdHex: POOL_ID_HEX,
          status: 'registered',
          margin: 0.03,
          fixedCost: '340000000',
          pledge: '1000000000',
          livePledge: '1000000000',
          activeStake: '12000000000',
          liveStake: '12345678901234567890',
          saturation: 0.42,
          liveDelegators: 123,
          blocksMinted: 456,
          metadata: {
            name: 'Example Pool',
            ticker: 'EXMPL',
            homepage: 'https://example.invalid',
            description: 'Example metadata',
          },
        },
      ])
    );
    const fetcher = new RemoteFetcher(
      () => '5.23.200',
      () => 'en-US',
      () => 'chrome'
    );

    await expect(fetcher.getPoolInfo({ network, poolIds: [POOL_ID_HEX] })).resolves.toEqual({
      [POOL_ID_HEX]: {
        info: {
          name: 'Example Pool',
          ticker: 'EXMPL',
          homepage: 'https://example.invalid',
          description: 'Example metadata',
        },
        history: [],
        display: {
          stake: '12345678901234567890',
          saturation: '0.42',
        },
      },
    });
    expect((global: any).fetch).toHaveBeenCalledWith(
      'http://localhost:3010/v1/pools/info',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ poolIds: [POOL_ID] }),
      })
    );
  });

  test('does not send an empty pool lookup rejected by the backend contract', async () => {
    (global: any).fetch = jest.fn();
    const fetcher = new RemoteFetcher(
      () => '5.23.200',
      () => 'en-US',
      () => 'chrome'
    );

    await expect(fetcher.getPoolInfo({ network, poolIds: [] })).resolves.toEqual({});
    expect((global: any).fetch).not.toHaveBeenCalled();
  });

  test('fails closed when the backend returns a different pool key hash', async () => {
    (global: any).fetch = jest.fn(() =>
      successfulJsonResponse([
        {
          poolId: POOL_ID,
          poolIdHex: '22'.repeat(28),
          liveStake: '1',
          saturation: 0.1,
        },
      ])
    );
    const fetcher = new RemoteFetcher(
      () => '5.23.200',
      () => 'en-US',
      () => 'chrome'
    );

    await expect(fetcher.getPoolInfo({ network, poolIds: [POOL_ID_HEX] })).rejects.toBeInstanceOf(GetPoolInfoApiError);
  });

  test('does not fall back to the legacy pool endpoint when the owned backend is disabled', async () => {
    (global: any).CONFIG.cardanoWalletBackend.enabled = false;
    (global: any).fetch = jest.fn();
    const fetcher = new RemoteFetcher(
      () => '5.23.200',
      () => 'en-US',
      () => 'chrome'
    );

    await expect(fetcher.getPoolInfo({ network, poolIds: [POOL_ID_HEX] })).rejects.toBeInstanceOf(GetPoolInfoApiError);
    expect((global: any).fetch).not.toHaveBeenCalled();
  });
});
