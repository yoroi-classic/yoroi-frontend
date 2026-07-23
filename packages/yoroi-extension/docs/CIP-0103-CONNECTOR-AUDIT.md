# CIP-0103 connector audit

Issue: https://github.com/yoroi-classic/yoroi-frontend/issues/16
Audit date: 2026-07-15

## Scope

CIP-0103 extends CIP-30 with:

- `api.cip103.signTxs(txs: TransactionSignatureRequest[]): Promise<cbor<transaction_witness_set>[]>`
- `api.cip103.submitTxs(txs: cbor<transaction>[]): Promise<hash32[]>`

The spec requires `TransactionSignatureRequest` to contain `cbor` and optional `partialSign`, witness results to align with input indexes, `signTxs` failures to throw `TxSignError` with the failing index and no returned witnesses, `submitTxs` to attempt every transaction in order, and the wallet UI to make bulk signing clear to the user.

## Implemented state

Implemented in the page injector:

- `chrome/content-scripts/cardanoApiInject.js` exposes `api.cip103.signTxs` and `api.cip103.submitTxs`.
- `getExtensions()` advertises CIP-0103 only when both bulk functions exist.
- `signTxs` preflights the complete request and sends one witness-only `sign_txs/cardano` RPC.
- `submitTxs` submits every transaction in order and throws the mixed result array when any submission fails.
- Contract coverage exists in `chrome/content-scripts/cardanoApiInject.test.js` and `app/extensionDependencySmoke.test.js`.

The connector runtime now handles bulk signing end to end:

- `PendingSignData` keeps the ordered normalized transaction requests together under `txs/cardano`.
- One pending request opens one review window and produces one user decision.
- The store decodes every transaction in order, resolves inputs produced by earlier transactions in the same batch, and retains all raw transactions for hardware signing.
- The review screen states the batch size, explains the single approval, and lets the user navigate every transaction summary before confirming.
- Mnemonic and hardware wallets sign in input order. Owned outputs from earlier transactions are available to later chained transactions, and hardware progress is shown by transaction index.
- Signing is fail-fast and never returns a partial witness array. Transaction-specific failures carry the failing input index; batch-level rejection remains an indexless `TxSignError`.
- Submission remains attempt-all and returns or throws an input-aligned array of hashes and `TxSendError` objects.
- Local request-shape validation uses CIP-30 `APIError.InvalidRequest` semantics before any connector RPC.

Regression coverage lives in the injector contract tests, the connector batch-ordering tests, the bulk review rendering test, and the extension dependency smoke suite.
