// @flow

import type { CardanoAddressedUtxo } from '../types';
import type { TxDataOutput } from '../../../common/types';
import type { Address, Addressing, Value } from '../../lib/storage/models/PublicDeriver/interfaces';
import BigNumber from 'bignumber.js';
import { ISignRequest } from '../../../common/lib/transactions/ISignRequest';
import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { MultiToken } from '../../../common/lib/MultiToken';
import { PRIMARY_ASSET_CONSTANTS } from '../../lib/storage/database/primitives/enums';
import { multiTokenFromCMLValue, multiTokenFromRemote } from '../utils';
import { bytesToHex } from '../../../../coreUtils';

/**
 * We take a copy of these parameters instead of re-evaluating them from the network
 * There are two reasons for this
 * 1) In Cardano, the protocol parameters used for transaction validation
 *    are the ones active the slot the transaction gets inserted it, and not the TTL slot
 *    Since a sign request isn't a slot yet, we need to keep track of which parameters we used
 * 2) Attempting to calculate the value of the network parameter at the time a transaction happens
 *    may require a database access
 *    and it doesn't make sense that this class be aware of the database or take any locks
 */
type NetworkSettingSnapshot = {|
  // there is no way given just a transaction body to 100% know which network it belongs to
  +NetworkId: number,
  +ChainNetworkId: number,
  +PoolDeposit: BigNumber,
  +KeyDeposit: BigNumber,
|};

export type LedgerNanoCatalystRegistrationTxSignData = {|
  votingPublicKey: string,
  stakingKeyPath: Array<number>,
  stakingKey: string,
  paymentAddress: string,
  paymentKeyPath: Array<number>,
  nonce: number,
|};

export type TrezorTCatalystRegistrationTxSignData = LedgerNanoCatalystRegistrationTxSignData;

type UnsignedTx = Uint8Array;
type TxMetadata = Uint8Array;

export class HaskellShelleyTxSignRequest implements ISignRequest<UnsignedTx> {
  receiver: ?{| address: string, handle: {| handle: string, nameServer: string |} | void |};
  senderUtxos: Array<CardanoAddressedUtxo>;
  unsignedTx: UnsignedTx;
  implicitInputValue: void | Uint8Array;
  depositAmount: void | string;
  changeAddr: Array<{| ...Address, ...Value, ...Addressing |}>;
  metadata: void | TxMetadata;
  networkSettingSnapshot: NetworkSettingSnapshot;
  trezorTCatalystRegistrationTxSignData: void | TrezorTCatalystRegistrationTxSignData;
  ledgerNanoCatalystRegistrationTxSignData: void | LedgerNanoCatalystRegistrationTxSignData;

  constructor(data: {|
    senderUtxos: Array<CardanoAddressedUtxo>,
    unsignedTx: UnsignedTx,
    implicitInputValue?: void | Uint8Array,
    depositAmount?: void | string,
    changeAddr: Array<{| ...Address, ...Value, ...Addressing |}>,
    metadata: void | TxMetadata,
    networkSettingSnapshot: NetworkSettingSnapshot,
    trezorTCatalystRegistrationTxSignData?: void | TrezorTCatalystRegistrationTxSignData,
    ledgerNanoCatalystRegistrationTxSignData?: void | LedgerNanoCatalystRegistrationTxSignData,
    receiver?: ?{| address: string, handle: {| handle: string, nameServer: string |} | void |},
  |}) {
    this.senderUtxos = data.senderUtxos;
    this.unsignedTx = data.unsignedTx;
    this.implicitInputValue = data.implicitInputValue;
    this.depositAmount = data.depositAmount;
    this.changeAddr = data.changeAddr;
    this.metadata = data.metadata;
    this.networkSettingSnapshot = data.networkSettingSnapshot;
    this.trezorTCatalystRegistrationTxSignData = data.trezorTCatalystRegistrationTxSignData;
    this.ledgerNanoCatalystRegistrationTxSignData = data.ledgerNanoCatalystRegistrationTxSignData;
    this.receiver = data.receiver;
  }

