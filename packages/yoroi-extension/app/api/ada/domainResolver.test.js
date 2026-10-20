// @flow
import { RustModule } from './lib/cardanoCrypto/rustLoader';
import { isResolvableDomain, resolverApiMaker } from './domainResolver';
import { Resolver } from '@yoroi/types';

jest.mock('@yoroi/api', () => ({ CardanoApi: { getOnChainMetadatas: jest.fn() } }));
jest.mock('@yoroi/common', () => ({
  fetchData: jest.fn(),
  getApiError: error => error,
  isLeft: result => result.tag === 'left',
}));

beforeAll(async () => {
  await RustModule.load();
});

const right = (data: any): any => ({ tag: 'right', value: { data } });

test('resolves Ada Handles and Unstoppable ADA records through their configured APIs', async () => {
  const request = jest.fn(async ({ url }) => {
    if (url.startsWith('https://api.handle.me/')) return right({ resolved_addresses: { ada: 'addr_handle' } });
    if (url.startsWith('https://api.unstoppabledomains.com/')) return right({ records: { 'crypto.ADA.address': 'addr_unstoppable' } });
    return { tag: 'left', error: new Error('not found') };
  });
  const api = resolverApiMaker({ apiConfig: { [Resolver.NameServer.Unstoppable]: { apiKey: 'key' } } }, { request });

  const handle = await api.getCardanoAddresses({ resolve: '$alice' });
  const unstoppable = await api.getCardanoAddresses({ resolve: 'alice.crypto' });

  expect(handle.find(result => result.nameServer === Resolver.NameServer.Handle)?.address).toBe('addr_handle');
  expect(unstoppable.find(result => result.nameServer === Resolver.NameServer.Unstoppable)?.address).toBe('addr_unstoppable');
  expect(request).toHaveBeenCalledWith(
    { url: 'https://api.unstoppabledomains.com/resolve/domains/alice.crypto', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer key' } },
    undefined
  );
});

test('resolves a CNS domain from its NFT address response', async () => {
  const request = jest.fn(async () => right(['addr_cns']));
  const api = resolverApiMaker({ apiConfig: {} }, {
    request,
    getMetadatas: async (_baseUrl, [id]) => ({ [id]: { mintNftRecordSelected: { expiry: Date.now() + 60_000 } } }),
  });

  const results = await api.getCardanoAddresses({ resolve: 'alice.ada' });

  expect(results.find(result => result.nameServer === Resolver.NameServer.Cns)?.address).toBe('addr_cns');
  expect(request).toHaveBeenCalledWith(
    { url: expect.stringContaining('/api/asset/accounts?policy=') },
    undefined
  );
});

test('resolves CNS virtual subdomains from Plutus address credentials using CML', async () => {
  const paymentHash = '11'.repeat(28);
  const stakeHash = '22'.repeat(28);
  const request = jest.fn(async () => right([
    {
      inline_datum: {
        plutus_data: {
          constructor: 0,
          fields: [
            { map: [{ k: { bytes: Buffer.from('www').toString('hex') }, v: {
              constructor: 0,
              fields: [
                { constructor: 0, fields: [{ bytes: paymentHash }] },
                { constructor: 0, fields: [{ constructor: 0, fields: [{ constructor: 0, fields: [{ bytes: stakeHash }] }] }] },
              ],
            } }] },
            { map: [] },
            { map: [] },
          ],
        },
      },
    },
  ]));
  const api = resolverApiMaker({ apiConfig: {} }, {
    request,
    getMetadatas: async (_baseUrl, [id]) => ({ [id]: { mintNftRecordSelected: { expiry: Date.now() + 60_000, virtualSubdomainEnabled: 'Enabled' } } }),
  });

  const results = await api.getCardanoAddresses({ resolve: 'www.alice.ada' });
  const expected = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const payment = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(paymentHash));
    const stake = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(stakeHash));
    return cml.BaseAddress.new(1, payment, stake).to_address().to_bech32();
  });

  expect(results.find(result => result.nameServer === Resolver.NameServer.Cns)?.address).toBe(expected);
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'post' }), undefined);
});

test('recognizes only supported domain families', () => {
  expect(isResolvableDomain('$alice')).toBe(true);
  expect(isResolvableDomain('alice.crypto')).toBe(true);
  expect(isResolvableDomain('alice.ada')).toBe(true);
  expect(isResolvableDomain('alice.example')).toBe(false);
});
