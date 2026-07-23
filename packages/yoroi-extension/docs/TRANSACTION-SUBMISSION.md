# Transaction submission contract

The extension submits one signed Cardano transaction at a time through the
owned `cardano-wallet-backend` `POST /v1/tx/submit` endpoint. The request body is
JSON shaped as `{ "cbor": "<signed transaction hex>" }`. The client has no
atomic batch submission type and does not fall back to the legacy
`/api/txs/signed` route.

## Caller inventory

- `app/api/ada/index.js` submits the single transaction produced by the normal
  sign-and-broadcast flow.
- `app/stores/toplevel/YoroiTransferStore.js` submits one signed transfer.
- `chrome/extension/connector/api.js` submits one CIP-30 transaction.
- `chrome/content-scripts/cardanoApiInject.js` implements CIP-103 `submitTxs`
  as multiple independent `submit_tx` RPC calls. This is deliberately not an
  atomic client operation: every item is attempted, and an index-aligned mixed
  result exposes hashes for transactions that succeeded before or after a
  failure. Internal workflows that require all-or-nothing behavior must not use
  this API.
- `chrome/extension/background/handlers/yoroi/transaction.js` accepts and
  records one signed transaction per request.
- `SwapStore.executeTransactionHex` accepts only one signed transaction. The
  current swap cancellation UI calls this single-transaction boundary
  directly.
- The legacy swap cancellation UI can construct two dependent transactions: a
  collateral-reorganization transaction followed by the cancellation. That
  multi-transaction operation is retired. Its legacy caller uses
  `submitSingleTransaction` to reject the operation before invoking the
  single-transaction store boundary, so neither transaction is broadcast.

## Failure semantics

`submitSingleTransaction` checks that an operation contains exactly one signed
transaction before invoking the network submission callback. Empty and
multi-transaction atomic operations therefore fail without any broadcast. An
empty transaction value is rejected as well. A backend rejection is propagated
to the caller, and the wallet refresh only runs after the single submission
succeeds. The wallet does not retry submission automatically; after an
ambiguous transport failure, callers must reconcile wallet/backend state before
asking the user to submit again.

This preflight preserves the all-or-nothing client invariant without adding an
unowned atomic batch protocol. Transaction bytes are not included in the
preflight error or additional logs.
