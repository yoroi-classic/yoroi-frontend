// @flow
import '../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';
import { generateWalletRootKey } from '../../api/ada/lib/cardanoCrypto/cryptoWallet';
import { buildCoseSign1FromSignature, cip8DataToSign } from '../../api/ada/lib/cardanoCrypto/utils';
import { bytesToHex, utfToBytes } from '../../coreUtils';
import { authSignHexPayload } from './index';

beforeAll(async () => {
  await RustModule.load();
});

test('connector payload signature matches the legacy CSL vector', async () => {
  const privateKeyHex = '01'.repeat(64);
  const payloadHex = 'a1b2c3d4';
  const expected =
    '34d4b274ca9f4231b8abcbc0d4f10d7bf4f572ff7095168c81a952dfb49c8807fa9181f32c5cf5b7bf03d956fba17c09652e229e1bce53ec8db16fb3736fd20a';
  await expect(authSignHexPayload({ privKey: privateKeyHex, payloadHex })).resolves.toEqual(expected);
});

test('CML connector login address, COSE signature, and generated key match legacy CSL vectors', async () => {
  const root = generateWalletRootKey(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon share'
  );
  const payload = utfToBytes('DAPP_LOGIN: fixture-app');
  const expected = {
    address: '00d734a635b4f14f745878f327b32e8911abede43879a4d7f683ac0e02bdf5598ccc7b24a88d4aa7dc6e3d77da7ac213957eeef34c17a44c16',
    signature:
      '845846a201276761646472657373583900d734a635b4f14f745878f327b32e8911abede43879a4d7f683ac0e02bdf5598ccc7b24a88d4aa7dc6e3d77da7ac213957eeef34c17a44c16a166686173686564f457444150505f4c4f47494e3a20666978747572652d6170705840555f979cc90bcc407b194544a1682fe37d6412aab1e878d08128f1ed6b9adca63e270630af3f2569d9abe9223da74997e3a8f9b6e3d6cde9bad77c68ff2bdd0e',
    pubkey: 'ffe8f14db3f2e13e79a00e933cf5af9daea9af9809665ea97fa326e5933fe3d0',
    privkey:
      '1072470b94e4ec37c02675f3bc9f04340d8c5a62bb73aa8aaf96e1dea32c9a5069f1625ca446f6206486919e7beedefc52d08664c13a25ff798df27d1c1ba504',
  };
  const actual = await RustModule.WasmScope(async Module => {
    const CML = Module.CML;
    const signingKey = CML.Bip32PrivateKey.from_raw_bytes(root.to_raw_bytes());
    const paymentKey = signingKey.derive(0).derive(0).to_raw_key();
    const stakeKey = signingKey.derive(2).derive(0).to_raw_key();
    const address = CML.BaseAddress.new(
      0,
      CML.Credential.new_pub_key(paymentKey.to_public().hash()),
      CML.Credential.new_pub_key(stakeKey.to_public().hash())
    ).to_address();
    const dataToSign = cip8DataToSign(Buffer.from(address.to_raw_bytes()), Buffer.from(payload));
    const signature = paymentKey.sign(dataToSign);
    const signatureValid = paymentKey.to_public().verify(dataToSign, signature);
    const cose = await buildCoseSign1FromSignature(
      Buffer.from(address.to_raw_bytes()),
      Buffer.from(signature.to_raw_bytes()),
      Buffer.from(payload)
    );
    const generatedKey = CML.Bip32PrivateKey.from_bip39_entropy(cose.signature(), new Uint8Array()).to_raw_key();
    return {
      address: address.to_hex(),
      signature: bytesToHex(cose.to_bytes()),
      signatureValid,
      pubkey: bytesToHex(generatedKey.to_public().to_raw_bytes()),
      privkey: bytesToHex(generatedKey.to_raw_bytes()),
    };
  });
  const { signatureValid, ...actualCose } = actual;
  expect(signatureValid).toBe(true);
  expect(actualCose).toEqual(expected);
});
