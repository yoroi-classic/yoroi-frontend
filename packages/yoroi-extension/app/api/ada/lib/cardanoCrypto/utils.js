// @flow

import { RustModule } from './rustLoader';
import {
  addressBech32ToHex as cmlAddressBech32ToHex,
  addressHexToBech32 as cmlAddressHexToBech32,
  poolKeyHashHexToBech32,
  rewardAddressFromKeyHash,
} from './cmlAddress';
import { bytesToHex, fail, forceNonNull, iterateLenGet, maybe } from '../../../../coreUtils';
import { base32ToHex, hexToBase32 } from '../storage/bridge/utils';

export function v4PublicToV2(v4Key: RustModule.WalletV4.Bip32PublicKey): RustModule.WalletV2.PublicKey {
  return RustModule.WalletV2.PublicKey.from_hex(bytesToHex(v4Key.as_bytes()));
}

export function poolIdHexToBech32(hex: string): string {
  return poolKeyHashHexToBech32(hex);
}

export function addressHexToBech32(hex: string): string {
  return cmlAddressHexToBech32(hex);
}

export function addressBech32ToHex(bech32: string): string {
  return cmlAddressBech32ToHex(bech32);
}

export function transactionHexToWitnessSet(txHex: string): string {
  return RustModule.WasmScope(Module =>
    Module.CML.Transaction.from_cbor_hex(txHex)
      .witness_set()
      .to_cbor_hex()
  );
}

export function transactionBodyHexToTransaction(txBodyHex: string): string {
  return RustModule.WasmScope(Module => {
    const body = Module.CML.TransactionBody.from_cbor_hex(txBodyHex);
    const witnessSet = Module.CML.TransactionWitnessSet.new();
    return Module.CML.Transaction.new(body, witnessSet, true).to_cbor_hex();
  });
}

export function transactionHexToBodyHex(txHex: string): string {
  return RustModule.WasmScope(Module =>
    Module.CML.Transaction.from_cbor_hex(txHex)
      .body()
      .to_cbor_hex()
  );
}

export function transactionHexToHash(txHex: string): string {
  return RustModule.WasmScope(Module => Module.CML.hash_transaction(Module.CML.Transaction.from_cbor_hex(txHex).body()).to_hex());
}

export function transactionHexReplaceWitnessSet(txHex: string, witnessSetHex: string): string {
  return RustModule.WasmScope(Module => {
    const tx = Module.CML.Transaction.from_cbor_hex(txHex);
    const witnessSet = Module.CML.TransactionWitnessSet.from_cbor_hex(witnessSetHex);
    const auxiliaryData = tx.auxiliary_data();
    return Module.CML.Transaction.new(tx.body(), witnessSet, tx.is_valid(), auxiliaryData).to_cbor_hex();
  });
}

export function transactionHexAddSignaturesFromWitnessSetHex(txHex: string, witnessSetHex: string): string {
  return RustModule.WasmScope(Module => {
    const tx = Module.CML.Transaction.from_cbor_hex(txHex);
    const witnessSet = tx.witness_set();
    const incomingWitnessSet = Module.CML.TransactionWitnessSet.from_cbor_hex(witnessSetHex);

    const vkeyWitnesses = witnessSet.vkeywitnesses() ?? Module.CML.VkeywitnessList.new();
    for (const vkeyWitness of iterateLenGet(incomingWitnessSet.vkeywitnesses())) {
      vkeyWitnesses.add(vkeyWitness);
    }
    if (incomingWitnessSet.vkeywitnesses() != null) {
      witnessSet.set_vkeywitnesses(vkeyWitnesses);
    }

    const bootstrapWitnesses = witnessSet.bootstrap_witnesses() ?? Module.CML.BootstrapWitnessList.new();
    for (const bootstrapWitness of iterateLenGet(incomingWitnessSet.bootstrap_witnesses())) {
      bootstrapWitnesses.add(bootstrapWitness);
    }
    if (incomingWitnessSet.bootstrap_witnesses() != null) {
      witnessSet.set_bootstrap_witnesses(bootstrapWitnesses);
    }

    return Module.CML.Transaction.new(tx.body(), witnessSet, tx.is_valid(), tx.auxiliary_data()).to_cbor_hex();
  });
}

