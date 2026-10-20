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
  const settings = RustModule.WalletV2.BlockchainSettings.from_json({ protocol_magic: byronProtocolMagic });
  const account = RustModule.WalletV2.Bip44AccountPublic.new(
    RustModule.WalletV2.PublicKey.from_hex(accountPublicKeyHex),
    RustModule.WalletV2.DerivationScheme.v2()
  );

  for (const isExternal of [false, true]) {
    const legacyChain = account.bip44_chain(isExternal);
    const chainIndex = isExternal ? 1 : 0;
    const cmlChildKeys = RustModule.WasmScope(Module => {
      const accountPublicKey = Module.CML.Bip32PublicKey.from_raw_bytes(hexToBytes(accountPublicKeyHex));
      return [0, 1, 17].map(index => bytesToHex(accountPublicKey.derive(chainIndex).derive(index).to_raw_bytes()));
    });
    expect(cmlChildKeys).toEqual([0, 1, 17].map(index =>
      legacyChain.address_key(RustModule.WalletV2.AddressKeyIndex.new(index)).to_hex()
    ));
    const expected = [0, 1, 17].map(index =>
      legacyChain.address_key(RustModule.WalletV2.AddressKeyIndex.new(index)).bootstrap_era_address(settings).to_base58()
    );
    const cmlAddresses = v2genAddressBatchFunc(accountPublicKeyHex, chainIndex, byronProtocolMagic)([0, 1, 17]);
    expect(cmlAddresses).toEqual(expected);
  }

  const testnetMagic = Number(networks.CardanoPreprodTestnet.BaseConfig[0].ByronNetworkId);
  expect(v2genAddressBatchFunc(accountPublicKeyHex, 1, testnetMagic)([0])).not.toEqual(
    v2genAddressBatchFunc(accountPublicKeyHex, 1, byronProtocolMagic)([0])
  );
});
