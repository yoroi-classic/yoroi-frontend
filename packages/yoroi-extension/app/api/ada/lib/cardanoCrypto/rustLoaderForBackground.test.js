// @flow
import '../test-config.forTests';
import { RustModule } from './rustLoaderForBackground';

test('background CML objects created in a wasm scope are freed', () => {
  const addr = 'addr1qf2w3pe8jsyvr9kutpv6e0rzuaym7dvq0rrz9699a7y3wwvz6g3gz764vxla692p4ttcekdw0smpedxuqq7a8t8sv3usrcv98z';
  const scopeResult = RustModule.__WasmScopeInternal(Module => Module.CML.Address.from_bech32(addr).to_bech32());

  expect(scopeResult.result).toEqual(addr);
  expect(scopeResult.scopeSize).toEqual(1);
  expect(scopeResult.scopeIsFree).toEqual(true);
});
