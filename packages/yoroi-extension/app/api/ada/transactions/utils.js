// @flow
import { groupBy, keyBy, mapValues } from 'lodash';
import BigNumber from 'bignumber.js';
import type { CardanoAddressedUtxo, UserAnnotation } from './types';
import { transactionTypes } from './types';
import type { RemoteUnspentOutput } from '../lib/state-fetch/types';
import type { UtxoTransactionInputRow, UtxoTransactionOutputRow } from '../lib/storage/database/transactionModels/utxo/tables';
import type { DbBlock, DbTokenInfo, DbTransaction, TokenRow } from '../lib/storage/database/primitives/tables';
import type {
  AccountingTransactionInputRow,
  AccountingTransactionOutputRow,
} from '../lib/storage/database/transactionModels/account/tables';
import type { TransactionExportRow } from '../../export';
import type { IGetAllUtxosResponse } from '../lib/storage/models/PublicDeriver/interfaces';
import { formatBigNumberToFloatString } from '../../../utils/formatters';
import type { DefaultTokenEntry } from '../../common/lib/MultiToken';
import { MultiToken } from '../../common/lib/MultiToken';
import { RustModule } from '../lib/cardanoCrypto/rustLoader';
import { PRIMARY_ASSET_CONSTANTS } from '../lib/storage/database/primitives/enums';
import { bytesToHex } from '../../../coreUtils';

const RANDOM_BASE_ADDRESS =
  'addr_test1qzz6hulv54gzf2suy2u5gkvmt6ysasfdlvvegy3fmf969y7r3y3kdut55a40jff00qmg74686vz44v6k363md06qkq0qy0adz0';

export function cardanoAssetToIdentifier(policyId: RustModule.CML.ScriptHash, name: RustModule.CML.AssetName): string {
  // note: possible for name to be empty causing a trailing hyphen
  return `${policyId.to_hex()}.${bytesToHex(name.to_raw_bytes())}`;
}
export function identifierToCardanoAsset(identifier: string): {| policyId: string, name: string |} {
  // recall: 'a.'.split() gives ['a', ''] as desired
  const parts = identifier.split('.');
  return {
    policyId: parts[0],
    name: parts[1],
  };
}
export function identifierSplit(identifier: string): {| policyId: string, name: string |} {
  // recall: 'a.'.split() gives ['a', ''] as desired
  const parts = identifier.split('.');
  return {
    policyId: parts[0],
    name: parts[1],
  };
}

export function parseTokenList(assets: void | RustModule.CML.MultiAsset): Array<{|
  assetId: string,
  policyId: string,
  name: string,
  amount: string,
|}> {
  if (assets == null) return [];
  const result = [];
  const policies = assets.keys();
  for (let policyIndex = 0; policyIndex < policies.len(); policyIndex++) {
    const policyId = policies.get(policyIndex);
    if (policyId == null) continue;
    const assetsForPolicy = assets.get_assets(policyId);
    if (assetsForPolicy == null) continue;
    const names = assetsForPolicy.keys();
    for (let nameIndex = 0; nameIndex < names.len(); nameIndex++) {
      const assetName = names.get(nameIndex);
      if (assetName == null) continue;
      const amount = assetsForPolicy.get(assetName);
      if (amount == null) continue;
      result.push({
        amount: amount.toString(),
        assetId: cardanoAssetToIdentifier(policyId, assetName),
        policyId: policyId.to_hex(),
        name: bytesToHex(assetName.to_raw_bytes()),
      });
    }
  }
  return result;
}

