// @flow
import '../lib/test-config.forTests';
import BigNumber from 'bignumber.js';
import {
  convertAdaTransactionsToExportRows,
  sumInputsOutputs,
  getFromUserPerspective,
  cardanoUtxoHexFromRemoteFormat,
  cardanoMinAdaRequiredFromAssets,
  cardanoValueFromMultiToken,
  multiTokenFromCMLValue,
  parseCMLTransactionOutput,
} from './utils';
import { RustModule } from '../lib/cardanoCrypto/rustLoader';
import { formatBigNumberToFloatString } from '../../../utils/formatters';
import type { TransactionExportRow } from '../../export';
import type { UtxoTransactionInputRow, UtxoTransactionOutputRow } from '../lib/storage/database/transactionModels/utxo/tables';
import { TxStatusCodes } from '../lib/storage/database/primitives/enums';
import { transactionTypes } from './types';
import { TransactionType } from '../lib/storage/database/primitives/tables';
import type { CardanoByronTxIO } from '../lib/storage/database/transactionModels/multipart/tables';
import type { DbBlock, DbTokenInfo, TokenListRow } from '../lib/storage/database/primitives/tables';
import type { UserAnnotation } from './types';
import { defaultAssets, networks } from '../lib/storage/database/prepackaged/networks';
import { MultiToken } from '../../common/lib/MultiToken';

beforeAll(async () => {
  await RustModule.load();
});

test('serializes remote swap UTxOs with CML byte-for-byte like CSL', () => {
  const utxo = {
    tx_hash: '33'.repeat(32),
    tx_index: 7,
    receiver: RustModule.WasmScope(Module =>
      Module.CML.Address.from_bech32(
        'addr_test1qzz6hulv54gzf2suy2u5gkvmt6ysasfdlvvegy3fmf969y7r3y3kdut55a40jff00qmg74686vz44v6k363md06qkq0qy0adz0'
      ).to_hex()
    ),
    amount: '2000000',
    assets: [{ policyId: '44'.repeat(28), name: 'aabb', amount: '3' }],
  };
  const expected = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const assets = CSL.Assets.new();
    assets.insert(CSL.AssetName.new(Buffer.from('aabb', 'hex')), CSL.BigNum.from_str('3'));
    const multiAsset = CSL.MultiAsset.new();
    multiAsset.insert(CSL.ScriptHash.from_hex(utxo.assets[0].policyId), assets);
    const value = CSL.Value.new(CSL.BigNum.from_str(utxo.amount));
    value.set_multiasset(multiAsset);
    const input = CSL.TransactionInput.new(CSL.TransactionHash.from_hex(utxo.tx_hash), utxo.tx_index);
    const output = CSL.TransactionOutput.new(CSL.Address.from_hex(utxo.receiver), value);
    return CSL.TransactionUnspentOutput.new(input, output).to_hex();
  });
  expect(cardanoUtxoHexFromRemoteFormat(utxo)).toEqual(expected);
});

test('calculates min-ADA for token outputs with CML parity', () => {
  const tokens = MultiToken.from({
    defaults: { defaultIdentifier: '.', defaultNetworkId: networks.CardanoMainnet.NetworkId },
    values: [
      { identifier: '.', networkId: networks.CardanoMainnet.NetworkId, amount: '2000000' },
      { identifier: `${'44'.repeat(28)}.aabb`, networkId: networks.CardanoMainnet.NetworkId, amount: '3' },
    ],
  });
  const coinsPerByte = new BigNumber('4310');
  const cmlMinimum = RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const output = CML.TransactionOutput.new(
      CML.Address.from_bech32(
        'addr_test1qzz6hulv54gzf2suy2u5gkvmt6ysasfdlvvegy3fmf969y7r3y3kdut55a40jff00qmg74686vz44v6k363md06qkq0qy0adz0'
      ),
      cardanoValueFromMultiToken(tokens, Module)
    );
    // eslint-disable-next-line no-undef
    return CML.min_ada_required(output, BigInt(coinsPerByte.toString())).toString();
  });
  expect(cardanoMinAdaRequiredFromAssets(tokens, coinsPerByte).toString()).toEqual(cmlMinimum);
});

test('parses CML transaction output values into wallet token entries', () => {
  const defaults = { defaultIdentifier: '.', defaultNetworkId: networks.CardanoMainnet.NetworkId };
  const outputBytes = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const assets = CSL.Assets.new();
    assets.insert(CSL.AssetName.new(Buffer.from('aabb', 'hex')), CSL.BigNum.from_str('3'));
    const multiAsset = CSL.MultiAsset.new();
    multiAsset.insert(CSL.ScriptHash.from_hex('44'.repeat(28)), assets);
    const value = CSL.Value.new(CSL.BigNum.from_str('2000000'));
    value.set_multiasset(multiAsset);
    const output = CSL.TransactionOutput.new(
      CSL.Address.from_bech32(
        'addr_test1qzz6hulv54gzf2suy2u5gkvmt6ysasfdlvvegy3fmf969y7r3y3kdut55a40jff00qmg74686vz44v6k363md06qkq0qy0adz0'
      ),
      value
    );
    return output.to_bytes();
  });
  const actual = RustModule.WasmScope(Module => {
    const output = Module.CML.TransactionOutput.from_cbor_bytes(outputBytes);
    return multiTokenFromCMLValue(output.amount(), defaults).entries().map(entry => ({
      identifier: entry.identifier,
      networkId: entry.networkId,
      amount: entry.amount.toString(),
    }));
  });
  expect(actual).toEqual([
    { identifier: '.', networkId: defaults.defaultNetworkId, amount: '2000000' },
    { identifier: `${'44'.repeat(28)}.aabb`, networkId: defaults.defaultNetworkId, amount: '3' },
  ]);
});

