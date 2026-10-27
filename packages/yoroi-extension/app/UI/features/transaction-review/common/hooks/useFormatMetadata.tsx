import { useQuery } from '@tanstack/react-query';

import { TransactionBody } from '../types';
import { RustModule } from '../../../../../api/ada/lib/cardanoCrypto/rustLoader';

export const formatUnsignedTxMetadata = (metadataBytes: Uint8Array, txBody: TransactionBody): FormattedMetadata => {
  try {
    const hash = txBody.auxiliary_data_hash ?? null;
    const metadataJson = RustModule.WasmScope(Module => {
      const auxiliaryData = Module.CML.AuxiliaryData.from_cbor_bytes(metadataBytes);
      const metadata = auxiliaryData.metadata();
      if (metadata == null) return undefined;
      const labels = metadata.labels();
      for (let index = 0; index < labels.len(); index++) {
        const label = labels.get(index);
        if (Number(label) === 674) return metadata.get(label)?.to_json();
      }
      return undefined;
    });
    return { hash, metadata: format674(metadataJson) };
  } catch {
    console.error('Error parsing metadata');
    return { hash: txBody.auxiliary_data_hash ?? null, metadata: null };
  }
};

type FormattedMetadata = { hash: string | null; metadata: unknown | null };

export const formatCborMetadata = (cbor: string, txBody?: TransactionBody | null): FormattedMetadata => {
  const hash = txBody?.auxiliary_data_hash ?? null;
  try {
    const aux = RustModule.WasmScope(Module => {
      const auxiliaryData = Module.CML.Transaction.from_cbor_hex(cbor).auxiliary_data();
      const metadata = auxiliaryData?.metadata();
      if (metadata == null) return undefined;

      const labels = metadata.labels();
      for (let index = 0; index < labels.len(); index++) {
        const label = labels.get(index);
        if (Number(label) === 674) return metadata.get(label)?.to_json();
      }
      return undefined;
    });
    return { hash, metadata: format674(aux) };
  } catch (e) {
    console.error('Error parsing metadata', e);
    return { hash, metadata: null };
  }
};

const parse674Fragments = (key: string, rawList: string[]) => {
  const jsonString = rawList.join('').replace(/\\/g, '');
  const jsonFragments: object[] = [];
  let braceCount = 0;
  let currentFragment = '';

  for (const char of jsonString) {
    if (char === '{') braceCount++;
    if (braceCount > 0) currentFragment += char;
    if (char === '}') {
      braceCount--;
      if (braceCount === 0) {
        try {
          jsonFragments.push(JSON.parse(currentFragment));
        } catch (error) {
          console.error('Error parsing JSON fragment:', currentFragment, error);
        }
        currentFragment = '';
      }
    }
  }

  const mergedObject = jsonFragments.reduce((acc, obj) => ({ ...acc, ...obj }), {} as Record<string, unknown>);
  Object.keys(mergedObject).forEach(field => {
    if (mergedObject[field] === '') mergedObject[field] = '.';
  });
  return { [key]: [mergedObject] };
};

export const parseMetadata = (metadata: Record<string, string>) => {
  try {
    const parsed = metadata['674'] ? JSON.parse(metadata['674']) : {};
    const mapArray = parsed.map[0];
    const key = mapArray.k.string;
    const rawList = mapArray.v.list.map((item: any) => item.string);
    return parse674Fragments(key, rawList);
  } catch (error) {
    console.error('Error parsing metadata:', error);
    return {};
  }
};

export const useFormattedMetadata = ({
  metadata,
  cbor,
  txBody,
}: {
  metadata: Uint8Array | null;
  cbor: string | null;
  txBody?: TransactionBody | null;
}) => {
  const hasCbor = typeof cbor === 'string' && cbor.length > 0;
  const canUnsigned = metadata != null && txBody != null;

  const { data } = useQuery({
    queryKey: ['useFormattedMetadata', hasCbor ? cbor : metadata, txBody?.auxiliary_data_hash],
    enabled: hasCbor || canUnsigned,
    throwOnError: true,
    queryFn: () => {
      if (hasCbor && cbor) return formatCborMetadata(cbor, txBody);
      if (metadata != null && txBody != null) return formatUnsignedTxMetadata(metadata, txBody);
      return { hash: null, metadata: null };
    },
  });

  return data;
};

// 1) de-string any double-encoded JSON
const deepParse = (x: any, d = 0): any => {
  if (d > 6 || x == null) return x;
  const tryParse = (s: string) => {
    const t = s.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.parse(t);
      } catch {
        return s;
      }
    }
    return s;
  };
  const v = typeof x === 'string' ? tryParse(x) : x;

  // handle "null"
  if (v == null) return v;

  if (Array.isArray(v)) return v.map(y => deepParse(y, d + 1));
  if (typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, deepParse(val, d + 1)]));
  }
  return v;
};

// 2) turn the 674 "CBOR-JSON" shape into { key: value }
const format674 = (raw: any) => {
  const data = deepParse(raw);
  const label =
    data?.metadata?.['674'] ??
    data?.['674'] ?? // sometimes it’s already at root
    (Array.isArray(data?.map) ? data : null) ??
    null;

  if (!label || typeof label !== 'object' || !Array.isArray(label.map)) return null;

  const out: Record<string, any> = {};
  for (const entry of label.map) {
    const key = entry?.k?.string ?? entry?.k;
    let val = entry?.v;

    if (val?.list) {
      const parts = val.list.map((x: any) => x?.string ?? x);
      if (typeof key === 'string' && parts.every((part: any) => typeof part === 'string')) {
        val = parse674Fragments(key, parts)[key];
      } else {
        val = parts;
      }
    } else if (val?.string) val = val.string;

    if (key != null) out[key] = val;
  }
  return out;
};
