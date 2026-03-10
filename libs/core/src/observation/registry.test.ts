import { describe, expect, it } from 'vitest';
import { SourceRegistry } from './registry.js';
import type { ObservationSource } from './types.js';

function makeSource(name: string): ObservationSource {
  return {
    name,
    scopeSchema: { type: 'object' },
    observe: () => Promise.resolve([]),
  };
}

describe('SourceRegistry', () => {
  it('registers and retrieves a source', () => {
    const registry = new SourceRegistry();
    const source = makeSource('file-fingerprint');
    registry.register(source);

    expect(registry.get('file-fingerprint')).toBe(source);
    expect(registry.has('file-fingerprint')).toBe(true);
  });

  it('returns undefined for unknown source', () => {
    const registry = new SourceRegistry();
    expect(registry.get('nonexistent')).toBeUndefined();
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('throws on duplicate registration', () => {
    const registry = new SourceRegistry();
    registry.register(makeSource('api-poll'));

    expect(() => registry.register(makeSource('api-poll'))).toThrow(
      'already registered',
    );
  });

  it('lists all registered sources', () => {
    const registry = new SourceRegistry();
    registry.register(makeSource('file-fingerprint'));
    registry.register(makeSource('api-poll'));
    registry.register(makeSource('schedule'));

    const names = registry.names().sort();
    expect(names).toEqual(['api-poll', 'file-fingerprint', 'schedule']);
  });

  it('list returns source objects', () => {
    const registry = new SourceRegistry();
    const source = makeSource('test');
    registry.register(source);

    expect(registry.list()).toEqual([source]);
  });
});
