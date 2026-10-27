// @flow

import {
  UtxoApiResult,
  type UtxoApiContract,
  type UtxoAtSafePoint,
  type UtxoDiff,
  type UtxoDiffToBestBlock,
  type UtxoStorage,
  type Utxo,
} from './utxoTypes';

/** Maintains the local safe UTxO snapshot and the chain-tip delta. */
export class UtxoService {
  api: UtxoApiContract;
  storage: UtxoStorage;

  constructor(api: UtxoApiContract, storage: UtxoStorage) {
    this.api = api;
    this.storage = storage;
  }

  async getAvailableUtxos(): Promise<Utxo[]> {
    const safePoint = await this.storage.getUtxoAtSafePoint();
    const diffs = await this.storage.getUtxoDiffToBestBlock();
    const utxos = (safePoint?.utxos ?? []).concat(...diffs.map(diff => diff.newUtxos));
    const spentIds = new Set(diffs.flatMap(diff => diff.spentUtxoIds));
    return utxos.filter(utxo => !spentIds.has(utxo.utxoId));
  }

  async syncUtxoState(addresses: string[]): Promise<void> {
    const { safeUtxos, diff, bestBlock, localDiff, tipStatus } = await this.syncSafeStateAndGetDiff(addresses);
    const diffToBestBlock: UtxoDiffToBestBlock = {
      lastBestBlockHash: bestBlock,
      spentUtxoIds: diff.diffItems.filter(item => item.type === 'input').map(item => item.id),
      newUtxos: diff.diffItems.filter(item => item.type === 'output').map(item => item.utxo),
    };

    if (localDiff.length > 0) {
      const knownBestBlock = localDiff.find(entry => entry.lastBestBlockHash === tipStatus.reference.lastFoundBestBlock);
      const rollbackIndex = knownBestBlock == null ? 0 : localDiff.indexOf(knownBestBlock) + 1;
      for (const staleDiff of localDiff.slice(rollbackIndex))
        await this.storage.removeDiffWithBestBlock(staleDiff.lastBestBlockHash);

      if (knownBestBlock != null) {
        const safeDiff = localDiff.find(entry => entry.lastBestBlockHash === tipStatus.reference.lastFoundSafeBlock);
        if (safeDiff != null && tipStatus.reference.lastFoundSafeBlock != null) {
          await this.mergeDiffsIntoSafeUtxoSet(safeUtxos, localDiff, safeDiff, tipStatus.reference.lastFoundSafeBlock);
        }
      }
    }
    await this.storage.appendUtxoDiffToBestBlock(diffToBestBlock);
  }

  async syncSafeStateAndGetDiff(addresses: string[]): Promise<{|
    safeUtxos: Utxo[],
    diff: UtxoDiff,
    bestBlock: string,
    localDiff: UtxoDiffToBestBlock[],
    tipStatus: {| reference: {| lastFoundBestBlock: string, lastFoundSafeBlock?: string |} |},
  |}> {
    const { safeBlockHash, safeUtxos } = await this.getUtxoSafePoint(addresses);
    const localDiff = await this.storage.getUtxoDiffToBestBlock();
    const referenceBlocks = [safeBlockHash, ...localDiff.map(entry => entry.lastBestBlockHash)];
    const tipStatusResponse = await this.api.getTipStatusWithReference(referenceBlocks);
    if (tipStatusResponse.result === UtxoApiResult.SAFEBLOCK_ROLLBACK) {
      await this.storage.clearUtxoState();
      return this.syncSafeStateAndGetDiff(addresses);
    }
    const { safeBlockRollback, value } = await this.getUtxoDiffSincePoint(addresses, referenceBlocks);
    if (safeBlockRollback) {
      await this.storage.clearUtxoState();
      return this.syncSafeStateAndGetDiff(addresses);
    }
    if (value == null) throw new Error('value should not be falsy if safeBlockRollback is false');
    return {
      safeUtxos,
      diff: value.diff,
      bestBlock: value.bestBlock,
      localDiff,
      tipStatus: {
        reference: {
          lastFoundBestBlock: value.diff.reference.lastFoundBestBlock,
          lastFoundSafeBlock: value.diff.reference.lastFoundSafeBlock ?? tipStatusResponse.value?.reference.lastFoundSafeBlock,
        },
      },
    };
  }

  async getUtxoDiffSincePoint(
    addresses: string[],
    afterBestBlocks: string[]
  ): Promise<{|
    safeBlockRollback: boolean,
    value?: {| diff: UtxoDiff, bestBlock: string |},
  |}> {
    const bestBlock = await this.api.getBestBlock();
    const response = await this.api.getUtxoDiffSincePoint({ addresses, afterBestBlocks, untilBlockHash: bestBlock });
    if (response.result === UtxoApiResult.BESTBLOCK_ROLLBACK) return this.getUtxoDiffSincePoint(addresses, afterBestBlocks);
    if (response.result === UtxoApiResult.SAFEBLOCK_ROLLBACK) return { safeBlockRollback: true };
    if (response.value == null) throw new Error('value should be defined when result is SUCCESS');
    return { safeBlockRollback: false, value: { diff: response.value, bestBlock } };
  }

  async mergeDiffsIntoSafeUtxoSet(
    safeUtxos: Utxo[],
    localDiff: UtxoDiffToBestBlock[],
    safeDiff: UtxoDiffToBestBlock,
    lastFoundSafeBlock: string
  ): Promise<void> {
    const utxoMap = new Map(safeUtxos.map(utxo => [utxo.utxoId, utxo]));
    const finalIndex = localDiff.indexOf(safeDiff);
    for (const diff of localDiff.slice(0, finalIndex + 1)) {
      for (const utxo of diff.newUtxos) utxoMap.set(utxo.utxoId, utxo);
      for (const spentId of diff.spentUtxoIds) utxoMap.delete(spentId);
      await this.storage.removeDiffWithBestBlock(diff.lastBestBlockHash);
    }
    await this.storage.replaceUtxoAtSafePoint([...utxoMap.values()], lastFoundSafeBlock);
  }

  async getUtxoSafePoint(addresses: string[]): Promise<{| safeBlockHash: string, safeUtxos: Utxo[] |}> {
    const localSafePoint: ?UtxoAtSafePoint = await this.storage.getUtxoAtSafePoint();
    if (localSafePoint != null) {
      return { safeBlockHash: localSafePoint.lastSafeBlockHash, safeUtxos: localSafePoint.utxos };
    }
    const { safeBlockHash, utxos } = await this.getUtxoAtSafePointFromApi(addresses);
    await this.storage.replaceUtxoAtSafePoint(utxos, safeBlockHash);
    return { safeBlockHash, safeUtxos: utxos };
  }

  async getUtxoAtSafePointFromApi(addresses: string[]): Promise<{| safeBlockHash: string, utxos: Utxo[] |}> {
    const safeBlockHash = await this.api.getSafeBlock();
    const response = await this.api.getUtxoAtPoint({ addresses, referenceBlockHash: safeBlockHash });
    if (response.result === UtxoApiResult.SAFEBLOCK_ROLLBACK) return this.getUtxoAtSafePointFromApi(addresses);
    if (response.value == null) throw new Error('value should be defined when result is SUCCESS');
    return { safeBlockHash, utxos: response.value };
  }
}