export function cardanoValueFromMultiToken(tokens: MultiToken, Module: typeof RustModule = RustModule): RustModule.CML.Value {
  const CML = Module.CML;
  const assets = CML.MultiAsset.new();
  for (const entry of tokens.nonDefaultEntries()) {
    const { policyId, name } = identifierToCardanoAsset(entry.identifier);
    // eslint-disable-next-line no-undef
    assets.set(CML.ScriptHash.from_hex(policyId), CML.AssetName.from_hex(name), BigInt(entry.amount.toString()));
  }
  // eslint-disable-next-line no-undef
  const coin = BigInt(tokens.getDefaultEntry().amount.toString());
  return assets.policy_count() > 0 ? CML.Value.new(coin, assets) : CML.Value.from_coin(coin);
}
export function multiTokenFromCardanoValue(value: RustModule.CML.Value, defaults: DefaultTokenEntry): MultiToken {
  const multiToken = new MultiToken([], defaults);
  multiToken.add({
    amount: new BigNumber(value.coin().toString()),
    identifier: defaults.defaultIdentifier,
    networkId: defaults.defaultNetworkId,
  });

  for (const token of parseTokenList(value.multi_asset())) {
    multiToken.add({
      amount: new BigNumber(token.amount),
      identifier: token.assetId,
      networkId: defaults.defaultNetworkId,
    });
  }
  return multiToken;
}

export function multiTokenFromCMLValue(value: RustModule.CML.Value, defaults: DefaultTokenEntry): MultiToken {
  const multiToken = new MultiToken([], defaults);
  multiToken.add({
    amount: new BigNumber(value.coin().toString()),
    identifier: defaults.defaultIdentifier,
    networkId: defaults.defaultNetworkId,
  });
  const multiAsset = value.multi_asset();
  if (multiAsset == null) return multiToken;
  const policies = multiAsset.keys();
  for (let policyIndex = 0; policyIndex < policies.len(); policyIndex++) {
    const policy = policies.get(policyIndex);
    const assets = multiAsset.get_assets(policy);
    if (assets == null) continue;
    const names = assets.keys();
    for (let nameIndex = 0; nameIndex < names.len(); nameIndex++) {
      const name = names.get(nameIndex);
      const amount = assets.get(name);
      if (amount == null) continue;
      multiToken.add({
        amount: new BigNumber(amount.toString()),
        identifier: `${policy.to_hex()}.${name.to_hex()}`,
        networkId: defaults.defaultNetworkId,
      });
    }
  }
  return multiToken;
}

export function parseCMLTransactionOutput(
  outputCborHex: string,
  defaults: DefaultTokenEntry
): {|
  address: string,
  amount: MultiToken,
  dataHash?: string,
  data: void,
|} {
  return RustModule.WasmScope(Module => {
    const output = Module.CML.TransactionOutput.from_cbor_hex(outputCborHex);
    const parsed: {| address: string, amount: MultiToken, dataHash?: string, data: void |} = {
      address: output.address().to_hex(),
      amount: multiTokenFromCMLValue(output.amount(), defaults),
      data: undefined,
    };
    const dataHash = output.datum_hash();
    if (dataHash != null) parsed.dataHash = dataHash.to_hex();
    return parsed;
  });
}
export function cardanoValueFromRemoteFormat(utxo: RemoteUnspentOutput): RustModule.CML.Value {
  const CML = RustModule.CML;
  const assets = CML.MultiAsset.new();
  for (const entry of utxo.assets) {
    const { policyId, name } = identifierToCardanoAsset(entry.assetId);
    // eslint-disable-next-line no-undef
    assets.set(CML.ScriptHash.from_hex(policyId), CML.AssetName.from_hex(name), BigInt(entry.amount.toString()));
  }
  // eslint-disable-next-line no-undef
  const coin = BigInt(utxo.amount);
  return assets.policy_count() > 0 ? CML.Value.new(coin, assets) : CML.Value.from_coin(coin);
}
export function createMultiToken(
  amount: number | string | BigNumber,
  assets: Array<{
    assetId: string,
    amount: number | string | BigNumber,
    ...
  }>,
  networkId: number
): MultiToken {
  const result = new MultiToken([], {
    defaultNetworkId: networkId,
    defaultIdentifier: PRIMARY_ASSET_CONSTANTS.Cardano,
  });
  result.add({
    identifier: PRIMARY_ASSET_CONSTANTS.Cardano,
    amount: new BigNumber(amount),
    networkId,
  });
  for (const token of assets) {
    result.add({
      identifier: token.assetId,
      amount: new BigNumber(token.amount),
      networkId,
    });
  }
  return result;
}
export function multiTokenFromRemote(
  utxo: $ReadOnly<{
    +amount: string,
    +assets: $ReadOnlyArray<
      $ReadOnly<{
        +assetId: string,
        +policyId: string,
        +name: string,
        +amount: string,
        ...
      }>,
    >,
    ...
  }>,
  networkId: number
): MultiToken {
  // $FlowFixMe[incompatible-call]
  return createMultiToken(utxo.amount, utxo.assets, networkId);
}

