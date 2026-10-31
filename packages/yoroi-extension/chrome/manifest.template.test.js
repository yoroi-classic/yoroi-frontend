import buildManifest from './manifest.template';
import { genCSP } from './constants';

it('allows Trezor Suite to connect to the extension', () => {
  const manifest = buildManifest({
    description: 'test', defaultTitle: 'test', contentSecurityPolicy: "script-src 'self'; object-src 'self'",
    geckoKey: 'test@example.com', version: '1.0.0', enableProtocolHandlers: false, shouldInjectConnector: false,
  });
  expect(manifest.externally_connectable.matches).toContain('https://suite.trezor.io/*');
  expect(manifest.host_permissions).toContain('https://suite.trezor.io/*');
});

it('allows the local Trezor Bridge websocket in the extension CSP', () => {
  const csp = genCSP({ isDev: false, additional: { 'connect-src': [] } });
  expect(csp).toContain('ws://127.0.0.1:21335');
});
