import buildManifest from './manifest.template';

it('allows Trezor Suite to connect to the extension', () => {
  const manifest = buildManifest({
    description: 'test', defaultTitle: 'test', contentSecurityPolicy: "script-src 'self'; object-src 'self'",
    geckoKey: 'test@example.com', version: '1.0.0', enableProtocolHandlers: false, shouldInjectConnector: false,
  });
  expect(manifest.externally_connectable.matches).toContain('https://suite.trezor.io/*');
});
