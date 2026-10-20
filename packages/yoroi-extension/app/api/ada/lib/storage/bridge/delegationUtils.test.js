// @flow

import '../../test-config.forTests';
import { RustModule } from '../../cardanoCrypto/rustLoader';
import {
  createCertificate,
  DREP_ALWAYS_ABSTAIN,
  DREP_ALWAYS_NO_CONFIDENCE,
  stakeDeregistrationCertificateFromRewardAddress,
} from './delegationUtils';

beforeAll(async () => {
  await RustModule.load();
});

test('creates byte-compatible stake registration, delegation, and deregistration certificates with CML', () => {
  const stakingKeyHash = '11'.repeat(28);
  const poolKeyHash = '22'.repeat(28);
  const expected = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const credential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(stakingKeyHash));
    return {
      registrationAndDelegation: [
        CSL.Certificate.new_stake_registration(CSL.StakeRegistration.new(credential)).to_hex(),
        CSL.Certificate.new_stake_delegation(
          CSL.StakeDelegation.new(credential, CSL.Ed25519KeyHash.from_hex(poolKeyHash))
        ).to_hex(),
      ],
      deregistration: [CSL.Certificate.new_stake_deregistration(CSL.StakeDeregistration.new(credential)).to_hex()],
    };
  });

  expect(createCertificate(stakingKeyHash, false, poolKeyHash, undefined)).toEqual(expected.registrationAndDelegation);
  expect(createCertificate(stakingKeyHash, true, undefined, undefined)).toEqual(expected.deregistration);
  expect(createCertificate(stakingKeyHash, false, undefined, undefined)).toEqual([]);
  expect(createCertificate(stakingKeyHash, true, poolKeyHash, undefined)).toEqual([expected.registrationAndDelegation[1]]);
});

test('creates byte-compatible vote delegation certificates for key, script, and special DReps', () => {
  const stakingKeyHash = '11'.repeat(28);
  const drepKeyHash = '22'.repeat(28);
  const drepScriptHash = '33'.repeat(28);
  const { keyCredentialHex, scriptCredentialHex, expected } = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const stakeCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(stakingKeyHash));
    const keyCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex(drepKeyHash));
    const scriptCredential = CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex(drepScriptHash));
    return {
      keyCredentialHex: keyCredential.to_hex(),
      scriptCredentialHex: scriptCredential.to_hex(),
      expected: [
        CSL.Certificate.new_vote_delegation(
          CSL.VoteDelegation.new(stakeCredential, CSL.DRep.new_key_hash(CSL.Ed25519KeyHash.from_hex(drepKeyHash)))
        ).to_hex(),
        CSL.Certificate.new_vote_delegation(
          CSL.VoteDelegation.new(stakeCredential, CSL.DRep.new_script_hash(CSL.ScriptHash.from_hex(drepScriptHash)))
        ).to_hex(),
        CSL.Certificate.new_vote_delegation(CSL.VoteDelegation.new(stakeCredential, CSL.DRep.new_always_abstain())).to_hex(),
        CSL.Certificate.new_vote_delegation(
          CSL.VoteDelegation.new(stakeCredential, CSL.DRep.new_always_no_confidence())
        ).to_hex(),
      ],
    };
  });

  expect(createCertificate(stakingKeyHash, true, undefined, keyCredentialHex)).toEqual([expected[0]]);
  expect(createCertificate(stakingKeyHash, true, undefined, scriptCredentialHex)).toEqual([expected[1]]);
  expect(createCertificate(stakingKeyHash, true, undefined, DREP_ALWAYS_ABSTAIN)).toEqual([expected[2]]);
  expect(createCertificate(stakingKeyHash, true, undefined, DREP_ALWAYS_NO_CONFIDENCE)).toEqual([expected[3]]);
});

test('creates byte-compatible deregistration certificates from key reward addresses and rejects script credentials', () => {
  const { keyRewardAddressHex, scriptRewardAddressHex, expected } = RustModule.WasmScope(Module => {
    const CSL = Module.WalletV4;
    const keyCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const scriptCredential = CSL.Credential.from_scripthash(CSL.ScriptHash.from_hex('22'.repeat(28)));
    const keyAddressHex = CSL.RewardAddress.new(1, keyCredential)
      .to_address()
      .to_hex();
    const scriptAddressHex = CSL.RewardAddress.new(1, scriptCredential)
      .to_address()
      .to_hex();
    return {
      keyRewardAddressHex: keyAddressHex,
      scriptRewardAddressHex: scriptAddressHex,
      expected: CSL.Certificate.new_stake_deregistration(CSL.StakeDeregistration.new(keyCredential)).to_hex(),
    };
  });

  expect(stakeDeregistrationCertificateFromRewardAddress(keyRewardAddressHex)).toEqual(expected);
  expect(() => stakeDeregistrationCertificateFromRewardAddress(scriptRewardAddressHex)).toThrow(
    'Unexpected: withdrawal from a script hash'
  );
  expect(() => stakeDeregistrationCertificateFromRewardAddress('00')).toThrow();
});
