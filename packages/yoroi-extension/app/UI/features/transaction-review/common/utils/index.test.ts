import { describe, expect, it } from '@jest/globals';
import '../../../../../api/ada/lib/test-config.forTests';
import { formatDrepHash } from './index';

describe('formatDrepHash', () => {
  it('encodes key and script hashes as distinct CIP-129 DRep IDs', () => {
    const hash = 'ab'.repeat(28);
    const keyId = formatDrepHash(hash, 'key');
    const scriptId = formatDrepHash(hash, 'script');

    expect(keyId).toMatch(/^drep1/);
    expect(scriptId).toMatch(/^drep1/);
    expect(keyId).not.toBe(scriptId);
  });
});
