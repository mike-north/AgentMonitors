/**
 * macOS envp-only ownership reader. A sweep owns one asynchronous stock JXA
 * helper, reused for discovery batches and fresh signal-time checks. Kernel
 * argument buffers stay inside the helper; its protocol returns only the reserved
 * ownership value or explicit uncertainty. No shell, PATH lookup, or native addon
 * participates. Foundation owns the native buffers passed to the sysctl bridge.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { DARWIN_PROCARGS_PARSER } from './darwin-procargs.js';
import type { CommandMarks } from './command-process-marks.js';
import { sendVerifiedSignal } from './process-identity.js';

/** Each requested PID needs exactly one answer; null means readable and unmarked. */
const responseSchema = z.array(
  z.tuple([z.number().int().positive(), z.string().nullable(), z.boolean()]),
);
/** Scope helper ownership to the caller rather than a global long-lived child. */
const readers = new AsyncLocalStorage<DarwinCommandMarkReader>();

/**
 * Foundation-owned buffers keep the JXA bridge independent of developer tools.
 * Darwin's supported architectures use little-endian 32-bit MIB integers and an
 * eight-byte size_t. Only the reserved value crosses the helper's output pipe.
 */
const HELPER = String.raw`
ObjC.import('Foundation');
ObjC.bindFunction('sysctl', ['int', ['void *', 'unsigned int', 'void *', 'void *', 'void *', 'unsigned long']]);
${DARWIN_PROCARGS_PARSER}
// Latin-1 preserves all kernel bytes, including NULs, without decoding argv/envp.
function bytes(value) {
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(value, $.NSISOLatin1StringEncoding));
}
// Native pointers always refer to Foundation-owned storage, kept alive for the
// helper's lifetime. Reuse them instead of allocating bridge objects per PID.
var mib = $.NSMutableData.dataWithLength(12);
var size = $.NSMutableData.dataWithLength(8);
var mibBytes = mib.mutableBytes;
var sizeBytes = size.mutableBytes;
// Write native little-endian integers into exclusively owned bridge storage.
function writeInteger(pointer, offset, value, width) {
  for (var i = 0; i < width; i++) {
    pointer[offset + i] = value % 256;
    value = Math.floor(value / 256);
  }
}
// Read kernel sizes without allocating an Objective-C string per PID.
function readInteger(pointer, width) {
  var value = 0;
  for (var i = width - 1; i >= 0; i--) value = value * 256 + pointer[i];
  return value;
}
writeInteger(mibBytes, 0, 1, 4);
writeInteger(mibBytes, 4, 8, 4);
var limitBuffer = $.NSMutableData.dataWithLength(4);
writeInteger(sizeBytes, 0, 4, 8);
if ($.sysctl(mibBytes, 2, limitBuffer.mutableBytes, sizeBytes, null, 0) !== 0)
  throw new Error('Kernel argument limit unavailable');
var limit = readInteger(limitBuffer.bytes, 4);
if (!(limit > 0 && limit <= 32 * 1024 * 1024)) throw new Error('Invalid argument limit');
var output = $.NSMutableData.dataWithLength(limit);
var outputBytes = output.mutableBytes;
writeInteger(mibBytes, 4, 49, 4);
// Only the returned byte count is parsed; stale bytes from earlier PIDs stay excluded.
function query(pid) {
  writeInteger(mibBytes, 8, pid, 4);
  writeInteger(sizeBytes, 0, limit, 8);
  if ($.sysctl(mibBytes, 3, outputBytes, sizeBytes, null, 0) !== 0)
    throw new Error('Kernel environment unavailable');
  var length = readInteger(sizeBytes, 8);
  if (length > limit) throw new Error('Invalid kernel size');
  return bytes(output.subdataWithRange($.NSMakeRange(0, length)));
}
var input = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
var pending = '';
while (true) {
  var chunk = input.availableData;
  if (Number(chunk.length) === 0) break;
  pending += bytes(chunk);
  if (pending.length > 32 * 1024 * 1024) throw new Error('Request too large');
  var newline;
  while ((newline = pending.indexOf('\n')) >= 0) {
    var pids = JSON.parse(pending.slice(0, newline));
    pending = pending.slice(newline + 1);
    var result = pids.map(function(pid) {
      try { return [pid, parseDarwinProcargs(query(pid)), false]; }
      catch (_) { return [pid, null, true]; }
    });
    stdout.writeData($.NSString.alloc.initWithString(JSON.stringify(result) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
  }
}
`;

