// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoader';
import { CatalystLabels, generateRegistration } from './catalyst';

beforeAll(async () => {
  await RustModule.load();
});

test('Generate Catalyst registration tx', async () => {
  RustModule.WasmScope(Scope => {
    const cml = Scope.CML;
    const stakePrivateKeyHex = 'f5beaeff7932a4164d270afde7716067582412e8977e67986cd9b456fc082e3a';
    const catalystPrivateKeyHex =
      '4820f7ce221e177c8eae2b2ee5c1f1581a0d88ca5c14329d8f2389e77a465655c27662621bfb99cb9445bf8114cc2a630afd2dd53bc88c08c5f2aed8e9c7cb89';

    // stake_test1uzhr5zn6akj2affzua8ylcm8t872spuf5cf6tzjrvnmwemcehgcjm (e0ae3a0a7aeda4aea522e74e4fe36759fca80789a613a58a4364f6ecef)
    const address = cml.RewardAddress.new(
      0,
      cml.Credential.new_pub_key(
        cml.PrivateKey.from_normal_bytes(Buffer.from(stakePrivateKeyHex, 'hex'))
          .to_public()
          .hash()
      )
    );

    const nonce = 1234;
    const metadata = generateRegistration({
      stakePrivateKeyHex,
      catalystPrivateKeyHex,
      receiverAddress: address.to_address().to_hex(),
      slotNumber: nonce,
    });

    const outerList = cml.TransactionMetadatum.from_cbor_bytes(metadata).as_list();
    if (outerList == null) throw new Error('Expected CIP-36 auxiliary data list');
    const auxiliaryData = cml.AuxiliaryData.from_cbor_bytes(outerList.get(0).to_cbor_bytes());
    const result = auxiliaryData.metadata();
    if (result == null) throw new Error('Expected auxiliary metadata map');
    // eslint-disable-next-line no-undef
    const data = result.get(BigInt(CatalystLabels.DATA));
    if (data == null) throw new Error('Should never happen');

    // eslint-disable-next-line no-undef
    const sig = result.get(BigInt(CatalystLabels.SIG));
    if (sig == null) throw new Error('Should never happen');

    const dataJson = cml.decode_metadatum_to_json_str(data, cml.MetadataJsonSchema.BasicConversions);
    const sigJson = cml.decode_metadatum_to_json_str(sig, cml.MetadataJsonSchema.BasicConversions);

    const expectedResult = {
      '61284': {
        '1': [['0x0036ef3e1f0d3f5989e2d155ea54bdb2a72c4c456ccb959af4c94868f473f5a0', 1]],
        '2': '0x86870efc99c453a873a16492ce87738ec79a0ebd064379a62e2c9cf4e119219e',
        '3': '0xe0ae3a0a7aeda4aea522e74e4fe36759fca80789a613a58a4364f6ecef',
        '4': nonce,
        '5': 0,
      },
      '61285': {
        '1':
          '0x503e1b9e607e32f0d74a93da7261eb603132cf95d5405ee36d14431d3212bd49902445eeb47168e48858e295fd495cfad69f9fc1ea6da0ee3272c016a0bdef0b',
      },
    };
    expect({
      [CatalystLabels.DATA]: JSON.parse(dataJson),
      [CatalystLabels.SIG]: JSON.parse(sigJson),
    }).toEqual(expectedResult);
  });
});
