// @flow
import '../../lib/test-config.forTests';

import { RustModule } from '../../lib/cardanoCrypto/rustLoader';
import { generateWalletRootKey } from '../../lib/cardanoCrypto/cryptoWallet';
import { HARD_DERIVATION_START, WalletTypePurpose, CoinTypes } from '../../../../config/numbersConfig';
import { networks } from '../../lib/storage/database/prepackaged/networks';
import { bytesToHex, hexToBytes } from '../../../../coreUtils';
import { v2genAddressBatchFunc } from './scan';

beforeAll(async () => {
  await RustModule.load();
});

test('CML reproduces Byron BIP44 external and internal addresses by index and network magic', () => {
  const rootKey = generateWalletRootKey(
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon share'
  );
  const accountKey = rootKey
    .derive(WalletTypePurpose.BIP44)
    .derive(CoinTypes.CARDANO)
    .derive(HARD_DERIVATION_START);
  const accountPublicKeyHex = bytesToHex(accountKey.to_public().to_raw_bytes());
  const network = networks.CardanoMainnet;
  const byronProtocolMagic = Number(network.BaseConfig[0].ByronNetworkId);
  const legacyVectors = [
    [
      [
        '8884b55163145ab46c7d1acd704b4c2e83dd34bef49301f9b6dec9768a90f735da4bb312e64066b1f5c1283b65739855217bdf065b6947a318522fbf27ea1eda',
        'Ae2tdPwUPEZLs4HtbuNey7tK4hTKrwNwYtGqp7bDfCy2WdR3P6735W5Yfpe',
      ],
      [
        '796cb55af0a71465f8254c1cf62eef1cfd18a1b345d60914812ff359f52975bc935809f7c3d484a623d8da6d7917f9ac252d534a9f61193223c6e6f04bfc068b',
        'Ae2tdPwUPEZ6sMd6oatRzNe96ytQEvExMNtxfHQksHdza8RpEon7p69FL6V',
      ],
      [
        '08f5ec4646d858e2932a51f959e700f80fc24932ea224f6f3631a4cc3deb6244927c70aa303ce4f2d89af60f1c416cd7052bbf3f0f953fc0e6ff13149c4d680e',
        'Ae2tdPwUPEZKboSfKt7oYTGRzvy1KYNwHyR9yvw6AR8gURLUPna86kHvMY9',
      ],
    ],
    [
      [
        'd44ada14748f1991c332b10786d42e8253d00e9a54544858db679303beba33d12dbdff3ffef18770362f8c6bcf5fca6259905ebf4d6e0513ba04f42b54004e67',
        'Ae2tdPwUPEYxiWbAt3hUCJsZ9knze88qNhuTQ1MGCKqsVFo5ddNyoTDBymr',
      ],
      [
        'e5b5abee1fadbd9166b13fb3dfb5f9ba5e0a61ac2ceb869f2442d58438dde7f74af77bbaea33ed414e67e3215300a0856916b3b35312bf37e08353910b7fec9f',
        'Ae2tdPwUPEZ5wbj77a4cNpvK1suLz3GyzmzXK4WPQVAPQnAsCf86tJ1TspH',
      ],
      [
        '9deaa6a884bc0a3c1c24156a023a55b6c4f92f375319602ae9ba92bf1cf596226e77d86f0070609550cd6dcc0da2cded34cb5968ad5c2020573dd1a5a750a052',
        'Ae2tdPwUPEZN7T7eeV9v8MNjz66SYLGVJUjPpHK4jgXAUfeLJgwNouBsYrN',
      ],
    ],
  ];

  for (const isExternal of [false, true]) {
    const chainIndex = isExternal ? 1 : 0;
    const cmlChildKeys = RustModule.WasmScope(Module => {
      const accountPublicKey = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
      return [0, 1, 17].map(index =>
        bytesToHex(
          accountPublicKey
            .derive(chainIndex)
            .derive(index)
            .to_raw_bytes()
        )
      );
    });
    expect(cmlChildKeys).toEqual(legacyVectors[chainIndex].map(([childKey]) => childKey));
    const cmlAddresses = v2genAddressBatchFunc(accountPublicKeyHex, chainIndex, byronProtocolMagic)([0, 1, 17]);
    expect(cmlAddresses).toEqual(legacyVectors[chainIndex].map(([, address]) => address));
  }

  const testnetMagic = Number(networks.CardanoPreprodTestnet.BaseConfig[0].ByronNetworkId);
  expect(v2genAddressBatchFunc(accountPublicKeyHex, 1, testnetMagic)([0])).not.toEqual(
    v2genAddressBatchFunc(accountPublicKeyHex, 1, byronProtocolMagic)([0])
  );
});
