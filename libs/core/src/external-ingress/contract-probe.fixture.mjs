/** Isolated admission probes keep hostile prototypes and large ropes outside the test runner. */
/* Indexed restoration remains independent of the prototype methods under test. */
/* eslint-disable @typescript-eslint/prefer-for-of */
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { registerHooks } from 'node:module';
import { URL } from 'node:url';

/** Load adjacent TypeScript sources using Node's native type stripping. */
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      context.parentURL?.startsWith(new URL('./', import.meta.url).href) &&
      specifier.startsWith('.') &&
      specifier.endsWith('.js')
    ) {
      return {
        url: new URL(specifier.slice(0, -3) + '.ts', context.parentURL).href,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const scenario = process.argv[2];
let observed;
let descriptorVisits = 0;
let laterVisits = 0;
const originalDescriptor = Object.getOwnPropertyDescriptor;
// Install trusted instrumentation before import so the admission modules capture it.
if (
  scenario === 'early-string' ||
  scenario === 'early-wide' ||
  scenario === 'dag'
) {
  Object.getOwnPropertyDescriptor = function (value, key) {
    descriptorVisits += 1;
    if (value === observed && key === 'later') {
      laterVisits += 1;
    }
    if (descriptorVisits > 50_000) {
      throw new Error('Traversal exceeded its work bound');
    }
    return originalDescriptor(value, key);
  };
}
let contract;
try {
  contract = await import('./contract.ts');
} finally {
  Object.getOwnPropertyDescriptor = originalDescriptor;
}
const { validateExternalEventEnvelope, canonicalJsonStringify } = contract;
descriptorVisits = 0;
/** Match the small valid envelope used by the independent byte-budget bypass example. */
const input = {
  schema: 'agentmonitors.external-event.v1',
  monitorId: 'm',
  source: 's',
  upstreamEventId: 'u',
  objectId: 'o',
  objectSequence: 0,
  eventKind: 'e',
  changeKind: 'modified',
  occurredAt: '2026-08-13T18:00:00Z',
  resumeToken: 'r',
  scope: {},
  state: { value: true },
};
if (scenario === 'allocation') {
  input.state.value = 'x'.repeat(128 * 1024 * 1024);
  globalThis.gc();
  const before = process.memoryUsage().heapUsed;
  const result = validateExternalEventEnvelope(input);
  const growth = process.memoryUsage().heapUsed - before;
  console.log(JSON.stringify({ growth, result }));
  assert.equal(result.error?.code, 'payload_too_large');
  // A 16 MiB allowance dwarfs normal sub-MiB admission work but catches 128 MiB flattening.
  // No collection is requested after admission, so the flattened live input cannot disappear.
  assert.ok(growth < 16 * 1024 * 1024, `Admission allocated ${growth} bytes`);
} else if (scenario === 'dag') {
  let state = {};
  for (let depth = 1; depth < 32; depth += 1) {
    state = { left: state, right: state };
  }
  input.state = state;
  const result = validateExternalEventEnvelope(input);
  assert.equal(result.error?.code, 'payload_too_large');
  assert.ok(descriptorVisits > 0 && descriptorVisits < 50_000);
} else if (scenario === 'early-string' || scenario === 'early-wide') {
  const wide = Object.fromEntries(
    Array.from({ length: 1000 }, (_, index) => [
      `key${index}`,
      'x'.repeat(512),
    ]),
  );
  observed =
    scenario === 'early-string'
      ? { first: 'x'.repeat(262_145), later: true }
      : { first: wide, later: true };
  input.state = observed;
  const result = validateExternalEventEnvelope(input);
  assert.equal(result.error?.code, 'payload_too_large');
  assert.equal(laterVisits, 0);
  assert.ok(descriptorVisits > 0 && descriptorVisits < 550);
} else if (scenario === 'iterator-getter' || scenario === 'iterator-throw') {
  input.scope = { project: ['alpha', 'beta'] };
  input.state = { value: [1, { valid: true }] };
  const baseline = validateExternalEventEnvelope(input);
  const original = Object.getOwnPropertyDescriptor(
    Array.prototype,
    Symbol.iterator,
  );
  let calls = 0;
  let result;
  try {
    Object.defineProperty(
      Array.prototype,
      Symbol.iterator,
      scenario === 'iterator-getter'
        ? {
            configurable: true,
            get() {
              calls += 1;
              return original.value;
            },
          }
        : {
            configurable: true,
            value() {
              calls += 1;
              throw new Error('Iterator ran');
            },
          },
    );
    result = validateExternalEventEnvelope(input);
  } finally {
    Object.defineProperty(Array.prototype, Symbol.iterator, original);
  }
  assert.equal(calls, 0);
  assert.equal(baseline.success, true);
  assert.deepEqual(result, baseline);
} else if (scenario === 'string-bypass') {
  input.state.value = 'é'.repeat(160_000);
  // This compact fixture produces exactly the oversized canonical bytes observed at the boundary.
  const bytes = Buffer.byteLength(canonicalJsonStringify(input));
  assert.equal(bytes, 320_255);
  const original = String.prototype.charCodeAt;
  let result;
  try {
    String.prototype.charCodeAt = function (index) {
      const unit = Reflect.apply(original, this, [index]);
      return unit === 233 ? 120 : unit;
    };
    result = validateExternalEventEnvelope(input);
  } finally {
    String.prototype.charCodeAt = original;
  }
  assert.equal(result.error?.code, 'payload_too_large');
} else if (scenario === 'scope-prototype-hole') {
  input.scope = { project: new Array(1) };
  const original = Object.getOwnPropertyDescriptor(Array.prototype, '0');
  let calls = 0;
  let result;
  try {
    Object.defineProperty(Array.prototype, '0', {
      configurable: true,
      get() {
        calls += 1;
        return 'inherited';
      },
    });
    result = validateExternalEventEnvelope(input);
  } finally {
    if (original) {
      Object.defineProperty(Array.prototype, '0', original);
    } else {
      delete Array.prototype[0];
    }
  }
  assert.equal(calls, 0);
  assert.equal(result.error?.code, 'invalid_envelope');
} else if (scenario === 'semantic-intrinsics') {
  input.occurredAt = '1990-12-31T23:59:60Z';
  input.scope = { project: ['é'] };
  const baseline = validateExternalEventEnvelope(input);
  const replacements = [
    [Object, 'keys'],
    [Object, 'entries'],
    [Object, 'getPrototypeOf'],
    [Object, 'getOwnPropertyDescriptor'],
    [Object, 'hasOwn'],
    [Array, 'isArray'],
    [JSON, 'parse'],
    [JSON, 'stringify'],
    [Buffer, 'byteLength'],
    [Number, 'isSafeInteger'],
    [Reflect, 'apply'],
    [Reflect, 'ownKeys'],
    [String.prototype, 'charCodeAt'],
    [Array.prototype, 'some'],
    [Set.prototype, 'has'],
    [Set.prototype, 'add'],
    [Set.prototype, 'delete'],
    [RegExp.prototype, 'exec'],
    [Date.prototype, 'setUTCFullYear'],
    [Date.prototype, 'setUTCHours'],
    [Date.prototype, 'getTime'],
    [Date.prototype, 'getUTCHours'],
    [Date.prototype, 'getUTCMinutes'],
    [Date.prototype, 'getUTCSeconds'],
    [Date.prototype, 'getUTCDate'],
    [Date.prototype, 'getUTCMonth'],
  ];
  const originals = replacements.map(([object, key]) =>
    Object.getOwnPropertyDescriptor(object, key),
  );
  let calls = 0;
  let result;
  try {
    for (let i = 0; i < replacements.length; i += 1) {
      const [object, key] = replacements[i];
      Object.defineProperty(object, key, {
        configurable: true,
        value() {
          calls += 1;
          throw new Error('Mutable method ran');
        },
      });
    }
    result = validateExternalEventEnvelope(input);
  } finally {
    for (let i = 0; i < replacements.length; i += 1) {
      const [object, key] = replacements[i];
      Object.defineProperty(object, key, originals[i]);
    }
  }
  assert.equal(calls, 0);
  assert.equal(baseline.success, true);
  assert.deepEqual(result, baseline);
} else {
  throw new Error(`Unknown probe: ${scenario}`);
}