test('parses Byron outputs, datum hashes, and unknown assets for connector display', () => {
  const defaults = { defaultIdentifier: '.', defaultNetworkId: networks.CardanoMainnet.NetworkId };
  const fixture = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const address = CSL.Address.from_bytes(
      CSL.ByronAddress.from_base58('Ae2tdPwUPEZKX8N2TjzBXLy5qrecnQUniTd2yxE8mWyrh2djNpUkbAtXtP4').to_bytes()
    );
    const assets = CSL.Assets.new();
    assets.insert(CSL.AssetName.new(Buffer.from('aabb', 'hex')), CSL.BigNum.from_str('5'));
    const multiAsset = CSL.MultiAsset.new();
    multiAsset.insert(CSL.ScriptHash.from_hex('55'.repeat(28)), assets);
    const value = CSL.Value.new(CSL.BigNum.from_str('3000000'));
    value.set_multiasset(multiAsset);
    const output = CSL.TransactionOutput.new(address, value);
    output.set_data_hash(CSL.DataHash.from_hex('66'.repeat(32)));
    return { hex: output.to_hex(), address: address.to_hex(), dataHash: '66'.repeat(32) };
  });
  const parsed = parseCMLTransactionOutput(fixture.hex, defaults);
  expect(parsed.address).toEqual(fixture.address);
  expect(parsed.dataHash).toEqual(fixture.dataHash);
  expect(parsed.amount.entries().map(entry => [entry.identifier, entry.amount.toString()])).toEqual([
    ['.', '3000000'],
    [`${'55'.repeat(28)}.aabb`, '5'],
  ]);
});

const cardanoToken = {
  TokenId: 0,
  Digest: 0,
  ...defaultAssets.filter(token => token.NetworkId === networks.CardanoMainnet.NetworkId)[0],
};
const tokenTypes = [
  {
    TokenId: 0,
    Identifier: cardanoToken.Identifier,
    NetworkId: cardanoToken.NetworkId,
  },
];
const defaultToken = {
  defaultNetworkId: tokenTypes[0].NetworkId,
  defaultIdentifier: tokenTypes[0].Identifier,
};

const _tokenList = (amount: number, listId: number, tokenId: number): TokenListRow => ({
  TokenListItemId: 0,
  ListId: listId,
  TokenId: tokenId,
  Amount: amount.toString(),
});

const _input = (listId: number, id: number): UtxoTransactionInputRow => ({
  UtxoTransactionInputId: 0,
  TransactionId: 0,
  AddressId: id,
  ParentTxHash: '',
  IndexInParentTx: 0,
  IndexInOwnTx: 0,
  TokenListId: listId,
});
const _output = (listId: number, id: number): UtxoTransactionOutputRow => ({
  UtxoTransactionOutputId: 0,
  TransactionId: 0,
  AddressId: id,
  OutputIndex: 0,
  TokenListId: listId,
  IsUnspent: true,
  ErgoBoxId: null,
  ErgoCreationHeight: null,
  ErgoTree: null,
  ErgoRegisters: null,
});

function tokenEntry(row: TokenListRow): ReadonlyElementOf<$PropertyType<DbTokenInfo, 'tokens'>> {
  return {
    TokenList: row,
    Token: tokenTypes.filter(token => token.TokenId === row.TokenId)[0],
  };
}

const lists = [
  _tokenList(2000000, 0, tokenTypes[0].TokenId),
  _tokenList(5000000, 1, tokenTypes[0].TokenId),
  _tokenList(1000000, 2, tokenTypes[0].TokenId),
  _tokenList(2000000, 3, tokenTypes[0].TokenId),

  _tokenList(1000000, 4, tokenTypes[0].TokenId),
  _tokenList(865567, 5, tokenTypes[0].TokenId),
  _tokenList(2000000, 6, tokenTypes[0].TokenId),
  _tokenList(2824676, 7, tokenTypes[0].TokenId),
  _tokenList(2100000, 8, tokenTypes[0].TokenId),
  _tokenList(712345, 9, tokenTypes[0].TokenId),
];
const testInputs = [
  _input(lists[0].ListId, 0),
  _input(lists[1].ListId, 1),
  _input(lists[2].ListId, 2),
  _input(lists[3].ListId, 3),
];

