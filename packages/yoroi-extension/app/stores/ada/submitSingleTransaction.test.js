// @flow

import { submitSingleTransaction } from './submitSingleTransaction';

describe('submitSingleTransaction', () => {
  test.each([
    ['an empty operation', []],
    ['an empty signed transaction', ['']],
    ['a multi-transaction operation', ['84a1', '84a2']],
  ])('rejects %s before broadcasting', async (_label, signedTransactionHexes) => {
    const submit = jest.fn(() => Promise.resolve());

    await expect(submitSingleTransaction({ signedTransactionHexes, submit })).rejects.toThrow(
      'Single transaction submission requires exactly one signed transaction'
    );
    expect(submit).not.toHaveBeenCalled();
  });

  test('submits the single transaction once', async () => {
    const submit = jest.fn(() => Promise.resolve());

    await submitSingleTransaction({ signedTransactionHexes: ['84a1'], submit });

    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith('84a1');
  });

  test('propagates a backend rejection', async () => {
    const backendError = new Error('backend rejected transaction');
    const submit = jest.fn(() => Promise.reject(backendError));

    await expect(submitSingleTransaction({ signedTransactionHexes: ['84a1'], submit })).rejects.toBe(backendError);
  });
});
