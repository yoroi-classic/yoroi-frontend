// @flow

import axios from 'axios';
import type { StorageAPI } from './localStorage';

const CACHE_TTL = 60 * 60 * 1000;
const cachedResponses = new Map<string, {| expiresAt: number, data: any |}>();

export function flagStorageKey(feature: string, network: ?string = null): string {
  return `flag://${feature}/${network ?? 'global'}`;
}

function parseFlag(value: ?string): ?(boolean | number) {
  if (value == null) return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/\d+/.test(value)) return Number.parseInt(value, 10);
  return null;
}

async function storageGet(feature: string, network: string, storage: ?StorageAPI): Promise<?(boolean | number)> {
  if (storage == null) return null;
  const [networkValue, globalValue] = await Promise.all([
    storage.get(flagStorageKey(feature, network)),
    storage.get(flagStorageKey(feature)),
  ]);
  return parseFlag(networkValue ?? globalValue);
}

async function storageSet(feature: string, network: ?string, value: boolean | number, storage: ?StorageAPI): Promise<void> {
  if (storage != null) await storage.set(flagStorageKey(feature, network), String(value));
}

export class FlagsApi {
  apiUrl: string;
  storage: ?StorageAPI;
  caching: boolean = true;

  constructor(apiUrl: string, storage: ?StorageAPI = null) {
    this.apiUrl = apiUrl;
    this.storage = storage;
  }

  setCaching(caching: boolean): void {
    this.caching = caching;
  }

  async readFlag(feature: string, network: string, bestblock: number): Promise<?boolean> {
    try {
      const cacheKey = `${this.apiUrl}/v2.1/flags`;
      const cached = this.caching ? cachedResponses.get(cacheKey) : null;
      let data;
      if (cached != null && cached.expiresAt > Date.now()) {
        data = cached.data;
      } else {
        const response = await axios.get('/v2.1/flags', { baseURL: this.apiUrl });
        data = response.status === 200 ? response.data : null;
        if (this.caching && response.status === 200) {
          cachedResponses.set(cacheKey, { data, expiresAt: Date.now() + CACHE_TTL });
        }
      }
      if (data != null) {
        const featureFlag = data?.flags?.[feature];
        if (featureFlag != null) {
          if (typeof featureFlag !== 'object') {
            const result = Boolean(featureFlag);
            await storageSet(feature, null, result, this.storage);
            return result;
          }
          const networkFlag = featureFlag[network];
          if (typeof networkFlag === 'boolean') {
            await storageSet(feature, network, networkFlag, this.storage);
            return networkFlag;
          }
          if (typeof networkFlag === 'number') {
            await storageSet(feature, network, networkFlag, this.storage);
            return bestblock >= networkFlag;
          }
        }
      }
    } catch (error) {
      console.error(`Failed to resolve remote flag: ${JSON.stringify({ feature, network, bestblock })}`, error);
    }
    const storedValue = await storageGet(feature, network, this.storage);
    return typeof storedValue === 'number' ? bestblock >= storedValue : storedValue;
  }
}
