// @flow
import type { Addressing } from '../storage/models/PublicDeriver/interfaces';
import { RustModule } from './rustLoader';
import { hexToBytes } from '../../../../coreUtils';

export function derivePrivateKeyBytesByAddressing(request: {|
  privateKeyHex: string,
  addressing: $PropertyType<Addressing, 'addressing'>,
  level: number,
|}): Uint8Array {
  if (request.level + 1 < request.addressing.startLevel) {
    throw new Error('derivePrivateKeyBytesByAddressing keyLevel < startLevel');
  }
  return RustModule.WasmScope(Module => deriveCmlBip32PrivateKey(Module, request).to_raw_key().to_raw_bytes());
}

export function deriveBip32PrivateKeyBytesByAddressing(request: {|
  privateKeyHex: string,
  addressing: $PropertyType<Addressing, 'addressing'>,
  level: number,
|}): Uint8Array {
  if (request.level + 1 < request.addressing.startLevel) {
    throw new Error('deriveBip32PrivateKeyBytesByAddressing keyLevel < startLevel');
  }
  return RustModule.WasmScope(Module => deriveCmlBip32PrivateKey(Module, request).to_raw_bytes());
}

function deriveCmlBip32PrivateKey(
  Module: any,
  request: {| privateKeyHex: string, addressing: $PropertyType<Addressing, 'addressing'>, level: number |}
): any {
  let derivedKey = Module.CML.Bip32PrivateKey.from_raw_bytes(hexToBytes(request.privateKeyHex));
  const firstPathIndex = request.level - request.addressing.startLevel + 1;
  for (let index = firstPathIndex; index < request.addressing.path.length; index++) {
    const childIndex = request.addressing.path[index];
    if (childIndex == null) throw new Error('Invalid private key derivation path');
    derivedKey = derivedKey.derive(childIndex);
  }
  return derivedKey;
}
