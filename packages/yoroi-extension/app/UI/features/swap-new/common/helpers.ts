import BigNumber from 'bignumber.js';
import { RustModule } from '../../../../api/ada/lib/cardanoCrypto/rustLoader';
import { PRICE_IMPACT_HIGH_RISK, PRICE_IMPACT_MODERATE_RISK } from './constants';
export const normalizeTokenId = (id?: string | null) => (id === '' ? '.' : id);

type WalletUtxo = {
  address: string; // raw address bytes (hex)
  output: {
    Transaction: { Hash: string }; // 64-hex
    UtxoTransactionOutput: { OutputIndex: number };
    tokens?: Array<{
      Token: {
        Identifier: string; // '.' for ADA, or `${policyId}.${assetNameHex}`
        Metadata: { ticker?: string; policyId?: string; assetName?: string };
      };
      TokenList: { Amount: string };
    }>;
    inlineDatumCborHex?: string;
    datumHashHex?: string;
    scriptRefCborHex?: string;
  };
};

const isHex = (s: string) => /^[0-9a-f]*$/i.test(s);
const isHex64 = (s: string) => /^[0-9a-f]{64}$/i.test(s);
const hexToBytes = (hex: string): Uint8Array => {
  if (!isHex(hex) || hex.length % 2 !== 0) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
};
const looksLikeTUSO = (hex: string) =>
  typeof hex === 'string' && /^[0-9a-f]+$/i.test(hex) && hex.toLowerCase().startsWith('82825820'); // 82 [input,output] / 82 [hash,index] / 58 20 (32-byte hash)

const unwrapScriptRef = (bytes: Uint8Array): Uint8Array => {
  // ScriptRef is CBOR tag 24 wrapping a byte string containing the script CBOR.
  if (bytes[0] !== 0xd8 || bytes[1] !== 0x18) throw new Error('Invalid script reference CBOR');
  const header = bytes[2];
  if (header == null || (header >> 5) !== 2) throw new Error('Invalid script reference byte string');
  const additional = header & 0x1f;
  let length: number;
  let offset: number;
  if (additional < 24) {
    length = additional;
    offset = 3;
  } else {
    const size = additional === 24 ? 1 : additional === 25 ? 2 : additional === 26 ? 4 : additional === 27 ? 8 : 0;
    if (size === 0 || bytes.length < 3 + size) throw new Error('Invalid script reference length');
    length = 0;
    for (let i = 0; i < size; i++) length = length * 256 + (bytes[3 + i] ?? 0);
    offset = 3 + size;
  }
  if (bytes.length !== offset + length) throw new Error('Invalid script reference payload length');
  return bytes.slice(offset);
};

export const useGetInputs = (walletUtxos: WalletUtxo[]) => {
  // encode one UTxO -> CBOR hex TUSO
  const encodeUtxo = (u: WalletUtxo): string => {
    const hex = RustModule.WasmScope(Module => {
      const CML = Module.CML;
      const input = CML.TransactionInput.new(
        CML.TransactionHash.from_hex(u.output.Transaction.Hash),
        BigInt(u.output.UtxoTransactionOutput.OutputIndex)
      );
      const multiAsset = CML.MultiAsset.new();
      let lovelace = BigInt(0);

      for (const token of u.output.tokens ?? []) {
        const amount = BigInt(token.TokenList.Amount);
        const isAda = token.Token.Identifier === '.' || (token.Token.Metadata?.ticker ?? '').toUpperCase() === 'ADA';
        if (isAda) {
          lovelace = amount;
          continue;
        }
        const policyId = token.Token.Metadata?.policyId;
        const assetNameHex = token.Token.Metadata?.assetName;
        if (policyId == null || assetNameHex == null) continue;
        multiAsset.set(CML.ScriptHash.from_hex(policyId), CML.AssetName.from_raw_bytes(hexToBytes(assetNameHex)), amount);
      }

      const value = multiAsset.policy_count() > 0 ? CML.Value.new(lovelace, multiAsset) : CML.Value.from_coin(lovelace);
      let datum;
      if (u.output.inlineDatumCborHex) {
        datum = CML.DatumOption.new_datum(CML.PlutusData.from_cbor_bytes(hexToBytes(u.output.inlineDatumCborHex)));
      } else if (u.output.datumHashHex) {
        datum = CML.DatumOption.new_hash(CML.DatumHash.from_hex(u.output.datumHashHex));
      }
      const scriptRef = u.output.scriptRefCborHex
        ? CML.Script.from_cbor_bytes(unwrapScriptRef(hexToBytes(u.output.scriptRefCborHex)))
        : undefined;
      const output = CML.TransactionOutput.new(CML.Address.from_hex(u.address), value, datum, scriptRef);
      return CML.TransactionUnspentOutput.new(input, output).to_cbor_hex();
    });
    if (!looksLikeTUSO(hex)) throw new Error(`Not a full TransactionUnspentOutput: ${hex.slice(0, 10)}…`);
    return hex;
  };

  // dedupe + validate by (txHash#index)
  const sanitize = (list: WalletUtxo[]) => {
    const seen = new Set<string>();
    const out: WalletUtxo[] = [];
    for (const u of list) {
      const txh = u.output?.Transaction?.Hash;
      const idx = u.output?.UtxoTransactionOutput?.OutputIndex;
      if (!txh || typeof idx !== 'number' || !isHex64(txh)) continue;
      const key = `${txh}#${idx}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(u);
    }
    // stable order
    out.sort(
      (a, b) =>
        a.output.Transaction.Hash.localeCompare(b.output.Transaction.Hash) ||
        a.output.UtxoTransactionOutput.OutputIndex - b.output.UtxoTransactionOutput.OutputIndex
    );
    return out;
  };

  // returns ALL UTXOs as TUSO CBOR hex
  const getInputs = async (): Promise<string[]> => {
    const utxos = sanitize(walletUtxos);
    return utxos.map(encodeUtxo);
  };

  return { getInputs };
};

export function sanitizeSlippageInput(
  raw: string,
  { max = 75, maxDecimals = 1 }: { max?: number; maxDecimals?: number } = {}
): string | null {
  let clean = (raw ?? '').replace(/[^0-9.]/g, '');

  // keep only the first dot
  let parts = clean.split('.');
  if (parts.length > 2) {
    clean = `${parts[0]}.${parts[1]}`;
    parts = clean.split('.'); // re-split after modifying
  }

  // limit decimals
  const decimals = parts[1] ?? '';
  if (decimals.length > maxDecimals) {
    clean = `${parts[0]}.${decimals.slice(0, maxDecimals)}`;
  }

  // enforce max (ignore change if over)
  if (clean !== '' && !Number.isNaN(Number(clean)) && Number(clean) > max) {
    return null;
  }

  return clean;
}

export const toBaseUnits = (val?: string | null, decimals = 0): bigint | null => {
  const s = (val ?? '').trim();
  if (s === '') return null;
  const bn = new BigNumber(s);
  if (!bn.isFinite() || bn.isNegative()) return null;
  const dp = bn.decimalPlaces();
  if ((dp ?? 0) > decimals) return null; // too many fraction digits
  // shift to base units and floor (no rounding up), then to bigint
  return BigInt(bn.shiftedBy(decimals).integerValue(BigNumber.ROUND_DOWN).toFixed());
};

export const getPriceImpactRisk = (priceImpact: number) => {
  if (priceImpact < PRICE_IMPACT_MODERATE_RISK || isNaN(priceImpact)) return 'none';
  if (priceImpact > PRICE_IMPACT_HIGH_RISK) return 'high';
  return 'moderate';
};