/** Own one helper for the whole reconciliation, including exceptional exits. @internal */
export async function withDarwinCommandMarkReader<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const reader = new DarwinCommandMarkReader();
  try {
    return await readers.run(reader, operation);
  } finally {
    reader.close();
  }
}

/** Standalone calls receive the same scoped lifecycle as journal sweeps. @internal */
export async function readDarwinCommandMarks(
  pids: readonly number[],
): Promise<CommandMarks> {
  const reader = readers.getStore();
  if (reader) return reader.read(pids);
  return withDarwinCommandMarkReader(() => readDarwinCommandMarks(pids));
}

/** A failed helper stays failed for its scope; uncertainty never becomes an empty mark map. */
class DarwinCommandMarkReader {
  private child: ChildProcess | undefined;
  private failure: string | undefined;
  private output = '';
  private answer: ((line: string) => void) | undefined;
  private reject: ((error: Error) => void) | undefined;
  /** A pipe has one response at a time, even if future callers request concurrent reads. */
  private pending: Promise<void> = Promise.resolve();

  /** Release only our own helper; no inspected process is ever signalled here. */
  close(): void {
    this.child?.stdin?.end();
    if (this.child)
      void sendVerifiedSignal(
        { kind: 'spawned-process', handle: this.child },
        'SIGKILL',
        { action: 'macOS environment reader cleanup' },
      );
  }

  /** Preserve a bounded, environment-free reason across all later reads in this sweep. */
  private fail(reason = 'returned invalid evidence'): void {
    this.failure ??= `macOS environment reader ${reason}`;
    this.reject?.(new Error(this.failure));
    this.close();
  }

  /** Lazy startup leaves empty sweeps free of helper processes. */
  private start(): void {
    if (this.child || this.failure) return;
    // Reader infrastructure is not command work, even when a daemon was itself
    // launched by a marked command from an earlier life.
    const env = { ...process.env };
    delete env['AGENTMONITORS_COMMAND_LIFE'];
    const child = spawn(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', HELPER],
      {
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    this.child = child;
    child.once('error', (error: NodeJS.ErrnoException) => {
      this.fail(`could not start (${error.code ?? 'unknown'})`);
    });
    child.once('exit', (code, signal) => {
      this.fail(`exited (${String(code ?? signal ?? 'unknown')})`);
    });
    child.stdin.on('error', () => {
      this.fail('input pipe failed');
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.output += chunk;
      if (this.output.length > 32 * 1024 * 1024) {
        this.fail('exceeded its output bound');
        return;
      }
      const newline = this.output.indexOf('\n');
      if (newline < 0) return;
      const line = this.output.slice(0, newline);
      this.output = this.output.slice(newline + 1);
      this.answer?.(line);
    });
  }

  /** Batch requests avoid ARG_MAX and retain fresh environment evidence at each signal gate. */
  async read(pids: readonly number[]): Promise<CommandMarks> {
    const result = this.pending.then(() => this.query(pids));
    this.pending = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Exactly one request owns the response handlers and deadline until it settles. */
  private async query(pids: readonly number[]): Promise<CommandMarks> {
    this.start();
    if (this.failure) return { supported: false, reason: this.failure };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const output = await new Promise<string>((resolve, reject) => {
        this.answer = resolve;
        this.reject = reject;
        timer = setTimeout(() => {
          this.fail('timed out');
        }, 5_000);
        this.child?.stdin?.write(`${JSON.stringify(pids)}\n`);
      });
      const rows = responseSchema.parse(JSON.parse(output));
      const wanted = new Set(pids);
      if (
        rows.length !== wanted.size ||
        new Set(rows.map(([pid]) => pid)).size !== wanted.size ||
        rows.some(([pid]) => !wanted.has(pid))
      )
        throw new Error('Incomplete ownership response');
      const marks = new Map<number, string>();
      const unreadable: number[] = [];
      for (const [pid, mark, uncertain] of rows) {
        if (uncertain) unreadable.push(pid);
        else if (mark !== null) marks.set(pid, mark);
      }
      return {
        supported: true,
        marks,
        unreadable,
        unreadableReason:
          'macOS kernel process environment is unreadable or its argv/envp layout is ambiguous; ownership is unproven',
      };
    } catch {
      this.fail();
      return {
        supported: false,
        reason: this.failure ?? 'macOS environment reader failed',
      };
    } finally {
      clearTimeout(timer);
      this.answer = undefined;
      this.reject = undefined;
    }
  }
}
