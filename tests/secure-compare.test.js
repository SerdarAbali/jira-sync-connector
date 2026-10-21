import { secureCompare } from '../src/utils/secure-compare.js';

describe('secureCompare', () => {
  test('accepts equal secrets and rejects different or malformed values', () => {
    expect(secureCompare('same-secret', 'same-secret')).toBe(true);
    expect(secureCompare('same-secret', 'other-secret')).toBe(false);
    expect(secureCompare('short', 'longer-secret')).toBe(false);
    expect(secureCompare(null, 'secret')).toBe(false);
    expect(secureCompare('secret', 42)).toBe(false);
  });
});
