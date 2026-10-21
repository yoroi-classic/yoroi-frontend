// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoader';
import { generateLedgerWalletRootKey, generateWalletRootKey } from './cryptoWallet';
import { ChainDerivations, CoinTypes, WalletTypePurpose, HARD_DERIVATION_START } from '../../../../config/numbersConfig';
import { getCardanoHaskellBaseConfig, networks } from '../storage/database/prepackaged/networks';

beforeAll(async () => {
  await RustModule.load();
});

const getAddressForLedgerMnemonic = (mnemonic: string): string => {
  const baseConfig = getCardanoHaskellBaseConfig(networks.CardanoMainnet).reduce((acc, next) => Object.assign(acc, next), {});
  const rootKeyBytes = generateLedgerWalletRootKey(mnemonic).to_raw_bytes();
  return RustModule.WasmScope(Module => {
    const cml = Module.CML;
    const firstExternalAddressKey = cml.Bip32PrivateKey.from_raw_bytes(rootKeyBytes)
      .derive(WalletTypePurpose.BIP44)
      .derive(CoinTypes.CARDANO)
      .derive(0 + HARD_DERIVATION_START)
      .derive(ChainDerivations.EXTERNAL)
      .derive(0)
      .to_public();
    return cml.AddressContent.icarus_from_key(firstExternalAddressKey, cml.ProtocolMagic.new(Number(baseConfig.ByronNetworkId)))
      .to_address()
      .to_base58();
  });
};

test('Generate Ledger wallet', async () => {
  const address1 = getAddressForLedgerMnemonic(
    'correct cherry mammal bubble want mandate polar hazard crater better craft exotic choice fun tourist census gap lottery neglect address glow carry old business'
  );
  expect(address1).toEqual('Ae2tdPwUPEZ2a6sKg6Lu6dysskq549cgj8JyotmCJ3YSxidTSfj9qKRgjKJ');

  const address2 = getAddressForLedgerMnemonic(
    'struggle section scissors siren garbage yellow maximum finger duty require mule earn'
  );
  expect(address2).toEqual('Ae2tdPwUPEZ4Gs4s2recjNjQHBKfuBTkeuqbHJJrC6CuyjGyUD44cCTq4sJ');

  const address3 = getAddressForLedgerMnemonic(
    'vague wrist poet crazy danger dinner grace home naive unfold april exile relief rifle ranch tone betray wrong'
  );
  expect(address3).toEqual('Ae2tdPwUPEZMCGyPAK85FrcserPvzVZZUcbFk5TvDmL9LrUyq2KPYubPcru');

  const address4 = getAddressForLedgerMnemonic(
    'recall grace sport punch exhibit mad harbor stand obey short width stem awkward used stairs wool ugly trap season stove worth toward congress jaguar'
  );
  expect(address4).toEqual('Ae2tdPwUPEZFvG914wGXtCsb9hCr9aKjJC2ZciLKSNRqAKtjnduH7XtPn78');

  const address5 = getAddressForLedgerMnemonic(
    'burden destroy client air agent episode horror orient scrap car point easy local primary grunt seminar goose spin charge olive angry hour start shop'
  );
  expect(address5).toEqual('Ae2tdPwUPEZHiTeWAxzLFm5qYAGqLLwZ35huQJ7Dg5fJ4SN97d1QwhsuDrG');
});

test('Generate standard wallet root key with frozen derivation vectors', () => {
  const mnemonic = 'business sight another write gadget near where hollow insane dynamic grain hurt slim clip require';
  const cmlRoot = generateWalletRootKey(mnemonic);
  const path = [WalletTypePurpose.CIP1852, CoinTypes.CARDANO, HARD_DERIVATION_START, ChainDerivations.EXTERNAL, 0];
  const expected = {
    root:
      '104e6fe092dff467502839395b9415672f35af08ae094a9b9bb7823caa5e835845b60600c66c654bf1a27b5d202a76b2169d0dfbf67b1cb9db89459892d319be16c6824f38cbc9377d14de83f8619fa5a7368ae74cffa939e42d91b877e2c1be',
    child:
      'd8dae696cbb0d1d566c5ff1f2c5a6f7ed1a3beb55851c43c63ad39d9b65e835838a0bf4eb8ab52239cd0719ef39d465da73505f0e3d1b0d5fd0ac4c11bfa13eca25eb4be55487dbdadce0b6173637fcf179cb14ca3b7b6ecfe4728635343eeeb',
    publicChild:
      'da0be68c6524c01e6b98f2d02b037d1ae2d8e42c6d6d09bbdf3c728a0df010d0a25eb4be55487dbdadce0b6173637fcf179cb14ca3b7b6ecfe4728635343eeeb',
  };
  let cmlChild = cmlRoot;
  for (const index of path) {
    cmlChild = cmlChild.derive(index);
  }
  expect(Buffer.from(cmlRoot.to_raw_bytes()).toString('hex')).toEqual(expected.root);
  expect(Buffer.from(cmlChild.to_raw_bytes()).toString('hex')).toEqual(expected.child);
  expect(Buffer.from(cmlChild.to_public().to_raw_bytes()).toString('hex')).toEqual(expected.publicChild);
});
