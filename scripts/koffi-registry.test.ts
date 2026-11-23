/** A consumer registry must reject every native package spelling used by npm. */
import { describe, expect, it } from 'vitest';
import { isBlockedNativeRequest } from './test-standalone-consumer.mjs';
describe('consumer registry native-package barrier', () => {
  it.each([
    '/koffi',
    '/koffi/-/koffi-3.3.7.tgz',
    '/@koromix%2fkoffi-linux-x64',
    '/%40koromix%2Fkoffi-darwin-arm64',
    '/@koromix/koffi-darwin-arm64/-/koffi.tgz',
  ])('blocks %s', (url) => {
    expect(isBlockedNativeRequest(url)).toBe(true);
  });
  it.each([
    '/typescript',
    '/@types%2fnode',
    '/-/npm/v1/security/advisories/bulk',
  ])('allows unrelated request %s', (url) => {
    expect(isBlockedNativeRequest(url)).toBe(false);
  });
});
