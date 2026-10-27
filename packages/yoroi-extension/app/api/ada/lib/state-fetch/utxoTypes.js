// @flow

import BigNumber from 'bignumber.js';

export const UtxoApiResult = Object.freeze({
  SUCCESS: 'SUCCESS',
  BESTBLOCK_ROLLBACK: 'BESTBLOCK_ROLLBACK',
  SAFEBLOCK_ROLLBACK: 'SAFEBLOCK_ROLLBACK',
});

export const DiffType = Object.freeze({ INPUT: 'input', OUTPUT: 'output' });

export type Asset = { assetId: string, policyId: string, name: string, amount: string, ... };
export type Utxo = {
  utxoId: string,
  txHash: string,
  txIndex: number,
  receiver: string,
  amount: BigNumber,
  assets: Asset[],
  blockNum: number,
  ...
};
export type UtxoApiResponse<T> = { result: $Values<typeof UtxoApiResult>, value?: T, ... };
export type TipStatusReference = { reference: { lastFoundSafeBlock: string, lastFoundBestBlock: string, ... }, ... };
export type UtxoAtPointRequest = { addresses: string[], referenceBlockHash: string, ... };
export type UtxoDiffSincePointRequest = { addresses: string[], untilBlockHash: string, afterBestBlocks: string[], ... };
export type UtxoDiffItemInput = { type: 'input', id: string, amount: BigNumber, ... };
export type UtxoDiffItemOutput = { type: 'output', id: string, amount: BigNumber, utxo: Utxo, ... };
export type UtxoDiffItem = UtxoDiffItemInput | UtxoDiffItemOutput;
export type UtxoDiff = {
  diffItems: Array<UtxoDiffItem>,
  reference: { lastFoundBestBlock: string, lastFoundSafeBlock?: string, ... },
  ...
};
export type UtxoDiffToBestBlock = { lastBestBlockHash: string, spentUtxoIds: string[], newUtxos: Utxo[], ... };
export type UtxoAtSafePoint = { lastSafeBlockHash: string, utxos: Utxo[], ... };

export interface UtxoApiContract {
  getBestBlock(): Promise<string>;
  getSafeBlock(): Promise<string>;
  getTipStatusWithReference(bestBlocks: string[]): Promise<UtxoApiResponse<TipStatusReference>>;
  getUtxoAtPoint(req: UtxoAtPointRequest): Promise<UtxoApiResponse<Utxo[]>>;
  getUtxoDiffSincePoint(req: UtxoDiffSincePointRequest): Promise<UtxoApiResponse<UtxoDiff>>;
}

export interface UtxoStorage {
  getUtxoAtSafePoint(): Promise<?UtxoAtSafePoint>;
  getUtxoDiffToBestBlock(): Promise<UtxoDiffToBestBlock[]>;
  replaceUtxoAtSafePoint(utxos: Utxo[], safeBlockHash: string): Promise<void>;
  clearUtxoState(): Promise<void>;
  appendUtxoDiffToBestBlock(diff: UtxoDiffToBestBlock): Promise<void>;
  removeDiffWithBestBlock(blockHash: string): Promise<void>;
}