export function getFromUserPerspective(data: {|
  utxoInputs: $ReadOnlyArray<$ReadOnly<UtxoTransactionInputRow>>,
  utxoOutputs: $ReadOnlyArray<$ReadOnly<UtxoTransactionOutputRow>>,
  accountingInputs?: $ReadOnlyArray<$ReadOnly<AccountingTransactionInputRow>>,
  accountingOutputs?: $ReadOnlyArray<$ReadOnly<AccountingTransactionOutputRow>>,
  ownImplicitInput?: MultiToken,
  ownImplicitOutput?: MultiToken,
  allOwnedAddressIds: Set<number>,
  defaultToken: DefaultTokenEntry,
  ...DbTokenInfo,
|}): UserAnnotation {
  const unifiedInputs = [...data.utxoInputs, ...(data.accountingInputs ?? [])];
  const unifiedOutputs = [...data.utxoOutputs, ...(data.accountingOutputs ?? [])];
  const ownInputs = unifiedInputs.filter(input => data.allOwnedAddressIds.has(input.AddressId));

  const ownOutputs = unifiedOutputs.filter(output => data.allOwnedAddressIds.has(output.AddressId));

  const totalIn = sumInputsOutputs(unifiedInputs, data.tokens, data.defaultToken);
  const totalOut = sumInputsOutputs(unifiedOutputs, data.tokens, data.defaultToken);
  const ownIn = sumInputsOutputs(ownInputs, data.tokens, data.defaultToken).joinAddCopy(
    data.ownImplicitInput ?? new MultiToken([], data.defaultToken)
  );
  const ownOut = sumInputsOutputs(ownOutputs, data.tokens, data.defaultToken).joinAddCopy(
    data.ownImplicitOutput ?? new MultiToken([], data.defaultToken)
  );

  const hasOnlyOwnInputs = ownInputs.length === unifiedInputs.length;
  const hasOnlyOwnOutputs = ownOutputs.length === unifiedOutputs.length;

  const isIntraWallet = hasOnlyOwnInputs && hasOnlyOwnOutputs;
  const isMultiParty = ownInputs.length > 0 && ownInputs.length !== unifiedInputs.length;

  const brutto = ownOut.joinSubtractCopy(ownIn);
  const totalFee = totalOut.joinSubtractCopy(totalIn); // should be negative

  if (isIntraWallet) {
    return {
      type: transactionTypes.SELF,
      amount: new MultiToken([], data.defaultToken),
      fee: totalFee,
    };
  }
  if (isMultiParty) {
    return {
      type: transactionTypes.MULTI,
      amount: brutto,
      // note: fees not accurate but no logical way of finding which UTXO paid the fees
      fee: new MultiToken([], data.defaultToken),
    };
  }
  if (hasOnlyOwnInputs) {
    return {
      type: transactionTypes.EXPEND,
      amount: brutto.joinSubtractCopy(totalFee),
      fee: totalFee,
    };
  }

  return {
    type: transactionTypes.INCOME,
    amount: brutto,
    fee: new MultiToken([], data.defaultToken),
  };
}

export function convertAdaTransactionsToExportRows(
  transactions: $ReadOnlyArray<
    $ReadOnly<{
      ...DbTransaction,
      ...WithNullableFields<DbBlock>,
      ...UserAnnotation,
      ...
    }>,
  >,
  defaultAssetRow: $ReadOnly<TokenRow>
): Array<TransactionExportRow> {
  const result = [];
  for (const tx of transactions) {
    if (tx.block != null) {
      result.push({
        date: tx.block.BlockTime,
        type: tx.type === transactionTypes.INCOME ? 'in' : 'out',
        amount: formatBigNumberToFloatString(
          tx.amount.get(defaultAssetRow.Identifier)?.abs().shiftedBy(-defaultAssetRow.Metadata.numberOfDecimals) ??
            new BigNumber(0)
        ),
        fee: formatBigNumberToFloatString(
          tx.fee.get(defaultAssetRow.Identifier)?.abs().shiftedBy(-defaultAssetRow.Metadata.numberOfDecimals) ?? new BigNumber(0)
        ),
        id: tx.transaction.Hash,
      });
    }
  }
  return result;
}

