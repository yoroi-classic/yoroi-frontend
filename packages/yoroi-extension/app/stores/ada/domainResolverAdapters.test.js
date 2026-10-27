// @flow
import '../../api/ada/lib/test-config.forTests';
import { Api, Resolver } from '@yoroi/types';
import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';
import {
  cnsCryptoAddress,
  handleApiGetCryptoAddress,
  handleCnsApiError,
  unstoppableApiGetCryptoAddress,
} from '../../api/ada/domainResolver';
import { isValidMainnetPaymentAddress } from './domainResolverUtils';

jest.mock('@yoroi/common', () => ({
  ...require('@yoroi/common/lib/commonjs/api/getApiError'),
  ...require('@yoroi/common/lib/commonjs/utils/monads'),
  fetchData: jest.fn(),
}));
jest.mock('@yoroi/api', () => ({ CardanoApi: {} }));

const MAINNET_ADDRESS = 'addr1z8dyldfnnpg4w85d32lv64f5ldra02juhnzxdvlyyrpfs0leh7ahm4pdpqxx0mc0wvmu6n025jml40g7pfd0j0vf6aqsl2tlcx';
const PREPROD_ADDRESS = 'addr_test1wzzfgjazt5ts34cstrhzaac4xav8x7z2m3vg76s8qmaztzglsw8k5';
const REWARD_ADDRESS = 'stake1az0vrvznk3xya3c7l0fqp6qwkth5emmc37vyaevydah3r0cv6gnpm';
const success = (data: any) => ({ tag: 'right', value: { data, status: 200 } });
const failure = (status: number) => ({ tag: 'left', error: { status, message: `HTTP ${status}`, responseData: null } });

beforeAll(async () => {
  await RustModule.load();
});

test('parses Handle provider response at the mocked HTTP boundary', async () => {
  const request = jest.fn().mockResolvedValue(success({ resolved_addresses: { ada: MAINNET_ADDRESS } }));
  await expect(handleApiGetCryptoAddress({ request, isMainnet: true })('$alice')).resolves.toBe(MAINNET_ADDRESS);
  expect(request).toHaveBeenCalledWith({ url: 'https://api.handle.me/handles/alice' }, undefined);
});

test('returns reward addresses from Handle and Unstoppable without treating them as payment addresses', async () => {
  const handleRequest = jest.fn().mockResolvedValue(success({ resolved_addresses: { ada: REWARD_ADDRESS } }));
  const unstoppableRequest = jest.fn().mockResolvedValue(success({ records: { 'crypto.ADA.address': REWARD_ADDRESS } }));
  await expect(handleApiGetCryptoAddress({ request: handleRequest })('$stake')).resolves.toBe(REWARD_ADDRESS);
  await expect(
    unstoppableApiGetCryptoAddress({ apiKey: 'test-api-key' }, { request: unstoppableRequest })('stake.crypto')
  ).resolves.toBe(REWARD_ADDRESS);
  const cnsRequest = jest.fn().mockResolvedValue(success([REWARD_ADDRESS]));
  const cnsMetadata = async (_url, [id]) => ({
    [id]: { mintNftRecordSelected: { expiry: Date.now() + 60_000 } },
  });
  await expect(cnsCryptoAddress(cnsRequest, cnsMetadata)('stake.ada')).resolves.toBe(REWARD_ADDRESS);
});

test('parses Unstoppable response and sends its API token', async () => {
  const request = jest.fn().mockResolvedValue(success({ records: { 'crypto.ADA.address': MAINNET_ADDRESS } }));
  await expect(unstoppableApiGetCryptoAddress({ apiKey: 'test-api-key' }, { request })('alice.crypto')).resolves.toBe(
    MAINNET_ADDRESS
  );
  expect(request).toHaveBeenCalledWith(
    {
      url: 'https://api.unstoppabledomains.com/resolve/domains/alice.crypto',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-api-key' },
    },
    undefined
  );
});

