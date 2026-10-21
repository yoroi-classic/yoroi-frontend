// @flow

import type { Address, Value, Addressing } from '../lib/storage/models/PublicDeriver/interfaces';
import { MultiToken } from '../../common/lib/MultiToken';

import type { RemoteUnspentOutput } from '../lib/state-fetch/types';

export const transactionTypes = Object.freeze({
  EXPEND: 'expend',
  INCOME: 'income',
  EXCHANGE: 'exchange',
  SELF: 'self',
  MULTI: 'multi',
});
export type TransactionDirectionType = $Values<typeof transactionTypes>;

export type UserAnnotation = {|
  +type: TransactionDirectionType,
  +amount: MultiToken,
  +fee: MultiToken,
|};

export type CardanoUtxoScriptWitness =
  | {|
      nativeScript: string,
    |}
  | {|
      plutusScript: string,
      datum: string,
      redeemer: string,
    |};

export type CardanoAddressedUtxo = {|
  ...RemoteUnspentOutput,
  ...Addressing,
|};

export type V4UnsignedTxUtxoResponse = {|
  senderUtxos: Array<RemoteUnspentOutput>,
  txBuilder: Uint8Array,
  changeAddr: Array<{| ...Address, ...Value, ...Addressing |}>,
  implicitInputValue?: Uint8Array,
  depositAmount?: string,
|};
export type V4UnsignedTxAddressedUtxoResponse = {|
  senderUtxos: Array<CardanoAddressedUtxo>,
  txBuilder: Uint8Array,
  changeAddr: Array<{| ...Address, ...Value, ...Addressing |}>,
  implicitInputValue?: Uint8Array,
  depositAmount?: string,
  certificates: $ReadOnlyArray<string>,
|};
