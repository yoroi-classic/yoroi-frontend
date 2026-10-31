// @flow

import axios from 'axios';
import { FlagsApi, flagStorageKey } from './flags';

afterEach(() => {
  jest.restoreAllMocks();
});

test('reads and persists a network feature flag from the backend', async () => {
  const storage = { get: jest.fn(async () => null), set: jest.fn(async () => {}) };
  const get = jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { flags: { feature: { mainnet: 42 } } } });
  const api = new FlagsApi('https://backend/api', storage);
  api.setCaching(false);

  await expect(api.readFlag('feature', 'mainnet', 42)).resolves.toBe(true);
  expect(get).toHaveBeenCalledWith('/v2.1/flags', { baseURL: 'https://backend/api' });
  expect(storage.set).toHaveBeenCalledWith(flagStorageKey('feature', 'mainnet'), '42');
});

test('falls back to the persisted network flag when the request fails', async () => {
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

test('falls back to the persisted global flag when no network flag exists', async () => {
  jest.spyOn(axios, 'get').mockRejectedValue(new Error('offline'));
  const storage = {
    get: jest.fn(async key => (key === flagStorageKey('feature') ? 'false' : null)),
    set: jest.fn(async () => {}),
  };
  const api = new FlagsApi('https://backend/api', storage);
  api.setCaching(false);
  jest.spyOn(console, 'error').mockImplementation(() => {});

  await expect(api.readFlag('feature', 'mainnet', 99)).resolves.toBe(false);
  expect(storage.get).toHaveBeenCalledWith(flagStorageKey('feature', 'mainnet'));
  expect(storage.get).toHaveBeenCalledWith(flagStorageKey('feature'));
});

test('a global backend flag replaces a stale network override', async () => {
  jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { flags: { feature: false } } });
  const storage = { get: jest.fn(async () => 'true'), set: jest.fn(async () => {}) };
  const api = new FlagsApi('https://backend/api', storage);
  api.setCaching(false);

  await expect(api.readFlag('feature', 'mainnet', 99)).resolves.toBe(false);
  expect(storage.set).toHaveBeenCalledWith(flagStorageKey('feature'), 'false');
  expect(storage.set).toHaveBeenCalledWith(flagStorageKey('feature', 'mainnet'), 'false');
});

test('a successful response with no feature clears a stale persisted value', async () => {
  jest.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { flags: {} } });
  const storage = { get: jest.fn(async () => 'true'), set: jest.fn(async () => {}) };
  const api = new FlagsApi('https://backend/api', storage);
  api.setCaching(false);

  await expect(api.readFlag('feature', 'mainnet', 99)).resolves.toBe(false);
  expect(storage.set).toHaveBeenCalledWith(flagStorageKey('feature', 'mainnet'), 'false');
});