export function dRepToMaybeCredentialHex(s: string): ?string {
  const isPotentiallyValidHex = /^(22|23)[0-9a-fA-F]{56}$/.test(s);
  return RustModule.WasmScope(Module => {
    try {
      if (s.startsWith('drep1')) {
        if (s.length === 58) {
          // CIP129 drep1 encoding is extended value with internal prefix
          return maybe(base32ToHex(s), dRepToMaybeCredentialHex);
        }
        // Pre CIP129 drep1 encoding means same as drep_vkh1 now
        return Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_bech32(s)).to_cbor_hex();
      }
      if (s.startsWith('drep_vkh1')) {
        return Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_bech32(s)).to_cbor_hex();
      }
      if (s.startsWith('drep_script1')) {
        return Module.CML.Credential.new_script(Module.CML.ScriptHash.from_bech32(s)).to_cbor_hex();
      }
      if (isPotentiallyValidHex && s.startsWith('22')) {
        return Module.CML.Credential.new_pub_key(Module.CML.Ed25519KeyHash.from_hex(s.substr(2))).to_cbor_hex();
      }
      if (isPotentiallyValidHex && s.startsWith('23')) {
        return Module.CML.Credential.new_script(Module.CML.ScriptHash.from_hex(s.substr(2))).to_cbor_hex();
      }
    } catch {} // eslint-disable-line no-empty
    return null;
  });
}

function parseDrep(drep: string): ?{| hash: string, isScript: boolean |} {
  const credentialHex = dRepToMaybeCredentialHex(drep);
  if (!credentialHex) {
    return null;
  }
  return RustModule.WasmScope(Module => {
    const cred = Module.CML.Credential.from_cbor_hex(credentialHex);
    const isScript = cred.as_script() != null;
    const hash = isScript ? forceNonNull(cred.as_script()).to_hex() : forceNonNull(cred.as_pub_key()).to_hex();
    return { hash, isScript };
  });
}

export function dRepNormalize(drep: string, kind?: string): string {
  function encodeDrepHash(hash: string, isScript: boolean): string {
    // cip129 prefix
    const prefix = isScript ? '23' : '22';
    return hexToBase32(prefix + hash, 'drep');
  }
  if (kind != null) {
    // drep is hash hex
    return encodeDrepHash(drep, kind === 'scripthash');
  }
  if (drep.startsWith('drep1') && drep.length === 58) {
    // drep already cip129
    return drep;
  }
  return (
    maybe(parseDrep(drep), r => encodeDrepHash(r.hash, r.isScript)) ??
    fail('Failed to normalize drep: ' + drep + ' | kind: ' + String(kind))
  );
}

export function dRepToPreCip129(drep: string): string {
  if ((drep.startsWith('drep1') && drep.length < 58) || drep.startsWith('drep_script1')) {
    // drep already pre cip129 compatible
    return drep;
  }
  return (
    maybe(parseDrep(drep), r => hexToBase32(r.hash, r.isScript ? 'drep_script' : 'drep')) ??
    fail('Failed to normalize drep: ' + drep)
  );
}

export function pubKeyHashToRewardAddress(hex: string, network: number): string {
  return rewardAddressFromKeyHash(network, hex);
}

export const cip8DataToSign = (address: Buffer, payload: Buffer): Buffer => {
  const protectedHeader = RustModule.MessageSigning.HeaderMap.new();
  protectedHeader.set_algorithm_id(
    RustModule.MessageSigning.Label.from_algorithm_id(RustModule.MessageSigning.AlgorithmId.EdDSA)
  );
  protectedHeader.set_header(
    RustModule.MessageSigning.Label.new_text('address'),
    RustModule.MessageSigning.CBORValue.new_bytes(address)
  );
  const protectedSerialized = RustModule.MessageSigning.ProtectedHeaderMap.new(protectedHeader);
  const unprotected = RustModule.MessageSigning.HeaderMap.new();
  const headers = RustModule.MessageSigning.Headers.new(protectedSerialized, unprotected);
  const builder = RustModule.MessageSigning.COSESign1Builder.new(headers, payload, false);
  return Buffer.from(builder.make_data_to_sign().to_bytes());
};

