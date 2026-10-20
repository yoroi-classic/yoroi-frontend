// @flow

import '../../lib/test-config.forTests';
import BigNumber from 'bignumber.js';
import { schema } from 'lovefield';
import { yoroiTransferTxFromAddresses } from './legacyYoroi';
import { silenceLogsForTesting } from '../../../../utils/logging';
import { Bip44DerivationLevels } from '../../lib/storage/database/walletTypes/bip44/api/utils';
import type { Address, Addressing } from '../../lib/storage/models/PublicDeriver/interfaces';
import { ChainDerivations } from '../../../../config/numbersConfig';

import { loadLovefieldDB } from '../../lib/storage/database/index';
import { networks, getCardanoHaskellBaseConfig } from '../../lib/storage/database/prepackaged/networks';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';

beforeAll(async () => {
  await RustModule.load();
  await loadLovefieldDB(schema.DataStoreType.MEMORY);
  silenceLogsForTesting();
});

const network = networks.CardanoMainnet;

function getProtocolParams(): {|
  keyDeposit: string,
  linearFeeCoefficient: string,
  linearFeeConstant: string,
  coinsPerUtxoByte: string,
  poolDeposit: string,
  networkId: number,
|} {
  const baseConfig = getCardanoHaskellBaseConfig(network).reduce((acc, next) => Object.assign(acc, next), {});
  return {
    keyDeposit: baseConfig.KeyDeposit,
    linearFeeCoefficient: baseConfig.LinearFee.coefficient,
    linearFeeConstant: baseConfig.LinearFee.constant,
    coinsPerUtxoByte: baseConfig.CoinsPerUtxoByte,
    poolDeposit: baseConfig.PoolDeposit,
    networkId: network.NetworkId,
  };
}

function getByronAddress(derivationId: number): {| ...Address, ...Addressing |} {
  return {
    // Frozen output from the legacy WalletV2 derivation path for this fixture key.
    address: 'Ae2tdPwUPEZEv5eQSvigCELuNxVTkn6yAomCbo2FKoxZUPXME9g6CJ4CyCW',
    addressing: {
      path: [ChainDerivations.EXTERNAL, derivationId],
      startLevel: Bip44DerivationLevels.CHAIN.level,
    },
  };
}

describe('Haskell Shelley era tx format tests', () => {
  test('Yoroi transfer from single small UTXO', async () => {
    const txId = '915f2e6865fb31cc93410efb6c0e580ca74862374b3da461e20135c01f312e7c';
    const inputAmount = new BigNumber('10000000');
    const txIndex = 0;
    const outAddress = 'Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4';

    const accountPrivateKeyHex =
      '408a1cb637d615c49e8696c30dd54883302a20a7b9b8a9d1c307d2ed3cd50758c9402acd000461a8fc0f25728666e6d3b86d031b8eea8d2f69b21e8aa6ba2b153e3ec212cc8a36ed9860579dfe1e3ef4d6de778c5dbdd981623b48727cd96247';
    const accountPrivateKeyBytes = RustModule.WasmScope(Module =>
      Module.CML.Bip32PrivateKey.from_raw_bytes(Buffer.from(accountPrivateKeyHex, 'hex')).to_raw_bytes()
    );

    const addr1 = getByronAddress(0);
    const addr2 = getByronAddress(1);

    const utxo = {
      utxo_id: 'ignore',
      tx_hash: txId,
      tx_index: txIndex,
      receiver: addr1.address,
      amount: inputAmount.toString(),
      assets: [],
    };

    const baseConfig = networks.CardanoMainnet.BaseConfig[0];
    if (baseConfig.ByronNetworkId == null) {
      throw new Error(`missing Byron network id`);
    }

    const transferInfo = await yoroiTransferTxFromAddresses({
        addresses: [addr1, addr2],
        network,
        getUTXOsForAddresses: _addresses => Promise.resolve([utxo]),
        keyLevel: Bip44DerivationLevels.ACCOUNT.level,
        signingKey: accountPrivateKeyBytes,
        outputAddr: {
          address: outAddress,
        },
        absSlotNumber: new BigNumber(1),
        protocolParams: getProtocolParams(),
    });

    const expectedFee = new BigNumber('166601');
    expect(transferInfo.fee.getDefault().toString()).toBe(expectedFee.toString());
    expect(transferInfo.recoveredBalance.getDefault().toString()).toBe(inputAmount.toString());
    expect(transferInfo.senders).toEqual([addr1.address]);
    expect(transferInfo.receivers[0]).toBe(outAddress);

    // check tx itself
    if (!transferInfo.encodedTx) throw new Error(`Tx not signed`);
    const signedTxDetails = RustModule.WasmScope(Module => {
      const signedTx = Module.CML.Transaction.from_cbor_bytes(transferInfo.encodedTx);
      const body = signedTx.body();
      const input = body.inputs().get(0);
      const output = body.outputs().get(0);
      const witnesses = signedTx.witness_set().bootstrap_witnesses();
      if (witnesses == null) throw new Error('no bootstrap witnesses found');
      return {
        inputCount: body.inputs().len(),
        inputId: input.transaction_id().to_hex(),
        inputIndex: input.index().toString(),
        outputCount: body.outputs().len(),
        outputAddress: Module.CML.ByronAddress.from_address(output.address())?.to_base58(),
        outputAmount: output.amount().coin().toString(),
        witnessCount: witnesses.len(),
        witness: witnesses.get(0).to_cbor_hex(),
      };
    });
    expect(signedTxDetails).toEqual({
      inputCount: 1,
      inputId: txId,
      inputIndex: String(txIndex),
      outputCount: 1,
      outputAddress: outAddress,
      outputAmount: inputAmount.minus(expectedFee).toString(),
      witnessCount: 1,
      witness:
        '84582007cc5b01ab460562479f3e7fdf782b11636c4a1b721c19b9c1609bc7360b518e5840dfa4a46f92326070f09781cdf2c6e319f8b1b3cc425a257c655ebcfe4445def365c1e888f2b78cdf268586848999ca2ae093d4a9f9bf7667f7e11b2f141bae0d5820f3748736afd541361c4fb90b2963723fe9a10d237a024530d378181df4bf2c6841a0',
    });
  });
});
