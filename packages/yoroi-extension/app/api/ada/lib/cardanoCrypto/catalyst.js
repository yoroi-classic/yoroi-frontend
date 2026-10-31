// @flow

import { RustModule } from './rustLoader';
import blake2b from 'blake2b';
import { bytesToHex } from '../../../../coreUtils';

export const CatalystLabels = Object.freeze({
  DATA: 61284,
  SIG: 61285,
});

function prefix0x(hex: string): string {
  if (hex.startsWith('0x')) {
    return hex;
  }
  return '0x' + hex;
}

export function generateRegistrationMetadata(
  votingPublicKey: string,
  stakingPublicKey: string,
  rewardAddress: string,
  nonce: number,
  signer: Uint8Array => string
): Uint8Array {
  /**
   * Catalyst follows CIP 36 to prove the voting power
   * A transaction is submitted with following metadata format for the registration process
   * label: 61284
   * {
   *   1: "the delegation array",
   *   2: "stake key public key",
   *   3: "address to receive rewards to"
   *   4: "nonce (slot number)"
   *   5: "purpose (0)"
   * }
   * label: 61285
   * {
   *   1: "signature of blake2b-256 hash of the metadata signed using stakekey"
   * }
   */

  return createCip36AuxiliaryData(
    {
      '1': [[prefix0x(votingPublicKey), 1]],
      '2': prefix0x(stakingPublicKey),
      '3': prefix0x(rewardAddress),
      '4': nonce,
      '5': 0,
    },
    signer
  );
}

function createCip36AuxiliaryData(registrationData: Object, signer: Uint8Array => string): Uint8Array {
  return RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const generalMetadata = CML.Metadata.new();
    generalMetadata.set(
      // eslint-disable-next-line no-undef
      BigInt(CatalystLabels.DATA),
      CML.encode_json_str_to_metadatum(JSON.stringify(registrationData), CML.MetadataJsonSchema.BasicConversions)
    );

    const initialAuxiliaryData = CML.AuxiliaryData.new_shelley(generalMetadata);
    const initialMetadataBytes = initialAuxiliaryData.to_cbor_bytes();
    if (initialMetadataBytes == null) {
      throw new Error(`CML failed to serialize Catalyst metadata (kind ${initialAuxiliaryData.kind()})`);
    }
    const hashedMetadata = blake2b(256 / 8)
      .update(initialMetadataBytes)
      .digest('binary');
    initialAuxiliaryData.free();
    generalMetadata.set(
      // eslint-disable-next-line no-undef
      BigInt(CatalystLabels.SIG),
      CML.encode_json_str_to_metadatum(
        JSON.stringify({ '1': prefix0x(signer(hashedMetadata)) }),
        CML.MetadataJsonSchema.BasicConversions
      )
    );

    // Ledger encodes CIP-36 auxiliary data as [metadata, []].
    const finalAuxiliaryData = CML.AuxiliaryData.new_shelley(generalMetadata);
    const auxiliaryMetadata = CML.MetadatumList.new();
    auxiliaryMetadata.add(CML.TransactionMetadatum.from_cbor_bytes(finalAuxiliaryData.to_cbor_bytes()));
    auxiliaryMetadata.add(CML.TransactionMetadatum.new_list(CML.MetadatumList.new()));
    const bytes = Buffer.from(CML.TransactionMetadatum.new_list(auxiliaryMetadata).to_cbor_bytes());
    return bytes;
  });
}

export function privateKeyPublicKeyHex(privateKeyHex: string, extended: boolean = false): string {
  return RustModule.WasmScope(Module => {
    const bytes = Buffer.from(privateKeyHex, 'hex');
    const privateKey = extended
      ? Module.CML.PrivateKey.from_extended_bytes(bytes)
      : Module.CML.PrivateKey.from_normal_bytes(bytes);
    return bytesToHex(privateKey.to_public().to_raw_bytes());
  });
}

export function generateRegistration(request: {|
  stakePrivateKeyHex: string,
  catalystPrivateKeyHex: string,
  receiverAddress: string,
  slotNumber: number,
|}): Uint8Array {
  return generateRegistrationMetadata(
    privateKeyPublicKeyHex(request.catalystPrivateKeyHex, true),
    privateKeyPublicKeyHex(request.stakePrivateKeyHex),
    request.receiverAddress,
    request.slotNumber,
    hashedMetadata =>
      RustModule.WasmScope(Module =>
        Module.CML.PrivateKey.from_normal_bytes(Buffer.from(request.stakePrivateKeyHex, 'hex')).sign(hashedMetadata).to_hex()
      )
  );
}

export function generateCip15RegistrationMetadata(
  votingPublicKey: string,
  stakingPublicKey: string,
  rewardAddress: string,
  nonce: number,
  signer: Uint8Array => string
): Uint8Array {
  /**
   * Catalyst follows a certain standard to prove the voting power
   * A transaction is submitted with following metadata format for the registration process
   * label: 61284
   * {
   *   1: "pubkey generated for catalyst app",
   *   2: "stake key public key",
   *   3: "address to receive rewards to"
   *   4: "slot number"
   * }
   * label: 61285
   * {
   *   1: "signature of blake2b-256 hash of the metadata signed using stakekey"
   * }
   */

  return createCip36AuxiliaryData(
    {
      '1': prefix0x(votingPublicKey),
      '2': prefix0x(stakingPublicKey),
      '3': prefix0x(rewardAddress),
      '4': nonce,
    },
    signer
  );
}