  txId(): string {
    return RustModule.WasmScope(Module =>
      Module.CML.hash_transaction(Module.CML.TransactionBody.from_cbor_bytes(this.unsignedTx)).to_hex()
    );
  }

  serializedUnsignedTxHex(): string {
    return RustModule.WasmScope(Module => {
      const cml = Module.CML;
      const body = cml.TransactionBody.from_cbor_bytes(this.unsignedTx);
      const witnesses = cml.TransactionWitnessSet.new();
      const metadata = this.metadata == null ? undefined : cml.AuxiliaryData.from_cbor_bytes(this.metadata);
      return cml.Transaction.new(body, witnesses, true, metadata).to_cbor_hex();
    });
  }

  bodyBytes(): Uint8Array {
    return this.unsignedTx;
  }

  size(): {| full: number, outputs: number[] |} {
    return RustModule.WasmScope(Module => {
      const outputs = Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes()).outputs();
      return {
        full: this.serializedUnsignedTxHex().length / 2,
        outputs: Array.from({ length: outputs.len() }, (_, index) => outputs.get(index).to_cbor_bytes().length),
      };
    });
  }

  inputs(): Array<{|
    address: string,
    value: MultiToken,
  |}> {
    return RustModule.WasmScope(Module => {
      const inputs = Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes()).inputs();
      return Array.from({ length: inputs.len() }, (_, index) => {
        const input = inputs.get(index);
        const key = { hash: input.transaction_id().to_hex(), index: Number(input.index()) };
        const utxoEntry = this.senderUtxos.find(utxo => utxo.tx_hash === key.hash && utxo.tx_index === key.index);
        if (utxoEntry == null) {
          throw new Error(`${nameof(this.inputs)} missing ${nameof(this.senderUtxos)} input for ${JSON.stringify(key)}`);
        }
        return {
          value: multiTokenFromRemote(utxoEntry, this.networkSettingSnapshot.NetworkId),
          address: utxoEntry.receiver,
        };
      });
    });
  }

  totalInput(): MultiToken {
    const values = this.senderUtxos.reduce(
      (total, utxo) => total.joinAddMutable(multiTokenFromRemote(utxo, this.networkSettingSnapshot.NetworkId)),
      new MultiToken([], {
        defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
        defaultNetworkId: this.networkSettingSnapshot.NetworkId,
      })
    );
    if (this.implicitInputValue != null) {
      values.joinAddMutable(
        RustModule.WasmScope(Module =>
          multiTokenFromCMLValue(Module.CML.Value.from_cbor_bytes(this.implicitInputValue), {
            defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
            defaultNetworkId: this.networkSettingSnapshot.NetworkId,
          })
        )
      );
    }
    this.changeAddr.forEach(change => values.joinSubtractMutable(change.values));

    return values;
  }

  outputs(): Array<TxDataOutput> {
    return RustModule.WasmScope(Module => {
      const outputs = Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes()).outputs();
      return Array.from({ length: outputs.len() }, (_, index) => {
        const output = outputs.get(index);
        return {
          value: multiTokenFromCMLValue(output.amount(), {
            defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
            defaultNetworkId: this.networkSettingSnapshot.NetworkId,
          }),
          isForeign: false,
          address: output.address().to_hex(),
        };
      });
    });
  }

  totalOutput(): MultiToken {
    return this.outputs().reduce(
      (total, output) => total.joinAddMutable(output.value),
      new MultiToken([], {
        defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
        defaultNetworkId: this.networkSettingSnapshot.NetworkId,
      })
    );
  }

  fee(): MultiToken {
    const values = new MultiToken([], {
      defaultNetworkId: this.networkSettingSnapshot.NetworkId,
      defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
    });
    values.add({
      identifier: PRIMARY_ASSET_CONSTANTS.Cardano,
      amount: new BigNumber(
        RustModule.WasmScope(Module =>
          Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes())
            .fee()
            .toString()
        )
      ).plus(this.depositAmount ?? '0'),
      networkId: this.networkSettingSnapshot.NetworkId,
    });

    return values;
  }

  withdrawals(): Array<{|
    +address: string,
    +amount: MultiToken,
  |}> {
    return RustModule.WasmScope(Module => {
      const withdrawals = Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes()).withdrawals();
      if (withdrawals == null) return [];
      const rewardAccounts = withdrawals.keys();
      return Array.from({ length: rewardAccounts.len() }, (_, index) => {
        const rewardAddress = rewardAccounts.get(index);
        return {
          address: rewardAddress.to_address().to_hex(),
          amount: new MultiToken(
            [
              {
                identifier: PRIMARY_ASSET_CONSTANTS.Cardano,
                amount: new BigNumber(withdrawals.get(rewardAddress).toString()),
                networkId: this.networkSettingSnapshot.NetworkId,
              },
            ],
            {
              defaultNetworkId: this.networkSettingSnapshot.NetworkId,
              defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
            }
          ),
        };
      });
    });
  }

  keyDeregistrations(): Array<{|
    +rewardAddress: string,
    +refund: MultiToken,
  |}> {
    return RustModule.WasmScope(Module => {
      const certs = Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes()).certs();
      if (certs == null) return [];
      const deregistrations = [];
      for (let index = 0; index < certs.len(); index++) {
        const certificate = certs.get(index).as_stake_deregistration();
        if (certificate == null) continue;
        const rewardAddress = Module.CML.RewardAddress.new(
          this.networkSettingSnapshot.ChainNetworkId,
          certificate.stake_credential()
        )
          .to_address()
          .to_hex();
        deregistrations.push({
          rewardAddress,
          refund: new MultiToken(
            [
              {
                identifier: PRIMARY_ASSET_CONSTANTS.Cardano,
                amount: this.networkSettingSnapshot.KeyDeposit,
                networkId: this.networkSettingSnapshot.NetworkId,
              },
            ],
            {
              defaultNetworkId: this.networkSettingSnapshot.NetworkId,
              defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
            }
          ),
        });
      }
      return deregistrations;
    });
  }

  certificates(): Array<{| kind: number, payloadHex: string |}> {
    return RustModule.WasmScope(Module => {
      const certs = Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes()).certs();
      if (certs == null) return [];
      return Array.from({ length: certs.len() }, (_, index) => {
        const cert = certs.get(index);
        return { kind: cert.kind(), payloadHex: cert.to_cbor_hex() };
      });
    });
  }

  receiverWithHandle(): null | {| address: string, handle: void | {| handle: string, nameServer: string |} |} {
    return this.receiver ?? null;
  }

  receivers(includeChange: boolean): Array<string> {
    const outputStrings = RustModule.WasmScope(Module => {
      const outputs = Module.CML.TransactionBody.from_cbor_bytes(this.bodyBytes()).outputs();
      return Array.from({ length: outputs.len() }, (_, index) => {
        const address = outputs.get(index).address();
        return Module.CML.ByronAddress.from_address(address)?.to_base58() ?? address.to_hex();
      });
    });

    if (!includeChange) {
      const changeAddrs = this.changeAddr.map(change => change.address);
      return outputStrings.filter(addr => !changeAddrs.includes(addr));
    }
    return outputStrings;
  }

  uniqueSenderAddresses(): Array<string> {
    return Array.from(new Set(this.senderUtxos.map(utxo => utxo.receiver)));
  }

  isEqual(tx: ?mixed): boolean {
    if (tx == null) return false;
    return tx instanceof Uint8Array && bytesToHex(this.unsignedTx) === bytesToHex(tx);
  }

  self(): Uint8Array {
    return this.unsignedTx;
  }

  setMetadata(metadata: TxMetadata): void {
    this.metadata = metadata;
  }
}
