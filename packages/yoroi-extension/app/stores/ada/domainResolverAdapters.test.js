// @flow

import { Api, Resolver } from '@yoroi/types';
import '../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';
import { isValidMainnetPaymentAddress } from './domainResolverUtils';

jest.mock('@yoroi/common', () => ({
  ...require('@yoroi/common/lib/commonjs/api/getApiError'),
  ...require('@yoroi/common/lib/commonjs/utils/monads'),
  fetchData: jest.fn(),
}));
jest.mock('@yoroi/api', () => ({ CardanoApi: {} }));

const { handleApiConfig, handleApiGetCryptoAddress } = require('@yoroi/resolver/lib/commonjs/adapters/handle/api');
const { unstoppableApiConfig, unstoppableApiGetCryptoAddress } = require('@yoroi/resolver/lib/commonjs/adapters/unstoppable/api');
const { handleCnsApiError } = require('@yoroi/resolver/lib/commonjs/adapters/cns/api');
const { makeCnsCardanoApi } = require('@yoroi/resolver/lib/commonjs/adapters/cns/cardano-api-maker');
const { stringToHex } = require('@yoroi/resolver/lib/commonjs/adapters/cns/utils');

const MAINNET_ADDRESS = 'addr1z8dyldfnnpg4w85d32lv64f5ldra02juhnzxdvlyyrpfs0leh7ahm4pdpqxx0mc0wvmu6n025jml40g7pfd0j0vf6aqsl2tlcx';
const PREPROD_ADDRESS = 'addr_test1wzzfgjazt5ts34cstrhzaac4xav8x7z2m3vg76s8qmaztzglsw8k5';

const success = (data: any) => ({ tag: 'right', value: { data, status: 200 } });
const failure = (status: number) => ({
  tag: 'left',
  error: { status, message: `HTTP ${status}`, responseData: null },
});

const adapterCases = [
  {
    name: 'ADA Handle',
    resolve: '$alice',
    payload: address => ({ resolved_addresses: { ada: address } }),
    malformedPayload: { resolved_addresses: {} },
    makeResolver: request => handleApiGetCryptoAddress({ request, isMainnet: true }),
    assertRequest: request => {
      expect(request).toHaveBeenCalledWith({ url: `${handleApiConfig.mainnet.getCryptoAddress}alice` }, undefined);
    },
  },
  {
    name: 'Unstoppable Domains',
    resolve: 'alice.crypto',
    payload: address => ({
      meta: { blockchain: 'MATIC', domain: 'alice.crypto' },
      records: { 'crypto.ADA.address': address },
    }),
    malformedPayload: { meta: { blockchain: 'MATIC' }, records: { 'crypto.ADA.address': 42 } },
    makeResolver: request => unstoppableApiGetCryptoAddress({ apiKey: 'test-api-key' }, { request }),
    assertRequest: request => {
      expect(request).toHaveBeenCalledWith(
        {
          url: `${unstoppableApiConfig.mainnet.getCryptoAddress}alice.crypto`,
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer test-api-key',
          },
        },
        undefined
      );
    },
  },
  {
    name: 'Cardano Name Service',
    resolve: 'alice.ada',
    payload: address => [address],
    malformedPayload: { address: MAINNET_ADDRESS },
    makeResolver: request => {
      const api = makeCnsCardanoApi('https://resolver.invalid', request);
      return async receiver => {
        try {
          return await api.getAssetAddress('policy-id', stringToHex(receiver));
        } catch (error) {
          return handleCnsApiError(error);
        }
      };
    },
    assertRequest: request => {
      expect(request).toHaveBeenCalledWith(
        {
          url: `https://resolver.invalid/api/asset/accounts?policy=policy-id&asset=${stringToHex('alice.ada')}`,
        },
        undefined
      );
    },
  },
];

beforeAll(async () => {
  await RustModule.load();
});

describe.each(adapterCases.map(adapter => [adapter.name, adapter]))('%s production response adapter', (_name, adapter) => {
  test('parses a successful Cardano address result at a mocked HTTP boundary', async () => {
    const request = jest.fn().mockResolvedValue(success(adapter.payload(MAINNET_ADDRESS)));

    await expect(adapter.makeResolver(request)(adapter.resolve)).resolves.toBe(MAINNET_ADDRESS);
    expect(request).toHaveBeenCalledTimes(1);
    adapter.assertRequest(request);
  });

  test('maps a provider not-found response without returning an address', async () => {
    const request = jest.fn().mockResolvedValue(failure(404));

    await expect(adapter.makeResolver(request)(adapter.resolve)).rejects.toThrow(Resolver.Errors.NotFound);
  });

  test('rejects a malformed provider payload', async () => {
    const request = jest.fn().mockResolvedValue(success(adapter.malformedPayload));

    await expect(adapter.makeResolver(request)(adapter.resolve)).rejects.toThrow();
  });

  test('propagates an upstream failure without returning an address', async () => {
    const request = jest.fn().mockResolvedValue(failure(503));

    await expect(adapter.makeResolver(request)(adapter.resolve)).rejects.toThrow(Api.Errors.ServerSide);
  });

  test('fails closed when a mainnet provider returns a preprod address', async () => {
    const request = jest.fn().mockResolvedValue(success(adapter.payload(PREPROD_ADDRESS)));
    const resolvedAddress = await adapter.makeResolver(request)(adapter.resolve);

    expect(isValidMainnetPaymentAddress(resolvedAddress)).toBe(false);
  });
});

test('mainnet address validation rejects malformed and reward addresses', () => {
  const rewardAddress = 'stake1u9ylzsgz7ueq3xqu0jj8r39jex5mfrt8k2cl98y4g8n6tzqf3tk9k';

  expect(isValidMainnetPaymentAddress(MAINNET_ADDRESS)).toBe(true);
  expect(isValidMainnetPaymentAddress(rewardAddress)).toBe(false);
  expect(isValidMainnetPaymentAddress('not-an-address')).toBe(false);
});
