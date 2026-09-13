import { ConnectorBatchSignError, signCip103Batch } from './cip103';

describe('CIP-0103 connector batch signing', () => {
  test('signs in order, aligns witnesses, and exposes prior outputs to chained transactions', async () => {
    const calls = [];
    const sign = jest.fn(async (tx, chainedOutputs) => {
      calls.push({ tx, chainedOutputs: [...chainedOutputs] });
      return `witness-${tx}`;
    });

    await expect(signCip103Batch(['tx-0', 'tx-1', 'tx-2'], sign, tx => [`output-${tx}`])).resolves.toEqual([
      'witness-tx-0',
      'witness-tx-1',
      'witness-tx-2',
    ]);
    expect(calls).toEqual([
      { tx: 'tx-0', chainedOutputs: [] },
      { tx: 'tx-1', chainedOutputs: ['output-tx-0'] },
      { tx: 'tx-2', chainedOutputs: ['output-tx-0', 'output-tx-1'] },
    ]);
  });

  test('fails fast at the signing index and returns no partial witness array', async () => {
    const sign = jest.fn(async tx => {
      if (tx === 'tx-1') throw new Error('signing failed');
      return `witness-${tx}`;
    });

    let error;
    try {
      await signCip103Batch(['tx-0', 'tx-1', 'tx-2'], sign, () => []);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConnectorBatchSignError);
    expect(error.index).toEqual(1);
    expect(sign.mock.calls.map(([tx]) => tx)).toEqual(['tx-0', 'tx-1']);
  });

  test('reports the transaction index when preparing chained outputs fails', async () => {
    const sign = jest.fn(async tx => `witness-${tx}`);

    await expect(
      signCip103Batch(['tx-0', 'tx-1', 'tx-2'], sign, tx => {
        if (tx === 'tx-1') throw new Error('invalid transaction output');
        return [`output-${tx}`];
      })
    ).rejects.toMatchObject({
      index: 1,
      message: 'CIP-0103 transaction 1 failed to sign',
    });
    expect(sign.mock.calls.map(([tx]) => tx)).toEqual(['tx-0', 'tx-1']);
  });
});
