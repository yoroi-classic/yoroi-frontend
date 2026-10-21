import TrezorConnect from 'trezor-connect-flow';

test('exposes the default Connect API used by TrezorWrapper', () => {
  expect(typeof TrezorConnect.init).toBe('function');
  expect(typeof TrezorConnect.dispose).toBe('function');
});
