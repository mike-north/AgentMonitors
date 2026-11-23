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
/**
 * Foreign-throw scenarios name a catch site and the value thrown there. Validation
 * refuses proxies and never invokes accessors, so ordinary input cannot raise a
 * foreign value inside admission; a trusted descriptor wrapper installed before
 * import throws on a chosen visit instead. Each site is selected by the
 * (object, key) visit number: envelope preflight is the first visit of a state
 * member, scope preflight is the second visit of a scope member (the first is the
 * envelope preflight), and canonical encoding is the second visit of a state member.
 */
const foreignMatch =
  /^(foreign|getters|recursion)-(envelope-preflight|scope-preflight|canonical)$/.exec(
    scenario ?? '',
  );
const foreign = foreignMatch && {
  thrown: foreignMatch[1],
  site: foreignMatch[2],
  target: undefined,
  key: undefined,
  visit: foreignMatch[2] === 'envelope-preflight' ? 1 : 2,
  visits: 0,
  fired: 0,
  trapCalls: 0,
};
/** Every proxy trap counts, so any inspection of the caught value is observable. */
function countingProxy() {
  const handler = Object.create(null);
  for (const trap of [
    'apply',
    'construct',
    'defineProperty',
    'deleteProperty',
    'get',
    'getOwnPropertyDescriptor',
    'getPrototypeOf',
    'has',
    'isExtensible',
    'ownKeys',
    'preventExtensions',
    'set',
    'setPrototypeOf',
  ]) {
    handler[trap] = function () {
      foreign.trapCalls += 1;
      return Reflect[trap](...arguments);
    };
  }
  // A callable target lets the apply and construct traps observe calls too.
  return new Proxy(function foreignTarget() {
    return undefined;
  }, handler);
}
/**
 * Formatting and coercion consult these members of an ordinary object, so a read
 * of any of them shows the caught value was logged, inspected or stringified.
 * Proxies cannot show this: util.inspect formats a proxy's target without traps.
 */
function countingGetters() {
  const value = {};
  for (const key of [
    Symbol.toPrimitive,
    Symbol.for('nodejs.util.inspect.custom'),
    'message',
    'stack',
  ]) {
    Object.defineProperty(value, key, {
      configurable: true,
      enumerable: true,
      get() {
        foreign.trapCalls += 1;
        return undefined;
      },
    });
  }
  return value;
}
/** Unbounded non-tail recursion raises the engine's own stack-overflow RangeError. */
function overflow(depth) {
  return overflow(depth + 1) + 1;
}
if (foreign) {
  Object.getOwnPropertyDescriptor = function (value, key) {
    if (value === foreign.target && key === foreign.key) {
      foreign.visits += 1;
      if (foreign.visits === foreign.visit) {
        foreign.fired += 1;
        if (foreign.thrown === 'foreign') throw countingProxy();
        if (foreign.thrown === 'getters') throw countingGetters();
        overflow(0);
      }
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
} else if (
  scenario === 'error-membership-count' ||
  scenario === 'error-membership-throw' ||
  scenario === 'refusal-constructors'
) {
  // Exercise both counting catch sites and each distinct malformed-container refusal.
  const oversized = { ...input, state: { value: 'x'.repeat(262_145) } };
  const scope = Object.fromEntries(
    Array.from({ length: 5 }, (_, index) => [
      `k${index}`,
      Array.from({ length: 16 }, () => 'x'.repeat(512)),
    ]),
  );
  const accessor = Object.defineProperty({}, 'value', {
    enumerable: true,
    get() {
      throw new Error('Input accessor ran');
    },
  });
  const cycle = {};
  cycle.self = cycle;
  const malformed = [
    { value: undefined },
    { value: new Proxy({}, {}) },
    { value: new Date() },
    cycle,
    { [Symbol('key')]: true },
    accessor,
    // Sparse arrays pass counting but must still be refused by canonical validation.
    { value: new Array(1) },
  ];
  const originalError = Error;
  const originalTypeError = TypeError;
  const originalRangeError = RangeError;
  const membership = Object.getOwnPropertyDescriptor(Error, Symbol.hasInstance);
  let calls = 0;
  let results;
  try {
    if (scenario === 'refusal-constructors') {
      const replacement = function () {
        calls += 1;
        throw new originalError('Live error constructor ran');
      };
      globalThis.Error = replacement;
      globalThis.TypeError = replacement;
      globalThis.RangeError = replacement;
    } else {
      Object.defineProperty(originalError, Symbol.hasInstance, {
        configurable: true,
        get() {
          calls += 1;
          if (scenario === 'error-membership-throw') {
            throw new originalError('Error membership getter ran');
          }
          return Function.prototype[Symbol.hasInstance];
        },
      });
    }
    results = [
      validateExternalEventEnvelope(oversized),
      validateExternalEventEnvelope({ ...input, scope }),
    ];
    for (let index = 0; index < malformed.length; index += 1) {
      results[results.length] = validateExternalEventEnvelope({
        ...input,
        state: malformed[index],
      });
    }
  } finally {
    globalThis.Error = originalError;
    globalThis.TypeError = originalTypeError;
    globalThis.RangeError = originalRangeError;
    if (membership) {
      Object.defineProperty(originalError, Symbol.hasInstance, membership);
    } else {
      Reflect.deleteProperty(originalError, Symbol.hasInstance);
    }
  }
  assert.equal(calls, 0);
  assert.equal(results[0].error?.code, 'payload_too_large');
  assert.equal(results[1].error?.code, 'payload_too_large');
  for (let index = 2; index < results.length; index += 1) {
    assert.equal(results[index].error?.code, 'invalid_envelope');
  }
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
} else if (foreign) {
  // A control call proves the recursion helper raises a native RangeError here.
  let native;
  try {
    overflow(0);
  } catch (error) {
    native = error;
  }
  assert.ok(native instanceof RangeError);
  input.scope = { project: 'alpha' };
  input.state = { value: true };
  if (foreign.site === 'scope-preflight') {
    foreign.target = input.scope;
    foreign.key = 'project';
  } else {
    foreign.target = input.state;
    foreign.key = 'value';
  }
  let escaped = false;
  let result;
  try {
    result = validateExternalEventEnvelope(input);
  } catch {
    // The escaped value is not inspected; inspection would itself count traps.
    escaped = true;
  }
  foreign.target = undefined;
  assert.equal(escaped, false, 'A foreign exception escaped validation');
  assert.equal(foreign.fired, 1, 'The injected throw did not run');
  assert.equal(foreign.visits, foreign.visit);
  assert.equal(foreign.trapCalls, 0, 'The caught value was inspected');
  // 002 §16.1: malformed values are a permanent invalid_envelope, never thrown.
  assert.equal(result?.success, false);
  assert.equal(result.error.code, 'invalid_envelope');
  assert.equal(result.error.retryable, false);
} else {
  throw new Error(`Unknown probe: ${scenario}`);
}
