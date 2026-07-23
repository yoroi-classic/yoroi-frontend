// @flow

export class ConnectorBatchSignError extends Error {
  index: number;

  constructor(index: number) {
    super(`CIP-0103 transaction ${index} failed to sign`);
    this.index = index;
  }
}

export async function signCip103Batch<Tx, Witness, ChainedOutput>(
  txs: Array<Tx>,
  signTransaction: (Tx, Array<ChainedOutput>) => Promise<Witness>,
  collectChainedOutputs: Tx => Array<ChainedOutput>
): Promise<Array<Witness>> {
  const chainedOutputs = [];
  const witnesses = [];
  for (let index = 0; index < txs.length; index++) {
    try {
      witnesses.push(await signTransaction(txs[index], chainedOutputs));
      chainedOutputs.push(...collectChainedOutputs(txs[index]));
    } catch (_error) {
      throw new ConnectorBatchSignError(index);
    }
  }
  return witnesses;
}
