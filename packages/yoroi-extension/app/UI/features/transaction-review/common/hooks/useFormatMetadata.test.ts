// @flow
import { beforeAll, expect, test } from '@jest/globals';
import '../../../../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { formatCborMetadata, formatUnsignedTxMetadata } from './useFormatMetadata';

beforeAll(async () => {
  await RustModule.load();
});

test('parses transaction auxiliary metadata with CML', () => {
  // Label 674 contains a map with one CIP-20-style message string.
  const txCbor = '84a3008001800200a0f5a11902a2a1636d736781717b2268656c6c6f223a22776f726c64227d';

  expect(formatCborMetadata(txCbor, { auxiliary_data_hash: 'metadata-hash' } as any)).toEqual({
    hash: 'metadata-hash',
    metadata: { msg: [{ hello: 'world' }] },
  });
});

test('parses auxiliary metadata bytes for unsigned transaction review', () => {
  const txCbor = '84a3008001800200a0f5a11902a2a1636d736781717b2268656c6c6f223a22776f726c64227d';
  const metadataBytes = RustModule.WasmScope(Module => {
    const auxiliaryData = Module.CML.Transaction.from_cbor_hex(txCbor).auxiliary_data();
    if (auxiliaryData == null) throw new Error('Expected transaction auxiliary data');
    return auxiliaryData.to_cbor_bytes();
  });

  expect(formatUnsignedTxMetadata(metadataBytes, { auxiliary_data_hash: 'metadata-hash' } as any)).toEqual({
    hash: 'metadata-hash',
    metadata: { msg: [{ hello: 'world' }] },
  });
});

test('returns null metadata for malformed transaction CBOR', () => {
  expect(formatCborMetadata('not-cbor', { auxiliary_data_hash: null } as any)).toEqual({ hash: null, metadata: null });
});
