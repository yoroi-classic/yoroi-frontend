// @flow

import axios from 'axios';
import BigNumber from 'bignumber.js';
import chunk from 'lodash/chunk';
import type {
  Asset,
  UtxoApiContract,
  UtxoApiResponse,
  UtxoAtPointRequest,
  UtxoDiff,
  UtxoDiffSincePointRequest,
  TipStatusReference,
  Utxo,
} from './utxoTypes';
import { DiffType, UtxoApiResult } from './utxoTypes';

type ApiError = { response?: { data?: { error?: { response?: string } } } };

function referenceError(error: ApiError): $Values<typeof UtxoApiResult> {
  const kind = error.response?.data?.error?.response;
  if (kind === 'REFERENCE_POINT_BLOCK_NOT_FOUND') return UtxoApiResult.SAFEBLOCK_ROLLBACK;
  throw error;
}

function referenceOrBestBlockError(error: ApiError): $Values<typeof UtxoApiResult> {
  const kind = error.response?.data?.error?.response;
  if (kind === 'REFERENCE_BESTBLOCK_NOT_FOUND') return UtxoApiResult.BESTBLOCK_ROLLBACK;
  return referenceError(error);
}

export class BatchedUtxoApi implements UtxoApiContract {
  base: UtxoApiContract;
  maxAddresses: number;

  constructor(base: UtxoApiContract, maxAddresses: number = 500) {
    this.base = base;
    this.maxAddresses = maxAddresses;
  }

  getSafeBlock(): Promise<string> {
    return this.base.getSafeBlock();
  }
  getBestBlock(): Promise<string> {
    return this.base.getBestBlock();
  }
  getTipStatusWithReference(bestBlocks: string[]): Promise<UtxoApiResponse<TipStatusReference>> {
    return this.base.getTipStatusWithReference(bestBlocks);
  }

  async getUtxoAtPoint(request: UtxoAtPointRequest): Promise<UtxoApiResponse<Utxo[]>> {
    if (request.addresses.length === 0) return { result: UtxoApiResult.SUCCESS, value: [] };
    try {
      const batches = await Promise.all(
        chunk(request.addresses, this.maxAddresses).map(addresses =>
          this.base.getUtxoAtPoint({ addresses, referenceBlockHash: request.referenceBlockHash })
        )
      );
      const failedBatch = batches.find(batch => batch.result !== UtxoApiResult.SUCCESS);
      if (failedBatch != null) return { result: failedBatch.result };
      return { result: UtxoApiResult.SUCCESS, value: batches.flatMap(batch => batch.value ?? []) };
    } catch (error) {
      return { result: referenceError(error) };
    }
  }

  async getUtxoDiffSincePoint(request: UtxoDiffSincePointRequest): Promise<UtxoApiResponse<UtxoDiff>> {
    if (request.addresses.length === 0) {
      return {
        result: UtxoApiResult.SUCCESS,
        value: {
          diffItems: [],
          reference: { lastFoundBestBlock: request.untilBlockHash, lastFoundSafeBlock: request.afterBestBlocks[0] },
        },
      };
    }
    try {
      const batches = await Promise.all(
        chunk(request.addresses, this.maxAddresses).map(addresses => this.base.getUtxoDiffSincePoint({ ...request, addresses }))
      );
      const failedBatch = batches.find(batch => batch.result !== UtxoApiResult.SUCCESS);
      if (failedBatch != null) return { result: failedBatch.result };
      const diffs = batches.map(batch => {
        if (batch.value == null) throw new Error('Successful UTxO diff batch is missing its value');
        return batch.value;
      });
      const bestBlocks = new Set(diffs.map(diff => diff.reference.lastFoundBestBlock));
      if (bestBlocks.size > 1) return { result: UtxoApiResult.BESTBLOCK_ROLLBACK };
      const safeBlockIndex = Math.max(
        ...diffs.map(diff => {
          const hash = diff.reference.lastFoundSafeBlock;
          return hash == null ? -1 : request.afterBestBlocks.indexOf(hash);
        })
      );
      if (safeBlockIndex < 0) return { result: UtxoApiResult.SAFEBLOCK_ROLLBACK };
      return {
        result: UtxoApiResult.SUCCESS,
        value: {
          diffItems: diffs.flatMap(diff => diff.diffItems),
          reference: {
            lastFoundBestBlock: diffs[0].reference.lastFoundBestBlock,
            lastFoundSafeBlock: request.afterBestBlocks[safeBlockIndex],
          },
        },
      };
    } catch (error) {
      const result = referenceOrBestBlockError(error);
      return { result };
    }
  }
}

type UtxoApiAtPointResponse = {|
  utxo_id: string,
  tx_hash: string,
  tx_index: number,
  receiver: string,
  amount: string,
  assets: Asset[],
  block_num: number,
|};
export class CardanoWalletUtxoApi implements UtxoApiContract {
  apiUrl: string;
  throwRequestErrors: boolean;
  pageSize: number;