export const buildCoseSign1FromSignature = async (
  address: Buffer,
  signature: Buffer,
  payload: Buffer,
  payloadHashed: boolean = false
): Promise<RustModule.MessageSigning.COSESign1> => {
  const protectedHeader = RustModule.MessageSigning.HeaderMap.new();
  protectedHeader.set_algorithm_id(
    RustModule.MessageSigning.Label.from_algorithm_id(RustModule.MessageSigning.AlgorithmId.EdDSA)
  );
  protectedHeader.set_header(
    RustModule.MessageSigning.Label.new_text('address'),
    RustModule.MessageSigning.CBORValue.new_bytes(address)
  );
  const protectedSerialized = RustModule.MessageSigning.ProtectedHeaderMap.new(protectedHeader);
  const unprotected = RustModule.MessageSigning.HeaderMap.new();
  if (payloadHashed) {
    unprotected.set_header(
      RustModule.MessageSigning.Label.new_text('hashed'),
      RustModule.MessageSigning.CBORValue.new_special(RustModule.MessageSigning.CBORSpecial.new_bool(true))
    );
  }
  const headers = RustModule.MessageSigning.Headers.new(protectedSerialized, unprotected);
  const builder = RustModule.MessageSigning.COSESign1Builder.new(headers, payload, false);
  if (payloadHashed) {
    builder.hash_payload();
  }
  return builder.build(signature);
};

export const makeCip8Key: Uint8Array => RustModule.MessageSigning.COSEKey = publicSigningKey => {
  const key = RustModule.MessageSigning.COSEKey.new(
    RustModule.MessageSigning.Label.from_key_type(RustModule.MessageSigning.KeyType.OKP)
  );
  key.set_algorithm_id(RustModule.MessageSigning.Label.from_algorithm_id(RustModule.MessageSigning.AlgorithmId.EdDSA));
  key.set_header(
    RustModule.MessageSigning.Label.new_int(
      RustModule.MessageSigning.Int.new_negative(RustModule.MessageSigning.BigNum.from_str('1'))
    ),
    RustModule.MessageSigning.CBORValue.new_int(RustModule.MessageSigning.Int.new_i32(6))
  );
  key.set_header(
    RustModule.MessageSigning.Label.new_int(
      RustModule.MessageSigning.Int.new_negative(RustModule.MessageSigning.BigNum.from_str('2'))
    ),
    RustModule.MessageSigning.CBORValue.new_bytes(publicSigningKey)
  );

  return key;
};

function getWithdrawalKeyHashesFromTransactionBody(txBody: any): Set<string> {
  const result = new Set<string>();
  const withdrawals = txBody.withdrawals?.();
  if (withdrawals != null) {
    for (const rewardAddress of iterateLenGet(withdrawals.keys())) {
      maybe(
        rewardAddress
          .payment()
          .as_pub_key()
          ?.to_hex(),
        x => result.add(x)
      );
    }
  }
  return result;
}

function getCertificateKeyHash(credential: any): string | null {
  return credential.as_pub_key()?.to_hex() ?? null;
}

function getCertificateKeyHashesFromTransactionBody(txBody: any): Set<string> {
  const result = new Set<string>();
  const certificates = txBody.certs?.();
  if (certificates != null) {
    for (const certificate of iterateLenGet(certificates)) {
      const kind = certificate.kind();
      let credential;
      switch (kind) {
        case RustModule.CML.CertificateKind.StakeDeregistration:
          credential = certificate.as_stake_deregistration()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.StakeDelegation:
          credential = certificate.as_stake_delegation()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.RegCert:
          credential = certificate.as_reg_cert()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.UnregCert:
          credential = certificate.as_unreg_cert()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.VoteDelegCert:
          credential = certificate.as_vote_deleg_cert()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.StakeVoteDelegCert:
          credential = certificate.as_stake_vote_deleg_cert()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.StakeRegDelegCert:
          credential = certificate.as_stake_reg_deleg_cert()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.VoteRegDelegCert:
          credential = certificate.as_vote_reg_deleg_cert()?.stake_credential();
          break;
        case RustModule.CML.CertificateKind.StakeVoteRegDelegCert:
          credential = certificate.as_stake_vote_reg_deleg_cert()?.stake_credential();
          break;
        // The legacy registration variant has no explicit deposit and was
        // deliberately excluded by the previous CSL parser.
        default:
          break;
      }
      maybe(credential == null ? null : getCertificateKeyHash(credential), x => result.add(x));
    }
  }
  return result;
}

export function getStakingKeyHashesInTransactionBody(txBodyHex: string): Set<string> {
  return RustModule.WasmScope(Module => {
    const txBody = Module.CML.TransactionBody.from_cbor_hex(txBodyHex);
    const withdrawalKeys = getWithdrawalKeyHashesFromTransactionBody(txBody);
    const certificateKeys = getCertificateKeyHashesFromTransactionBody(txBody);
    return new Set([...withdrawalKeys, ...certificateKeys]);
  });
}
