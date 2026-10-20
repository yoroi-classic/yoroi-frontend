// @flow
import '../../api/ada/lib/test-config.forTests';
import { RustModule } from '../../api/ada/lib/cardanoCrypto/rustLoader';
import { generateWalletRootKey } from '../../api/ada/lib/cardanoCrypto/cryptoWallet';
import { buildCoseSign1FromSignature, cip8DataToSign, cip8Sign } from '../../api/ada/lib/cardanoCrypto/utils';
import { bytesToHex, utfToBytes } from '../../coreUtils';
import { authSignHexPayload } from './index';

beforeAll(async () => {
  await RustModule.load();
});

test('connector payload signature from CML matches CSL', async () => {
  const privateKeyHex = '01'.repeat(64);
  const payloadHex = 'a1b2c3d4';
  const expected = RustModule.WalletV4.PrivateKey.from_extended_bytes(Buffer.from(privateKeyHex, 'hex'))
    .sign(Buffer.from(payloadHex, 'hex'))
    .to_hex();
  await expect(authSignHexPayload({ privKey: privateKeyHex, payloadHex })).resolves.toEqual(expected);
});

test('CML-derived connector login address, COSE signature, and generated key match CSL', async () => {
  const root = generateWalletRootKey(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon share'
  );
  const payload = utfToBytes('DAPP_LOGIN: fixture-app');
  const expected = await RustModule.WasmScope(async Module => {
    const CSL = Module.WalletV4;
    const signingKey = CSL.Bip32PrivateKey.from_bytes(root.to_raw_bytes());
    const paymentKey = signingKey.derive(0).derive(0).to_raw_key();
    const stakeKey = signingKey.derive(2).derive(0).to_raw_key();
    const address = CSL.BaseAddress.new(
      0,
      CSL.Credential.from_keyhash(paymentKey.to_public().hash()),
      CSL.Credential.from_keyhash(stakeKey.to_public().hash())
    ).to_address();
    const cose = await cip8Sign(Buffer.from(address.to_bytes()), paymentKey, Buffer.from(payload));
    const generatedKey = CSL.Bip32PrivateKey.from_bip39_entropy(cose.signature(), Buffer.from('')).to_raw_key();
    return {
      address: address.to_hex(),
      signature: bytesToHex(cose.to_bytes()),
      pubkey: bytesToHex(generatedKey.to_public().as_bytes()),
      privkey: bytesToHex(generatedKey.as_bytes()),
    };
  });
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
