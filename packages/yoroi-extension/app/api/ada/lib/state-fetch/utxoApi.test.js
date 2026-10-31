// @flow

import axios from 'axios';
import { CardanoWalletUtxoApi, BatchedUtxoApi } from './utxoApi';
import { UtxoApiResult } from './utxoTypes';

jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn() }));

const mockedAxios: any = axios;

beforeEach(() => {
  jest.resetAllMocks();
});

test('paginates UTxOs and converts amounts without losing asset or identity fields', async () => {
  mockedAxios.post
    .mockResolvedValueOnce({
      data: [
        {
          utxo_id: 'hash0',
          tx_hash: 'hash',
          tx_index: 0,
          receiver: 'addr',
          amount: '9007199254740993',
          assets: [],
          block_num: 4,
        },
      ],
    })
    .mockResolvedValueOnce({ data: [] });
  const api = new CardanoWalletUtxoApi('http://backend/api/', true, 1);

  const result = await api.getUtxoAtPoint({ addresses: ['addr'], referenceBlockHash: 'block' });
  expect(result.result).toEqual(UtxoApiResult.SUCCESS);
  expect(result.value?.[0]).toMatchObject({ utxoId: 'hash0', txHash: 'hash', txIndex: 0 });
  expect(result.value?.[0].amount.toFixed(0)).toEqual('9007199254740993');
  expect(mockedAxios.post).toHaveBeenNthCalledWith(2, 'http://backend/api/v2/txs/utxoAtPoint', {
    addresses: ['addr'],
    referenceBlockHash: 'block',
    page: 2,
    pageSize: 1,
  });
});

test('maps missing reference points to safe rollback across address batches', async () => {
  const base = {
    getSafeBlock: jest.fn(),
    getBestBlock: jest.fn(),
    getTipStatusWithReference: jest.fn(),
    getUtxoAtPoint: jest.fn(async () => {
      const error: any = new Error('missing reference point');
      error.response = { data: { error: { response: 'REFERENCE_POINT_BLOCK_NOT_FOUND' } } };
      throw error;
    }),
    getUtxoDiffSincePoint: jest.fn(),
  };
  const api = new BatchedUtxoApi((base: any), 1);

  await expect(api.getUtxoAtPoint({ addresses: ['a', 'b'], referenceBlockHash: 'missing' })).resolves.toEqual({
    result: UtxoApiResult.SAFEBLOCK_ROLLBACK,
  });
  expect(base.getUtxoAtPoint).toHaveBeenCalledTimes(2);
});

test('propagates a rollback result returned by any address batch', async () => {
  const base = {
    getSafeBlock: jest.fn(),
    getBestBlock: jest.fn(),
    getTipStatusWithReference: jest.fn(),
    getUtxoAtPoint: jest.fn(),
    getUtxoDiffSincePoint: jest
      .fn()
      .mockImplementationOnce(async () => ({
        result: UtxoApiResult.SUCCESS,
        value: { diffItems: [], reference: { lastFoundBestBlock: 'best', lastFoundSafeBlock: 'safe' } },
      }))
      .mockImplementationOnce(async () => ({ result: UtxoApiResult.SAFEBLOCK_ROLLBACK })),
  };
  const api = new BatchedUtxoApi((base: any), 1);

  await expect(
    api.getUtxoDiffSincePoint({ addresses: ['a', 'b'], untilBlockHash: 'best', afterBestBlocks: ['safe'] })
  ).resolves.toEqual({ result: UtxoApiResult.SAFEBLOCK_ROLLBACK });
});

test('returns an empty successful diff without treating no addresses as a rollback', async () => {
  const base = {
    getSafeBlock: jest.fn(),
    getBestBlock: jest.fn(),
    getTipStatusWithReference: jest.fn(),
    getUtxoAtPoint: jest.fn(),
    getUtxoDiffSincePoint: jest.fn(),
  };
  const api = new BatchedUtxoApi((base: any), 1);

  await expect(api.getUtxoDiffSincePoint({ addresses: [], untilBlockHash: 'best', afterBestBlocks: ['safe'] })).resolves.toEqual({
    result: UtxoApiResult.SUCCESS,
    value: { diffItems: [], reference: { lastFoundBestBlock: 'best', lastFoundSafeBlock: 'safe' } },
  });
  expect(base.getUtxoDiffSincePoint).not.toHaveBeenCalled();
});
