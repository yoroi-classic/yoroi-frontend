// @flow

import BigNumber from 'bignumber.js';
import { UtxoService } from './utxoService';
import type { Utxo, UtxoDiffToBestBlock } from './utxoTypes';
import { DiffType, UtxoApiResult } from './utxoTypes';

function utxo(id: string): Utxo {
  return {
    utxoId: id,
    txHash: id,
    txIndex: 0,
    receiver: 'addr',
    amount: new BigNumber(1),
    assets: [],
    blockNum: 1,
  };
}

function diff(block: string, added: Array<Utxo> = [], spent: Array<string> = []): UtxoDiffToBestBlock {
  return { lastBestBlockHash: block, spentUtxoIds: spent, newUtxos: added };
}

test('available UTxOs combine the safe snapshot and deltas while removing spent outputs', async () => {
  const storage = {
    getUtxoAtSafePoint: jest.fn(async () => ({ lastSafeBlockHash: 'safe', utxos: [utxo('kept'), utxo('spent')] })),
    getUtxoDiffToBestBlock: jest.fn(async () => [diff('tip', [utxo('new')], ['spent'])]),
  };
  const service = new UtxoService(({}: any), (storage: any));

  await expect(service.getAvailableUtxos()).resolves.toEqual([utxo('kept'), utxo('new')]);
});

test('sync merges safe deltas, retains the unconfirmed suffix, and appends the new tip delta', async () => {
  const storage = {
    getUtxoAtSafePoint: jest.fn(async () => ({ lastSafeBlockHash: 'safe0', utxos: [utxo('old')] })),
    getUtxoDiffToBestBlock: jest.fn(async () => [diff('block1', [utxo('safe-new')]), diff('block2', [utxo('pending')])]),
    removeDiffWithBestBlock: jest.fn(async () => {}),
    replaceUtxoAtSafePoint: jest.fn(async () => {}),
    clearUtxoState: jest.fn(async () => {}),
    appendUtxoDiffToBestBlock: jest.fn(async () => {}),
  };
  const api = {
    getBestBlock: jest.fn(async () => 'block3'),
    getTipStatusWithReference: jest.fn(async () => ({
      result: UtxoApiResult.SUCCESS,
      value: { reference: { lastFoundBestBlock: 'block2', lastFoundSafeBlock: 'block1' } },
    })),
    getUtxoDiffSincePoint: jest.fn(async () => ({
      result: UtxoApiResult.SUCCESS,
      value: {
        diffItems: [
          { type: DiffType.INPUT, id: 'old', amount: new BigNumber(1) },
          { type: DiffType.OUTPUT, id: 'tip-new', amount: new BigNumber(2), utxo: utxo('tip-new') },
        ],
        reference: { lastFoundBestBlock: 'block2', lastFoundSafeBlock: 'block1' },
      },
    })),
  };
  const service = new UtxoService((api: any), (storage: any));

  await service.syncUtxoState(['addr']);

  expect(storage.removeDiffWithBestBlock).toHaveBeenCalledTimes(1);
  expect(storage.removeDiffWithBestBlock).toHaveBeenCalledWith('block1');
  expect(storage.replaceUtxoAtSafePoint).toHaveBeenCalledWith([utxo('old'), utxo('safe-new')], 'block1');
  expect(storage.appendUtxoDiffToBestBlock).toHaveBeenCalledWith({
    lastBestBlockHash: 'block3',
    spentUtxoIds: ['old'],
    newUtxos: [utxo('tip-new')],
  });
});
