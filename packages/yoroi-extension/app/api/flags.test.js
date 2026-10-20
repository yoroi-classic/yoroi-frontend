// @flow

import axios from 'axios';
import { FlagsApi, flagStorageKey } from './flags';

afterEach(() => jest.restoreAllMocks());

test('reads and persists a network feature flag from the backend', async () => {
  const storage = { get: jest.fn(async () => null), set: jest.fn(async () => {}) };
  const get = jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { flags: { feature: { mainnet: 42 } } } });
  const api = new FlagsApi('https://backend/api', storage);
  api.setCaching(false);

  await expect(api.readFlag('feature', 'mainnet', 42)).resolves.toBe(true);
  expect(get).toHaveBeenCalledWith('/v2.1/flags', { baseURL: 'https://backend/api' });
  expect(storage.set).toHaveBeenCalledWith(flagStorageKey('feature', 'mainnet'), '42');
});

test('falls back to persisted global or network flags when the request fails', async () => {
  const get = jest.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));
  const storage = {
    get: jest.fn(async key => (key === flagStorageKey('feature', 'mainnet') ? '100' : 'false')),
    set: jest.fn(async () => {}),
  };
  const api = new FlagsApi('https://backend/api', storage);
  api.setCaching(false);
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await expect(api.readFlag('feature', 'mainnet', 99)).resolves.toBe(false);
  await expect(api.readFlag('feature', 'mainnet', 100)).resolves.toBe(true);
  expect(get).toHaveBeenCalledTimes(2);
});