test('resolves a CNS virtual address with CML credentials', async () => {
  const paymentHash = '11'.repeat(28);
  const stakeHash = '22'.repeat(28);
  const record = {
    constructor: 0,
    fields: [
      {
        map: [
          {
            k: { bytes: Buffer.from('www').toString('hex') },
            v: {
              constructor: 0,
              fields: [
                { constructor: 0, fields: [{ bytes: paymentHash }] },
                { constructor: 0, fields: [{ constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: stakeHash }] }] }] },
              ],
            },
          },
        ],
      },
      { map: [] },
      { map: [] },
    ],
  };
  const request = jest.fn().mockResolvedValue(success([{ inline_datum: { plutus_data: record } }]));
  const metadataFetcher = jest.fn(async (_baseUrl, [id]) => ({
    [id]: { mintNftRecordSelected: { expiry: Date.now() + 60_000, virtualSubdomainEnabled: 'Enabled' } },
  }));
  const address = await cnsCryptoAddress(request, metadataFetcher)('www.alice.ada');
  const expected = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    return cml.BaseAddress.new(
      1,
      cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(paymentHash)),
      cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(stakeHash))
    )
      .to_address()
      .to_bech32();
  });

  expect(address).toBe(expected);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'post' }), undefined);
  expect(metadataFetcher).toHaveBeenCalledTimes(1);
});

test('maps not-found errors and validates returned network addresses', async () => {
  const request = jest.fn().mockResolvedValue(failure(404));
  await expect(handleApiGetCryptoAddress({ request })('$alice')).rejects.toThrow(Resolver.Errors.NotFound);
  expect(handleCnsApiError(new Api.Errors.NotFound())).toBeInstanceOf(Resolver.Errors.NotFound);
  expect(isValidMainnetPaymentAddress(MAINNET_ADDRESS)).toBe(true);
  expect(isValidMainnetPaymentAddress(REWARD_ADDRESS)).toBe(false);
  expect(isValidMainnetPaymentAddress(PREPROD_ADDRESS)).toBe(false);
  expect(isValidMainnetPaymentAddress('not-an-address')).toBe(false);
});

test('rejects malformed and server-error responses from domain providers', async () => {
  const malformedHandle = jest.fn().mockResolvedValue(success({ resolved_addresses: {} }));
  await expect(handleApiGetCryptoAddress({ request: malformedHandle })('$alice')).rejects.toThrow(
    Resolver.Errors.InvalidResponse
  );

  const malformedUnstoppable = jest.fn().mockResolvedValue(success({ records: {} }));
  await expect(
    unstoppableApiGetCryptoAddress({ apiKey: 'test-api-key' }, { request: malformedUnstoppable })('alice.crypto')
  ).rejects.toThrow(Resolver.Errors.InvalidResponse);

  const malformedCns = jest.fn().mockResolvedValue(success([]));
  const cnsMetadata = async (_url, [id]) => ({
    [id]: { mintNftRecordSelected: { expiry: Date.now() + 60_000 } },
  });
  await expect(cnsCryptoAddress(malformedCns, cnsMetadata)('alice.ada')).rejects.toThrow(Resolver.Errors.NotFound);

  const serverFailure = jest.fn().mockResolvedValue(failure(500));
  await expect(handleApiGetCryptoAddress({ request: serverFailure })('$alice')).rejects.toThrow();
  await expect(
    unstoppableApiGetCryptoAddress({ apiKey: 'test-api-key' }, { request: serverFailure })('alice.crypto')
  ).rejects.toThrow();
  await expect(
    cnsCryptoAddress(serverFailure, async (_url, [id]) => ({ [id]: { mintNftRecordSelected: { expiry: Date.now() + 60_000 } } }))(
      'alice.ada'
    )
  ).rejects.toThrow();

  const networkFailure = jest.fn().mockRejectedValue(new TypeError('network unavailable'));
  await expect(handleApiGetCryptoAddress({ request: networkFailure })('$alice')).rejects.toThrow('network unavailable');
  await expect(
    unstoppableApiGetCryptoAddress({ apiKey: 'test-api-key' }, { request: networkFailure })('alice.crypto')
  ).rejects.toThrow('network unavailable');
  await expect(
    cnsCryptoAddress(networkFailure, async (_url, [id]) => ({
      [id]: { mintNftRecordSelected: { expiry: Date.now() + 60_000 } },
    }))('alice.ada')
  ).rejects.toThrow('network unavailable');
});