  constructor(apiUrl: string, throwRequestErrors: boolean, pageSize: number = 50) {
    this.apiUrl = apiUrl;
    this.throwRequestErrors = throwRequestErrors;
    this.pageSize = pageSize;
  }

  async getSafeBlock(): Promise<string> {
    const response = await axios.get(`${this.apiUrl}v2/tipStatus`);
    return response.data.safeBlock.hash;
  }

  async getBestBlock(): Promise<string> {
    const response = await axios.get(`${this.apiUrl}v2/tipStatus`);
    return response.data.bestBlock.hash;
  }

  async getTipStatusWithReference(bestBlocks: string[]): Promise<UtxoApiResponse<TipStatusReference>> {
    try {
      const response = await axios.post(`${this.apiUrl}v2/tipStatus`, { reference: { bestBlocks } });
      return {
        result: UtxoApiResult.SUCCESS,
        value: {
          reference: {
            lastFoundBestBlock: response.data.reference.lastFoundBestBlock,
            lastFoundSafeBlock: response.data.reference.lastFoundSafeBlock,
          },
        },
      };
    } catch (error) {
      if (error.response?.data?.error?.response === 'REFERENCE_POINT_BLOCK_NOT_FOUND') {
        return { result: UtxoApiResult.SAFEBLOCK_ROLLBACK };
      }
      throw error;
    }
  }

  async getUtxoAtPoint(request: UtxoAtPointRequest): Promise<UtxoApiResponse<Utxo[]>> {
    try {
      let page = 1;
      let pageItems = await this.getUtxoAtPointPage(request, page);
      const allItems = [...pageItems];
      while (pageItems.length === this.pageSize) {
        page += 1;
        pageItems = await this.getUtxoAtPointPage(request, page);
        allItems.push(...pageItems);
      }
      return {
        result: UtxoApiResult.SUCCESS,
        value: allItems.map(item => ({
          utxoId: item.utxo_id,
          amount: new BigNumber(item.amount),
          assets: item.assets,
          blockNum: item.block_num,
          receiver: item.receiver,
          txHash: item.tx_hash,
          txIndex: item.tx_index,
        })),
      };
    } catch (error) {
      if (this.throwRequestErrors) throw error;
      return { result: referenceError(error) };
    }
  }

  async getUtxoDiffSincePoint(request: UtxoDiffSincePointRequest): Promise<UtxoApiResponse<UtxoDiff>> {
    const url = `${this.apiUrl}v2/txs/utxoDiffSincePoint`;
    try {
      let response = await axios.post(url, {
        addresses: request.addresses,
        untilBlockHash: request.untilBlockHash,
        afterBestblocks: request.afterBestBlocks,
        diffLimit: this.pageSize,
      });
      if (response.data.lastFoundBestblock == null)
        throw new Error('Unexpected state: no bestblock match is found in the request reference!');
      const reference = {
        lastFoundBestBlock: response.data.lastFoundBestblock,
        lastFoundSafeBlock: response.data.lastFoundSafeblock,
      };
      const items = [...response.data.diffItems];
      while (response.data.diffItems.length === this.pageSize) {
        response = await axios.post(url, {
          addresses: request.addresses,
          untilBlockHash: request.untilBlockHash,
          afterPoint: response.data.lastDiffPointSelected,
          diffLimit: this.pageSize,
        });
        items.push(...response.data.diffItems);
      }
      return {
        result: UtxoApiResult.SUCCESS,
        value: {
          diffItems: items.map(item => {
            const base = { amount: new BigNumber(item.amount), id: item.id, type: item.type };
            if (item.type === DiffType.INPUT) return base;
            return {
              ...base,
              utxo: {
                amount: new BigNumber(item.amount),
                assets: item.assets,
                blockNum: item.block_num,
                receiver: item.receiver,
                txHash: item.tx_hash,
                txIndex: item.tx_index,
                utxoId: item.id,
              },
            };
          }),
          reference,
        },
      };
    } catch (error) {
      if (this.throwRequestErrors) throw error;
      return { result: referenceOrBestBlockError(error) };
    }
  }

  async getUtxoAtPointPage(request: UtxoAtPointRequest, page: number): Promise<UtxoApiAtPointResponse[]> {
    const response = await axios.post(`${this.apiUrl}v2/txs/utxoAtPoint`, {
      addresses: request.addresses,
      referenceBlockHash: request.referenceBlockHash,
      page,
      pageSize: this.pageSize,
    });
    return response.data;
  }
}

export default class UtxoApi extends BatchedUtxoApi {
  static utxoApiFactory: string => UtxoApiContract = backendServiceUrl =>
    new CardanoWalletUtxoApi(`${backendServiceUrl}/api/`, true);

  constructor(backendServiceUrl: string) {
    super(UtxoApi.utxoApiFactory(backendServiceUrl));
  }
}
