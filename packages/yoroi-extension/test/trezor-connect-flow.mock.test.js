import TrezorConnect from 'trezor-connect-flow';

test('exposes the default Connect API used by TrezorWrapper', () => {
  expect(TrezorConnect).toEqual(expect.objectContaining({ init: expect.any(Function), dispose: expect.any(Function) }));
});
