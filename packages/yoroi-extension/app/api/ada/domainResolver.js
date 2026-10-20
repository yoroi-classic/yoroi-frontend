// @flow

import { CardanoApi } from '@yoroi/api';
import { fetchData, getApiError, isLeft } from '@yoroi/common';
import { Api, Resolver } from '@yoroi/types';
import { RustModule } from './lib/cardanoCrypto/rustLoader';

const unstoppableTlds = [
  '.x', '.polygon', '.nft', '.crypto', '.blockchain', '.bitcoin', '.dao', '.888', '.wallet', '.binanceus', '.brave',
  '.hi', '.klever', '.kresus', '.anime', '.manga', '.go', '.altimist', '.pudgy', '.unstoppable', '.austin', '.bitget',
  '.pog', '.clay', '.zil', '.eth',
];

export const isResolvableDomain = (resolve: string): boolean =>
  (resolve.startsWith('$') && resolve.length > 1) ||
  unstoppableTlds.some(tld => resolve.endsWith(tld)) ||
  resolve.endsWith('.ada');

const cnsConfigs = {
  mainnet: {
    baseUrl: 'https://api.yoroiwallet.com',
    cnsPolicyId: 'e0c4c2d7c4a0ed2cf786753fd845dee82c45512cee03e92adfd3fb8d',
    recordPolicyId: 'a1db6026bc00963c1a70af10cdd98f2304be5da44ae4af8f770dcfd3',
    recordAddress: 'addr1z8dyldfnnpg4w85d32lv64f5ldra02juhnzxdvlyyrpfs0leh7ahm4pdpqxx0mc0wvmu6n025jml40g7pfd0j0vf6aqsl2tlcx',
    networkId: 1,
  },
  preprod: {
    baseUrl: 'https://preprod-backend.yoroiwallet.com',
    cnsPolicyId: 'baefdc6c5b191be372a794cd8d40d839ec0dbdd3c28957267dc81700',
    recordPolicyId: 'a048db3b45c2aa5f1ad472338e6e6dea41a45f4350c8753a231403aa',
    recordAddress: 'addr_test1wzzfgjazt5ts34cstrhzaac4xav8x7z2m3vg76s8qmaztzglsw8k5',
    networkId: 0,
  },
};

const unstoppableApiAddress = 'https://api.unstoppabledomains.com/resolve/domains/';
const handleApiAddress = { mainnet: 'https://api.handle.me/handles/', preprod: 'https://preprod.api.handle.me/handles/' };

const requestData = async (request: any, fetcherConfig: any, requestFn: any): Promise<any> => {
  const response = await requestFn(request, fetcherConfig);
  if (isLeft(response)) throw getApiError(response.error);
  return response.value.data;
};

const getCnsMetadata = async (
  config: any,
  policyId: string,
  assetName: string,
  fetcherConfig: any,
  metadataFetcher: any
): Promise<any> => {
  const id = `${policyId}.${assetName}`;
  const response = await metadataFetcher(`${config.baseUrl}/api`, [id], fetcherConfig);
  const metadata = response?.[id]?.mintNftRecordSelected;
  if (metadata == null || typeof metadata.expiry !== 'number') throw new Resolver.Errors.NotFound();
  if (metadata.expiry <= Date.now()) throw new Resolver.Errors.Expired();
  return metadata;
};

const getCnsAssetAddress = async (config: any, policyId: string, assetName: string, fetcherConfig: any, requestFn: any): Promise<string> => {
  const response = await requestData(
    { url: `${config.baseUrl}/api/asset/accounts?policy=${policyId}&asset=${assetName}` },
    fetcherConfig,
    requestFn
  );
  if (!Array.isArray(response) || typeof response[0] !== 'string') throw new Resolver.Errors.NotFound();
  return response[0];
};

const getVirtualSubdomains = async (config: any, assetName: string, fetcherConfig: any, requestFn: any): Promise<Array<[string, string]>> => {
  const response = await requestData(
    {
      url: `${config.baseUrl}/api/txs/utxoForAddresses`,
      method: 'post',
      data: { addresses: [config.recordAddress], asset: { policy: config.recordPolicyId, name: assetName } },
    },
    fetcherConfig,
    requestFn
  );
  const userRecord = response?.[0]?.inline_datum?.plutus_data;
  const entries = userRecord?.constructor === 0 && Array.isArray(userRecord.fields) ? userRecord.fields[0]?.map : null;
  if (!Array.isArray(entries)) throw new Resolver.Errors.InvalidDomain();

  return entries.slice(0, 5).map((entry: any): [string, string] => {
    const keyHex = entry?.k?.bytes;
    const addressDatum = entry?.v;
    const payment = addressDatum?.fields?.[0];
    const staking = addressDatum?.fields?.[1];
    const paymentHash = payment?.fields?.[0]?.bytes;
    if (addressDatum?.constructor !== 0 || !/^[0-9a-fA-F]{56}$/.test(paymentHash ?? '') || !/^(?:[0-9a-fA-F]{2})*$/.test(keyHex ?? '')) {
      throw new Resolver.Errors.InvalidDomain();
    }

    const address = RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const paymentCredential = payment.constructor === 0
        ? cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(paymentHash))
        : cml.Credential.new_script(cml.ScriptHash.from_hex(paymentHash));
      const stakeRecord = staking?.constructor === 0 ? staking.fields?.[0]?.fields?.[0]?.fields?.[0]?.bytes : null;
      const stakeCredential = typeof stakeRecord === 'string'
        ? cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(stakeRecord))
        : null;
      const result = stakeCredential == null
        ? cml.EnterpriseAddress.new(config.networkId, paymentCredential).to_address()
        : cml.BaseAddress.new(config.networkId, paymentCredential, stakeCredential).to_address();
      return result.to_bech32();
    });
    return [Buffer.from(keyHex, 'hex').toString('utf8'), address];
  });
};

