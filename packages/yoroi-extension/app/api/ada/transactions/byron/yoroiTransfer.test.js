// @flow
import '../../lib/test-config.forTests';
import BigNumber from 'bignumber.js';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { buildYoroiTransferTx } from './yoroiTransfer';
import { networks } from '../../lib/storage/database/prepackaged/networks';
import { Bip44DerivationLevels } from '../../lib/storage/database/walletTypes/bip44/api/utils';

beforeAll(async () => {
  await RustModule.load();
});

test('builds and signs legacy-wallet transfer summary from the CML send-all transaction bytes', async () => {
  const legacyAddressHex = '82d818582183581c99394e1ca570f79e250651062545898c022145444079d9019b612a51a0001a2ebac743';
  const addressing = { path: [0, 0], startLevel: Bip44DerivationLevels.CHAIN.level };
  const utxo = {
    amount: '10000000',
    receiver: legacyAddressHex,
    tx_hash: '11'.repeat(32),
    tx_index: 0,
    utxo_id: '11'.repeat(32) + '00',
    assets: [],
    addressing,
  };
  const key = RustModule.CML.Bip32PrivateKey.from_bip39_entropy(new Uint8Array(16), new Uint8Array(0));
  let signingKey = key;
  for (const index of [44 + 0x80000000, 1815 + 0x80000000, 0x80000000]) signingKey = signingKey.derive(index);

  const summary = await buildYoroiTransferTx({
    senderUtxos: [utxo],
    outputAddr: { address: legacyAddressHex, addressing },
    keyLevel: Bip44DerivationLevels.ACCOUNT.level,
    signingKey,
    absSlotNumber: new BigNumber(0),
    protocolParams: {
      keyDeposit: '2000000',
      linearFeeCoefficient: '44',
      linearFeeConstant: '155381',
      coinsPerUtxoByte: '4310',
      poolDeposit: '500000000',
      networkId: networks.CardanoMainnet.NetworkId,
    },
    networkId: networks.CardanoMainnet.NetworkId,
  });

  expect(summary.encodedTx).toBeInstanceOf(Uint8Array);
  const details = RustModule.WasmScope(Module => {
    const tx = Module.CML.Transaction.from_cbor_bytes(summary.encodedTx);
    const body = tx.body();
    return {
      id: Module.CML.hash_transaction(body).to_hex(),
      fee: body.fee().toString(),
      inputCount: body.inputs().len(),
      bootstrapCount: tx.witness_set().bootstrap_witnesses()?.len() ?? 0,
    };
  });
  expect(summary.id).toBe(details.id);
  expect(summary.fee.getDefaultEntry().amount.toString()).toBe(details.fee);
  expect(details.inputCount).toBe(1);
  expect(details.bootstrapCount).toBeGreaterThan(0);
  expect(summary.senders).toEqual([legacyAddressHex]);
  expect(summary.receivers).toEqual([legacyAddressHex]);
});
