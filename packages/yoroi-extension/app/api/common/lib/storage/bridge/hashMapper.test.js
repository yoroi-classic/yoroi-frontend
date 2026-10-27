// @flow

import '../../../../ada/lib/test-config.forTests';
import { RustModule } from '../../../../ada/lib/cardanoCrypto/rustLoader';
import { networks } from '../../../../ada/lib/storage/database/prepackaged/networks';
import { GetAddress } from '../../../../ada/lib/storage/database/primitives/api/read';
import { ModifyAddress } from '../../../../ada/lib/storage/database/primitives/api/write';
import { getAllTables } from '../../../../ada/lib/storage/database/utils';
import { rawGenHashToIdsFunc } from './hashMapper';

beforeAll(async () => {
  await RustModule.load();
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('maps base and pointer address hashes through their canonical enterprise addresses', async () => {
  const { baseAddressHex, pointerAddressHex, baseEnterpriseHex, pointerEnterpriseHex } = RustModule.WasmScope(Module => {
    const CML = Module.CML;
    const paymentCredential = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const stakeCredential = CML.Credential.new_pub_key(CML.Ed25519KeyHash.from_hex('22'.repeat(28)));
    const baseAddress = CML.BaseAddress.new(1, paymentCredential, stakeCredential).to_address();
    const pointerAddress = CML.Address.from_raw_bytes(Uint8Array.from([0x41, ...new Uint8Array(28).fill(0x11), 1, 2, 3]));
    const parsedBaseAddress = CML.BaseAddress.from_address(baseAddress);
    const parsedPointerAddress = CML.PointerAddress.from_address(pointerAddress);
    if (parsedBaseAddress == null || parsedPointerAddress == null) throw new Error('Invalid address fixtures');

    return {
      baseAddressHex: baseAddress.to_hex(),
      pointerAddressHex: pointerAddress.to_hex(),
      baseEnterpriseHex: CML.EnterpriseAddress.new(baseAddress.network_id(), parsedBaseAddress.payment())
        .to_address()
        .to_hex(),
      pointerEnterpriseHex: CML.EnterpriseAddress.new(pointerAddress.network_id(), parsedPointerAddress.payment())
        .to_address()
        .to_hex(),
    };
  });

  const queriedHashes = [];
  jest.spyOn(GetAddress, 'getByHash').mockImplementation(async (_db, _tx, hashes) => {
    queriedHashes.push(hashes);
    if (hashes.length === 2) return [];
    return [{ AddressId: 7 }];
  });
  jest.spyOn(GetAddress, 'getKeyForFamily').mockResolvedValue(123);
  let nextAddressId = 100;
  jest
    .spyOn(ModifyAddress, 'addFromCanonicalByHash')
    .mockImplementation(async (_db, _tx, addresses) => addresses.map(() => ({ AddressId: nextAddressId++ })));
  const addForeignByHash = jest.spyOn(ModifyAddress, 'addForeignByHash').mockResolvedValue([]);

  const ownAddressIds = new Set([7]);
  const result = await rawGenHashToIdsFunc(
    ownAddressIds,
    networks.CardanoMainnet
  )({
    db: ({}: any),
    tx: ({}: any),
    lockedTables: Array.from(getAllTables(GetAddress, ModifyAddress)),
    hashes: [baseAddressHex, pointerAddressHex],
  });

  expect(queriedHashes).toEqual([[baseAddressHex, pointerAddressHex], [baseEnterpriseHex], [pointerEnterpriseHex]]);
  expect(result).toEqual(
    new Map([
      [baseAddressHex, 100],
      [pointerAddressHex, 101],
    ])
  );
  expect(ownAddressIds).toEqual(new Set([7, 100, 101]));
  expect(addForeignByHash).toHaveBeenCalledWith({}, {}, []);
});