const resolveCns = async (resolve: string, isMainnet: boolean, fetcherConfig: any, requestFn: any, metadataFetcher: any): Promise<string> => {
  if (!resolve.includes('.')) throw new Resolver.Errors.InvalidDomain();
  if (!resolve.endsWith('.ada')) throw new Resolver.Errors.UnsupportedTld();
  const config = isMainnet ? cnsConfigs.mainnet : cnsConfigs.preprod;
  const parts = resolve.split('.');
  const parentName = parts.length === 3 ? `${parts[1]}.${parts[2]}` : resolve;
  const assetName = Buffer.from(parentName, 'utf8').toString('hex');
  const metadata = await getCnsMetadata(config, config.cnsPolicyId, assetName, fetcherConfig, metadataFetcher);

  if (parts.length === 2) return getCnsAssetAddress(config, config.cnsPolicyId, assetName, fetcherConfig, requestFn);
  if (parts.length !== 3) throw new Resolver.Errors.InvalidDomain();
  if (metadata.virtualSubdomainEnabled !== 'Enabled') throw new Resolver.Errors.NotFound();
  const virtualSubdomains = await getVirtualSubdomains(config, assetName, fetcherConfig, requestFn);
  const target = virtualSubdomains.find(([name]) => name === parts[0]);
  if (!target) throw new Resolver.Errors.NotFound();
  return target[1];
};

const resolveHandle = async (resolve: string, isMainnet: boolean, fetcherConfig: any, requestFn: any): Promise<string> => {
  if (!resolve.startsWith('$') || resolve.length < 2) throw new Resolver.Errors.InvalidDomain();
  const handle = resolve.replace(/^\$/, '');
  let response;
  try {
    response = await requestData({ url: `${isMainnet ? handleApiAddress.mainnet : handleApiAddress.preprod}${handle}` }, fetcherConfig, requestFn);
  } catch (error) {
    throw handleCnsApiError(error);
  }
  if (typeof response?.resolved_addresses?.ada !== 'string') throw new Resolver.Errors.InvalidResponse();
  return response.resolved_addresses.ada;
};

const resolveUnstoppable = async (resolve: string, apiKey: string, fetcherConfig: any, requestFn: any): Promise<string> => {
  if (!resolve.includes('.')) throw new Resolver.Errors.InvalidDomain();
  if (!unstoppableTlds.some(tld => resolve.endsWith(tld))) throw new Resolver.Errors.UnsupportedTld();
  let response;
  try {
    response = await requestData(
      { url: `${unstoppableApiAddress}${resolve}`, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` } },
      fetcherConfig,
      requestFn
    );
  } catch (error) {
    throw handleCnsApiError(error);
  }
  const address = response?.records?.['crypto.ADA.address'];
  if (typeof address === 'string') return address;
  if (typeof response?.meta?.blockchain === 'string') throw new Resolver.Errors.WrongBlockchain();
  throw new Resolver.Errors.InvalidResponse();
};

export const handleApiGetCryptoAddress = ({ request = fetchData, isMainnet = true }: any = {}): any =>
  (resolve: string, fetcherConfig: any): Promise<string> => resolveHandle(resolve, isMainnet, fetcherConfig, request);

export const unstoppableApiGetCryptoAddress = ({ apiKey }: any, { request = fetchData }: any = {}): any =>
  (resolve: string, fetcherConfig: any): Promise<string> => resolveUnstoppable(resolve, apiKey, fetcherConfig, request);

export const cnsCryptoAddress = (
  request: any = fetchData,
  metadataFetcher: any = (baseUrl, ids, fetcherConfig) => CardanoApi.getOnChainMetadatas(baseUrl)(ids, fetcherConfig),
  isMainnet: boolean = true
): any => (resolve: string, fetcherConfig: any): Promise<string> =>
  resolveCns(resolve, isMainnet, fetcherConfig, request, metadataFetcher);

export const handleCnsApiError = (error: any): any =>
  error instanceof Api.Errors.NotFound ? new Resolver.Errors.NotFound() : error;

export const resolverApiMaker = (
  { apiConfig, isMainnet = true }: any,
  { request = fetchData, getMetadatas = (baseUrl, ids, fetcherConfig) => CardanoApi.getOnChainMetadatas(baseUrl)(ids, fetcherConfig) }: any = {}
): any => ({
  getCardanoAddresses: async ({ resolve, strategy = 'all' }: any, fetcherConfig: any): Promise<Array<any>> => {
    const operations = [
      [Resolver.NameServer.Handle, () => resolveHandle(resolve, isMainnet, fetcherConfig, request)],
      [Resolver.NameServer.Unstoppable, () => resolveUnstoppable(resolve, apiConfig?.[Resolver.NameServer.Unstoppable]?.apiKey ?? '', fetcherConfig, request)],
      [Resolver.NameServer.Cns, () => resolveCns(resolve, isMainnet, fetcherConfig, request, getMetadatas)],
    ];
    const run = async ([nameServer, operation]: any): Promise<any> => {
      try {
        return { address: await operation(), error: null, nameServer };
      } catch (error) {
        if (error instanceof Api.Errors.NotFound) return { address: null, error: new Resolver.Errors.NotFound(), nameServer };
        return { address: null, error, nameServer };
      }
    };
    if (strategy === 'all') return Promise.all(operations.map(run));
    try {
      return [await Promise.any(operations.map(async ([nameServer, operation]: any): Promise<any> => {
        const address = await operation();
        return { address, error: null, nameServer };
      }))];
    } catch (_error) {
      return [{ address: null, error: new Resolver.Errors.NotFound(), nameServer: null }];
    }
  },
});
