/** Native replies must prove this PID's exact vnode with complete, bounded ABI records. */
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';
import { DARWIN_VNODE_PROOF } from './darwin-vnode-proof.js';

/** Exercise the production bridge codec against independent kernel byte fixtures. */
function proof(
  options: {
    pid?: number;
    length?: number;
    detailSize?: number;
    path?: string;
    expectedPath?: string;
    device?: number;
    inode?: bigint;
    detailFailure?: boolean;
  } = {},
) {
  const calls: number[] = [];
  let nativeByteReads = 0;
  const foundation = {
    NSMutableData: {
      dataWithLength: (length: number) => {
        const data = Buffer.alloc(length);
        return {
          bytes: new Proxy(data, {
            get(target, key) {
              if (typeof key === 'string' && /^[0-9]+$/.test(key))
                nativeByteReads++;
              return Reflect.get(target, key, target);
            },
          }),
          mutableBytes: data,
          subdataWithRange: (range: { location: number; length: number }) =>
            data.subarray(range.location, range.location + range.length),
        };
      },
    },
    NSString: {
      alloc: {
        initWithDataEncoding: (data: Buffer, encoding: number) =>
          data.toString(encoding === 5 ? 'latin1' : 'utf8'),
      },
    },
    NSUTF8StringEncoding: 4,
    NSISOLatin1StringEncoding: 5,
    NSMakeRange: (location: number, length: number) => ({ location, length }),
    proc_pidinfo: (
      pid: number,
      _flavor: number,
      _arg: number,
      output: Buffer,
    ) => {
      calls.push(pid);
      output.writeUInt32LE(9, 0);
      output.writeUInt32LE(1, 4);
      return options.length ?? 8;
    },
    proc_pidfdinfo: (
      pid: number,
      fd: number,
      flavor: number,
      output: Buffer,
    ) => {
      calls.push(pid);
      expect(fd).toBe(9);
      expect(flavor).toBe(2);
      output.writeUInt32LE(options.device ?? 7, 24);
      output.writeBigUInt64LE(options.inode ?? 0xffffffffffffffffn, 32);
      output.write(options.path ?? '/private/life', 176);
      return options.detailFailure ? -1 : (options.detailSize ?? 1200);
    },
  };
  const context = {
    ObjC: {
      bindFunction: () => {
        /* Native signatures are supplied by the deterministic byte fixture. */
      },
      unwrap: (value: unknown) => value,
    },
    $: foundation,
  };
  const query: (pid: number, tokens: readonly unknown[]) => string =
    runInNewContext(`${DARWIN_VNODE_PROOF}\nqueryVnodeOwnership`, context);
  return {
    calls,
    nativeByteReads: () => nativeByteReads,
    query: () =>
      query(options.pid ?? 101, [
        {
          life: 'life',
          path: options.expectedPath ?? '/private/life',
          device: '7',
          inode: '18446744073709551615',
        },
      ]),
  };
}

it('preserves all uint64 inode bits and reads only the requested PID', () => {
  const fixture = proof();
  expect(fixture.query()).toBe('life');
  expect(fixture.calls).toEqual([101, 101]);
});
it.each([{ path: '/private/other' }, { device: 8 }, { inode: 1n }])(
  'rejects a different path/device/inode: %s',
  (options) => {
    expect(() => proof(options).query()).toThrow(/matching.*vnode/i);
  },
);
it.each([0, -1, 7, 32768, 32776])(
  'rejects incomplete or saturated descriptor enumeration (%i)',
  (length) => {
    expect(() => proof({ length }).query()).toThrow(/descriptor enumeration/i);
  },
);
it.each([0, -1, 1199, 1201])(
  'rejects a partial or failed vnode reply (%i)',
  (detailSize) => {
    expect(() => proof({ detailSize }).query()).toThrow(/vnode detail/i);
  },
);

/** Scan cost must not grow by crossing the native bridge once per pathname byte. */
it('bounds native bridge reads for long descriptor paths', () => {
  const path = '/private/' + 'x'.repeat(900);
  const fixture = proof({ path, expectedPath: path });
  expect(fixture.query()).toBe('life');
  expect(fixture.nativeByteReads()).toBeLessThanOrEqual(64);
});