export function sumInputsOutputs(
  ios: $ReadOnlyArray<
    $ReadOnly<
      UtxoTransactionInputRow | UtxoTransactionOutputRow | AccountingTransactionInputRow | AccountingTransactionOutputRow,
    >,
  >,
  tokens: $PropertyType<DbTokenInfo, 'tokens'>,
  defaultToken: DefaultTokenEntry
): MultiToken {
  const usedTokens = ios.reduce((acc, next) => {
    for (const entry of tokens.filter(token => token.TokenList.ListId === next.TokenListId)) {
      acc.push(entry);
    }
    return acc;
  }, []);
  return new MultiToken(
    usedTokens.map(token => ({
      identifier: token.Token.Identifier,
      amount: new BigNumber(token.TokenList.Amount),
      networkId: token.Token.NetworkId,
    })),
    defaultToken
  );
}

export type UtxoLookupMap = { [string]: { [number]: RemoteUnspentOutput, ... }, ... };
export function utxosToLookupMap(utxos: Array<RemoteUnspentOutput>): UtxoLookupMap {
  // first create 1-level map of (tx_hash -> [UTXO])
  const txHashMap = groupBy(utxos, utxo => utxo.tx_hash);

  // now create 2-level map of (tx_hash -> index -> UTXO)
  const lookupMap = mapValues(txHashMap, utxoList => keyBy(utxoList, utxo => utxo.tx_index));
  return lookupMap;
}

export function asAddressedUtxo(utxos: IGetAllUtxosResponse): Array<CardanoAddressedUtxo> {
  return utxos.map(utxo => {
    const tokenTypes = utxo.output.tokens.reduce(
      (acc, next) => {
        if (next.Token.Identifier === PRIMARY_ASSET_CONSTANTS.Cardano) {
          acc.amount = acc.amount.plus(next.TokenList.Amount);
        } else {
          acc.tokens.push({
            amount: next.TokenList.Amount,
            tokenId: next.Token.Identifier,
          });
        }
        return acc;
      },
      {
        amount: new BigNumber(0),
        tokens: [],
      }
    );

    const assets = tokenTypes.tokens.map(token => {
      const pieces = identifierToCardanoAsset(token.tokenId);
      return {
        amount: token.amount,
        assetId: token.tokenId,
        policyId: pieces.policyId,
        name: pieces.name,
      };
    });
    return {
      amount: tokenTypes.amount.toString(),
      receiver: utxo.address,
      tx_hash: utxo.output.Transaction.Hash,
      tx_index: utxo.output.UtxoTransactionOutput.OutputIndex,
      utxo_id: utxo.output.Transaction.Hash + utxo.output.UtxoTransactionOutput.OutputIndex,
      addressing: utxo.addressing,
      assets,
    };
  });
}

export function cardanoUtxoHexFromRemoteFormat(u: RemoteUnspentOutput | CardanoAddressedUtxo): string {
  return RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const multiAsset = CML.MultiAsset.new();
    for (const asset of u.assets ?? []) {
      // eslint-disable-next-line no-undef
      multiAsset.set(CML.ScriptHash.from_hex(asset.policyId), CML.AssetName.from_hex(asset.name), BigInt(asset.amount));
    }
    const value =
      multiAsset.policy_count() > 0
        ? // eslint-disable-next-line no-undef
          CML.Value.new(BigInt(u.amount), multiAsset)
        : // eslint-disable-next-line no-undef
          CML.Value.from_coin(BigInt(u.amount));
    // eslint-disable-next-line no-undef
    const input = CML.TransactionInput.new(CML.TransactionHash.from_hex(u.tx_hash), BigInt(u.tx_index));
    const output = CML.TransactionOutput.new(CML.Address.from_hex(u.receiver), value);
    return CML.TransactionUnspentOutput.new(input, output).to_cbor_hex();
  });
}

