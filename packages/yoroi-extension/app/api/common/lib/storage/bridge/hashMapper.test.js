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
    const CSL = Module.WalletV4;
    const paymentCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('11'.repeat(28)));
    const stakeCredential = CSL.Credential.from_keyhash(CSL.Ed25519KeyHash.from_hex('22'.repeat(28)));
    const baseAddress = CSL.BaseAddress.new(1, paymentCredential, stakeCredential).to_address();
    const pointer = CSL.Pointer.new(CSL.BigNum.from_str('1'), CSL.BigNum.from_str('2'), CSL.BigNum.from_str('3'));
    const pointerAddress = CSL.PointerAddress.new(1, paymentCredential, pointer).to_address();

    return {
      baseAddressHex: baseAddress.to_hex(),
      pointerAddressHex: pointerAddress.to_hex(),
      baseEnterpriseHex: CSL.EnterpriseAddress.new(
        baseAddress.network_id(),
        CSL.BaseAddress.from_address(baseAddress).payment_cred()
      )
        .to_address()
        .to_hex(),
      pointerEnterpriseHex: CSL.EnterpriseAddress.new(
        pointerAddress.network_id(),
        CSL.PointerAddress.from_address(pointerAddress).payment_cred()
      )
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
