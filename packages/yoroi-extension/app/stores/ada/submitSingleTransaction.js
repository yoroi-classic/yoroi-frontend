// @flow

type SubmitTransaction = string => Promise<void>;

/**
 * The wallet backend exposes only single-transaction submission. Reject a
 * legacy multi-transaction workflow before broadcasting anything so a client
 * operation cannot become partially submitted.
 */
export async function submitSingleTransaction({
  signedTransactionHexes,
  submit,
}: {|
  signedTransactionHexes: $ReadOnlyArray<string>,
  submit: SubmitTransaction,
|}): Promise<void> {
  if (signedTransactionHexes.length !== 1) {
    throw new Error('Single transaction submission requires exactly one signed transaction');
  }

  await submit(signedTransactionHexes[0]);
}
