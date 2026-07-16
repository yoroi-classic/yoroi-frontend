# CIP-0103 connector audit

Issue: https://github.com/yoroi-classic/yoroi-frontend/issues/16
Audit date: 2026-07-15

## Scope

CIP-0103 extends CIP-30 with:

- `api.cip103.signTxs(txs: TransactionSignatureRequest[]): Promise<cbor<transaction_witness_set>[]>`
- `api.cip103.submitTxs(txs: cbor<transaction>[]): Promise<hash32[]>`

The spec requires `TransactionSignatureRequest` to contain `cbor` and optional `partialSign`, witness results to align with input indexes, `signTxs` failures to throw `TxSignError` with the failing index and no returned witnesses, `submitTxs` to attempt every transaction in order, and the wallet UI to make bulk signing clear to the user.

## Current state

Implemented in the page injector:

- `chrome/content-scripts/cardanoApiInject.js` exposes `api.cip103.signTxs` and `api.cip103.submitTxs`.
- `getExtensions()` advertises CIP-0103 only when both bulk functions exist.
- `signTxs` normalizes each request into witness-only `sign_tx/cardano` RPC calls and appends failing indexes to thrown errors.
- `submitTxs` submits every transaction in order and throws the mixed result array when any submission fails.
- Contract coverage exists in `chrome/content-scripts/cardanoApiInject.test.js` and `app/extensionDependencySmoke.test.js`.

Still single-transaction oriented in the connector runtime:

- `chrome/extension/connector/types.js` has `PendingSignData` entries for `tx/cardano`, `tx-reorg/cardano`, and `data`; there is no bulk `txs/cardano` pending-sign shape.
- `chrome/extension/background/handlers/yoroi/connector.js` retrieves and confirms one pending sign at a time through `SignWindowRetrieveData` and `UserSignConfirm`.
- `app/connector/stores/ConnectorStore.js` stores one `adaTransaction`, one `rawTx`, and one hardware-signing path per confirmation window.
- `app/connector/components/signin/CardanoSignTxPage.js` and the `signin/cardano` summary components render one transaction review.

## Remaining gaps for issue #16

1. `signTxs` currently reaches the connector as repeated single `sign_tx/cardano` RPC calls. That preserves array order at the injector layer, but it can require repeated user approvals and does not satisfy the issue requirement for one explicit bulk approval flow.
2. Earlier transactions in a `signTxs` loop can be approved and signed before a later transaction fails. The dApp receives no witnesses on failure, but the current bridge still performs side effects before the failing index is known.
3. The connector message model needs a batch request type that keeps input indexes, normalized transaction CBOR, `partialSign`, and `returnTx: false` semantics together until one user decision is made.
4. The review store and UI need batch-aware state: per-transaction decoded summaries, aggregate totals, batch count, unresolved input warnings by transaction index, and hardware-wallet signing progress per transaction.
5. Error paths need index-aware mapping from connector failures back to the CIP-0103 `TxSignError` contract. Existing `signFail` only reports one request and does not carry a batch index.
6. `submitTxs` is mostly covered at the injector/RPC contract layer. Any future background changes should preserve the current "attempt every transaction, return or throw index-aligned array" behavior.

## Blockers to resolve before a broad implementation

- Product/design needs to define the bulk review layout: one aggregate approval screen, per-transaction detail navigation, and exact copy that makes multiple transactions unmistakable.
- Engineering needs to decide whether hardware wallets are supported in the first bulk-signing slice or return a typed `TxSignError` until a device-safe signing flow is built.
- The connector bridge should move from repeated single `sign_tx/cardano` requests to one batch pending-sign request before runtime behavior can honestly satisfy CIP-0103.

## Suggested next implementation slices

1. Add Flow types for `TransactionSignatureRequest`, a batch Cardano pending-sign request, and an indexed signing result/error payload.
2. Add unit coverage around the background connector handler proving one bulk pending sign produces one sign window payload.
3. Refactor `ConnectorStore` to decode an array of Cardano transactions while preserving the existing single-transaction path.
4. Add the batch review UI after the message/store contract is stable.
5. Rewire `cardanoApiInject.js` to use the batch RPC only when the connector advertises that capability, then keep the existing tests for result ordering and indexed failures.
