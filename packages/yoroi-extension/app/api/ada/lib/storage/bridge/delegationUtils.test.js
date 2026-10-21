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
  const expected = {
    registrationAndDelegation: [`82008200581c${stakingKeyHash}`, `83028200581c${stakingKeyHash}581c${poolKeyHash}`],
    deregistration: [`82018200581c${stakingKeyHash}`],
  };

  expect(createCertificate(stakingKeyHash, false, poolKeyHash, undefined)).toEqual(expected.registrationAndDelegation);
  expect(createCertificate(stakingKeyHash, true, undefined, undefined)).toEqual(expected.deregistration);
  expect(createCertificate(stakingKeyHash, false, undefined, undefined)).toEqual([]);
  expect(createCertificate(stakingKeyHash, true, poolKeyHash, undefined)).toEqual([expected.registrationAndDelegation[1]]);
});

test('creates byte-compatible vote delegation certificates for key, script, and special DReps', () => {
  const stakingKeyHash = '11'.repeat(28);
  const drepKeyHash = '22'.repeat(28);
  const drepScriptHash = '33'.repeat(28);
  const { keyCredentialHex, scriptCredentialHex } = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const keyCredential = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex(drepKeyHash));
    const scriptCredential = cml.Credential.new_script(cml.ScriptHash.from_hex(drepScriptHash));
    return {
      keyCredentialHex: keyCredential.to_cbor_hex(),
      scriptCredentialHex: scriptCredential.to_cbor_hex(),
    };
  });
  const stakeCredentialHex = `8200581c${stakingKeyHash}`;
  const expected = [
    `8309${stakeCredentialHex}${keyCredentialHex}`,
    `8309${stakeCredentialHex}${scriptCredentialHex}`,
    `8309${stakeCredentialHex}8102`,
    `8309${stakeCredentialHex}8103`,
  ];

  expect(createCertificate(stakingKeyHash, true, undefined, keyCredentialHex)).toEqual([expected[0]]);
  expect(createCertificate(stakingKeyHash, true, undefined, scriptCredentialHex)).toEqual([expected[1]]);
  expect(createCertificate(stakingKeyHash, true, undefined, DREP_ALWAYS_ABSTAIN)).toEqual([expected[2]]);
  expect(createCertificate(stakingKeyHash, true, undefined, DREP_ALWAYS_NO_CONFIDENCE)).toEqual([expected[3]]);
});

test('creates byte-compatible deregistration certificates from key reward addresses and rejects script credentials', () => {
  const { keyRewardAddressHex, scriptRewardAddressHex, expected } = RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const keyCredential = cml.Credential.new_pub_key(cml.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const scriptCredential = cml.Credential.new_script(cml.ScriptHash.from_hex('22'.repeat(28)));
    const keyAddressHex = cml.RewardAddress.new(1, keyCredential).to_address().to_hex();
    const scriptAddressHex = cml.RewardAddress.new(1, scriptCredential).to_address().to_hex();
    return {
      keyRewardAddressHex: keyAddressHex,
      scriptRewardAddressHex: scriptAddressHex,
      expected: `82018200581c${'11'.repeat(28)}`,
    };
  });

  expect(stakeDeregistrationCertificateFromRewardAddress(keyRewardAddressHex)).toEqual(expected);
  expect(() => stakeDeregistrationCertificateFromRewardAddress(scriptRewardAddressHex)).toThrow(
    'Unexpected: withdrawal from a script hash'
  );
  expect(() => stakeDeregistrationCertificateFromRewardAddress('00')).toThrow();
});