const testOutputs = [
  _output(lists[4].ListId, 4),
  _output(lists[5].ListId, 5),
  _output(lists[6].ListId, 6),
  _output(lists[7].ListId, 7),
  _output(lists[8].ListId, 8),
  _output(lists[9].ListId, 9),
];

test('convertAdaTransactionsToExportRows - empty', () => {
  const res: Array<TransactionExportRow> = convertAdaTransactionsToExportRows([], cardanoToken);
  _expectEqual(res, []);
});

test('convertAdaTransactionsToExportRows', () => {
  const res: Array<TransactionExportRow> = convertAdaTransactionsToExportRows(
    [
      _tx(
        [testInputs[0]],
        [testOutputs[0], testOutputs[1]],
        lists.map(list => tokenEntry(list)),
        new Set([4]),
        '2010-01-01 22:12:22'
      ),
      _tx(
        [testInputs[1]],
        [testOutputs[2], testOutputs[3]],
        lists.map(list => tokenEntry(list)),
        new Set([6]),
        '2012-05-12 11:22:33'
      ),
      _tx(
        [testInputs[2], testInputs[3]],
        [testOutputs[4], testOutputs[5]],
        lists.map(list => tokenEntry(list)),
        new Set([2, 3, 9]),
        '2015-12-13 10:20:30'
      ),
    ],
    cardanoToken
  );
  _expectEqual(res, [
    _expRow('1.0', '0.0', 'in', '2010-01-01 22:12:22', 'a'),
    _expRow('2.0', '0.0', 'in', '2012-05-12 11:22:33', 'a'),
    _expRow('2.1', `0.${900000 - 712345}`, 'out', '2015-12-13 10:20:30', 'a'),
  ]);
});

test('self tx', () => {
  const selfTx = _tx(
    [testInputs[0]],
    [testOutputs[0]],
    lists.map(list => tokenEntry(list)),
    new Set([0, 4]),
    '2015-12-13 10:20:30'
  );
  expect(selfTx.type).toEqual(transactionTypes.SELF);
  expect(selfTx.amount.getDefault()).toEqual(new BigNumber(0));
  expect(selfTx.fee.getDefault()).toEqual(new BigNumber(-1000000));
});

test('multi tx', () => {
  const selfTx = _tx(
    [testInputs[0], testInputs[1]],
    [testOutputs[0], testOutputs[1]],
    lists.map(list => tokenEntry(list)),
    new Set([0, 4]),
    '2015-12-13 10:20:30'
  );
  expect(selfTx.type).toEqual(transactionTypes.MULTI);
});

test('sumInputsOutputs - empty', () => {
  _expectEqual(sumInputsOutputs([], [], defaultToken).getDefault(), new BigNumber(0));
});

test('sumInputsOutputs', () => {
  _expectEqual(
    sumInputsOutputs(
      [_input(lists[0].ListId, 0), _output(lists[4].ListId, 0), _input(lists[2].ListId, 0)],
      lists.map(list => tokenEntry(list)),
      defaultToken
    ).getDefault(),
    new BigNumber(4000000)
  );
});

test('formatBigNumberToFloatString', () => {
  const f = formatBigNumberToFloatString;
  const big = x => new BigNumber(x);
  _expectEqual(f(big(0)), '0.0');
  _expectEqual(f(big(42)), '42.0');
  _expectEqual(f(big(42).dividedBy(10)), '4.2');
});

const _tx = (
  utxoInputs: Array<UtxoTransactionInputRow>,
  utxoOutputs: Array<UtxoTransactionOutputRow>,
  tokens: $PropertyType<DbTokenInfo, 'tokens'>,
  ownedAddresses: Set<number>,
  date: string
): {|
  ...CardanoByronTxIO,
  ...WithNullableFields<DbBlock>,
  ...UserAnnotation,
|} => {
  const annotation = getFromUserPerspective({
    utxoInputs,
    utxoOutputs,
    allOwnedAddressIds: ownedAddresses,
    tokens,
    defaultToken,
  });

  return {
    txType: TransactionType.CardanoByron,
    transaction: {
      Type: TransactionType.CardanoByron,
      TransactionId: 0,
      Digest: 0,
      Hash: 'a',
      Ordinal: 0,
      BlockId: 0,
      LastUpdateTime: 0,
      Status: TxStatusCodes.IN_BLOCK,
      ErrorMessage: null,
      Extra: null,
    },
    block: {
      BlockId: 0,
      Digest: 0,
      SlotNum: 0,
      Height: 0,
      Hash: '1',
      BlockTime: new Date(date),
    },
    utxoInputs,
    utxoOutputs,
    ...annotation,
    tokens,
  };
};

const _expRow = (amount: string, fee: string, type: 'in' | 'out', date: string, id: string): TransactionExportRow => ({
  type,
  amount,
  fee,
  date: new Date(date),
  id,
});

function _expectEqual(a: any, b: any): void {
  expect(a).toEqual(b);
}
