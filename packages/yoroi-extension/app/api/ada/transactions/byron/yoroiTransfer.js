// @flow

import BigNumber from 'bignumber.js';
import { Logger, stringifyError } from '../../../../utils/logging';
import { GenerateTransferTxError } from '../../../common/errors';
import LocalizableError from '../../../../i18n/LocalizableError';
import { sendAllUnsignedTx, signTransaction } from '../shelley/transactions';
import type { CardanoAddressedUtxo } from '../types';
import type { TransferTx } from '../../../../types/TransferTypes';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import type { Address, Addressing } from '../../lib/storage/models/PublicDeriver/interfaces';
import { MultiToken } from '../../../common/lib/MultiToken';
import { PRIMARY_ASSET_CONSTANTS } from '../../lib/storage/database/primitives/enums';
import { multiTokenFromRemote } from '../utils';

/**
 * Generate transaction including all addresses with no change.
 */
export async function buildYoroiTransferTx(payload: {|
  senderUtxos: Array<CardanoAddressedUtxo>,
  outputAddr: {|
    ...Address,
    ...InexactSubset<Addressing>,
  |},
  keyLevel: number,
  signingKey: RustModule.CML.Bip32PrivateKey,
  absSlotNumber: BigNumber,
  protocolParams: {|
    keyDeposit: RustModule.WalletV4.BigNum,
    linearFee: RustModule.WalletV4.LinearFee,
    coinsPerUtxoByte: RustModule.WalletV4.BigNum,
    poolDeposit: RustModule.WalletV4.BigNum,
    networkId: number,
  |},
  networkId: number,
|}): Promise<TransferTx> {
  try {
    const { senderUtxos } = payload;

    const defaultEntryInfo = {
      defaultNetworkId: payload.protocolParams.networkId,
      defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
    };

    const totalBalance = senderUtxos
      .map(utxo => multiTokenFromRemote(utxo, payload.protocolParams.networkId))
      .reduce((acc, next) => acc.joinAddMutable(next), new MultiToken([], defaultEntryInfo));

    // first build a transaction to see what the fee will be
    const unsignedTxResponse = sendAllUnsignedTx(
      payload.outputAddr,
      senderUtxos,
      payload.absSlotNumber,
      payload.protocolParams,
      undefined,
      payload.networkId
    );

    const transactionDetails = RustModule.WasmScope(Module => {
      const body = Module.CML.TransactionBody.from_cbor_bytes(unsignedTxResponse.txBuilder);
      return {
        fee: body.fee().toString(),
        id: Module.CML.hash_transaction(body).to_hex(),
      };
    });
    const fee = new MultiToken(
      [
        {
          identifier: PRIMARY_ASSET_CONSTANTS.Cardano,
          amount: new BigNumber(transactionDetails.fee).plus(unsignedTxResponse.depositAmount ?? '0'),
          networkId: payload.protocolParams.networkId,
        },
      ],
      defaultEntryInfo
    );

    // sign inputs
    const signedTx = signTransaction(
      unsignedTxResponse.senderUtxos,
      unsignedTxResponse.txBuilder,
      payload.keyLevel,
      payload.signingKey,
      null,
      undefined
    );

    // return summary of transaction
    return {
      recoveredBalance: totalBalance,
      fee,
      id: transactionDetails.id,
      encodedTx: signedTx,
      // only display unique addresses
      senders: Array.from(new Set(senderUtxos.map(utxo => utxo.receiver))),
      receivers: [payload.outputAddr.address],
    };
  } catch (error) {
    Logger.error(`transfer::${nameof(buildYoroiTransferTx)} ${stringifyError(error)}`);
    if (error instanceof LocalizableError) {
      throw error;
    }
    throw new GenerateTransferTxError();
  }
}
