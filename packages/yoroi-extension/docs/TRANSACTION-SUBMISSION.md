# Transaction submission contract

The extension submits one signed Cardano transaction at a time through the
owned `cardano-wallet-backend` `POST /v1/tx/submit` endpoint. The request body
contains one CBOR value. The client has no batch submission type and does not
fall back to the legacy `/api/txs/signed` route.

## Caller inventory

- `app/api/ada/index.js` submits the single transaction produced by the normal
  sign-and-broadcast flow.
- `app/stores/toplevel/YoroiTransferStore.js` submits one signed transfer.
- `chrome/extension/connector/api.js` submits one CIP-30 transaction.
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
multi-transaction operations therefore fail without any broadcast. A backend
rejection is propagated to the caller, and the wallet refresh only runs after
the single submission succeeds.

This preflight preserves the all-or-nothing client invariant without adding an
unowned atomic batch protocol. Transaction bytes are not included in the
preflight error or additional logs.
