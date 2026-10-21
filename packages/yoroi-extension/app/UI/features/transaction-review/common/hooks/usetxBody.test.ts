// @flow
import { beforeAll, expect, test } from '@jest/globals';
import '../../../../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { getCborTxBody, getUnsignedTxTxBody } from './usetxBody';

beforeAll(async () => {
  await RustModule.load();
});

test('parses a CBOR transaction body with CML', async () => {
  // A minimal transaction body with the mandatory inputs, outputs, and fee fields.
  await expect(getCborTxBody('84a3008001800200a0f5f6')).resolves.toMatchObject({ inputs: [], outputs: [], fee: '0' });
});

test('parses unsigned CML body bytes for staking and governance review', async () => {
  const bodyBytes = RustModule.WasmScope(Module => Module.CML.TransactionBody.from_cbor_hex('a3008001800200').to_cbor_bytes());

  await expect(getUnsignedTxTxBody(bodyBytes)).resolves.toMatchObject({
    body: { inputs: [], outputs: [], fee: '0' },
  });
});

test('preserves fees and output coin amounts above Number.MAX_SAFE_INTEGER', async () => {
  const address = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const addressHex = RustModule.WasmScope(Module => Module.CML.Address.from_bech32(address).to_hex());
  const coin = '1b0020000000000001'; // 9007199254740993
  const addressLength = addressHex.length / 2;
  const encodedAddress = `58${addressLength.toString(16).padStart(2, '0')}${addressHex}`;
  const policyId = '00'.repeat(28);
  const assetName = '61';
  const value = `82${coin}a1581c${policyId}a141${assetName}${coin}`;
  const output = `a200${encodedAddress}01${value}`;
  const body = `a300800181${output}02${coin}`;
  const transaction = `84${body}a0f5f6`;

  await expect(getCborTxBody(transaction)).resolves.toMatchObject({
    fee: '9007199254740993',
    outputs: [
      {
        address,
        amount: {
          coin: '9007199254740993',
          multiasset: { [policyId]: { [assetName]: '9007199254740993' } },
        },
      },
    ],
  });
});

test('rejects malformed transaction CBOR', async () => {
  await expect(getCborTxBody('not-cbor')).rejects.toBeDefined();
});