export function cardanoMinAdaRequiredFromAssets(tokens: MultiToken, coinsPerByte: BigNumber): BigNumber {
  return RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const multiAsset = CML.MultiAsset.new();
    for (const token of tokens.nonDefaultEntries()) {
      const { policyId, name } = identifierSplit(token.identifier);
      // eslint-disable-next-line no-undef
      multiAsset.set(CML.ScriptHash.from_hex(policyId), CML.AssetName.from_hex(name), BigInt(token.amount.toString()));
    }
    // eslint-disable-next-line no-undef
    const coin = BigInt(tokens.getDefaultEntry().amount.toString());
    const value = multiAsset.policy_count() > 0 ? CML.Value.new(coin, multiAsset) : CML.Value.from_coin(coin);
    const output = CML.TransactionOutput.new(CML.Address.from_bech32(RANDOM_BASE_ADDRESS), value);
    // eslint-disable-next-line no-undef
    return new BigNumber(CML.min_ada_required(output, BigInt(coinsPerByte.toString())).toString());
  });
}

export function cardanoMinAdaRequiredFromRemoteFormat(
  utxo: RemoteUnspentOutput | CardanoAddressedUtxo,
  coinsPerByte: BigNumber,
  addressHex: string,
  datumHash?: string
): BigNumber {
  return RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const datumOption = datumHash == null ? undefined : CML.DatumOption.new_hash(CML.DatumHash.from_hex(datumHash));
    const output = CML.TransactionOutput.new(CML.Address.from_hex(addressHex), cardanoValueFromRemoteFormat(utxo), datumOption);
    // eslint-disable-next-line no-undef
    return new BigNumber(CML.min_ada_required(output, BigInt(coinsPerByte.toString())).toString());
  });
}

/**
 * Shallow-parses the passed transaction CBOR HEX and returns the BigNumber of the fee lovelaces
 */
export function getTransactionFeeFromCbor(txHex: string): BigNumber {
  try {
    return RustModule.WasmScope(Module => {
      const feeStr = Module.CML.Transaction.from_cbor_hex(txHex).body().fee().toString();
      return new BigNumber(feeStr);
    });
  } catch (e) {
    console.error('Failed to decode transaction fee from cbor', e);
    throw e;
  }
}

/**
 * Shallow-parses the passed transaction CBOR HEX, adds together all outputs, and returns as multi-token
 */
export function getTransactionTotalOutputFromCbor(txHex: string, defaults: DefaultTokenEntry): MultiToken {
  try {
    return RustModule.WasmScope(Module => {
      const outputs = Module.CML.Transaction.from_cbor_hex(txHex).body().outputs();
      const sum = new MultiToken([], defaults);
      for (let index = 0; index < outputs.len(); index++) {
        const value = outputs.get(index).amount();
        const outputTokens = new MultiToken([], defaults);
        outputTokens.add({
          amount: new BigNumber(value.coin().toString()),
          identifier: defaults.defaultIdentifier,
          networkId: defaults.defaultNetworkId,
        });
        const multiAsset = value.multi_asset();
        if (multiAsset != null) {
          const policies = multiAsset.keys();
          for (let policyIndex = 0; policyIndex < policies.len(); policyIndex++) {
            const policy = policies.get(policyIndex);
            const assets = multiAsset.get_assets(policy);
            if (assets == null) continue;
            const names = assets.keys();
            for (let assetIndex = 0; assetIndex < names.len(); assetIndex++) {
              const name = names.get(assetIndex);
              const amount = assets.get(name);
              if (amount == null) continue;
              outputTokens.add({
                amount: new BigNumber(amount.toString()),
                identifier: `${policy.to_hex()}.${name.to_hex()}`,
                networkId: defaults.defaultNetworkId,
              });
            }
          }
        }
        sum.joinAddMutable(outputTokens);
      }
      return sum;
    });
  } catch (e) {
    console.error('Failed to decode transaction total output from cbor', e);
    throw e;
  }
}
