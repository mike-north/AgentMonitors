/**
 * macOS envp-only ownership reader. A sweep owns one asynchronous system-Python
 * helper, reused for discovery batches and fresh signal-time checks. Kernel
 * argument buffers stay inside the helper; its protocol returns only the reserved
 * ownership value or explicit uncertainty. No shell, PATH lookup, or native addon
 * participates. Without developer tools the Python shim must never be launched.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { z } from 'zod';
import type { CommandMarks } from './command-process-marks.js';
import { sendVerifiedSignal } from './process-identity.js';

/** Each requested PID needs exactly one answer; null means readable and unmarked. */
const responseSchema = z.array(
  z.tuple([z.number().int().positive(), z.string().nullable(), z.boolean()]),
);
/** Scope helper ownership to the caller rather than a global long-lived child. */
const readers = new AsyncLocalStorage<DarwinCommandMarkReader>();

/**
 * KERN_PROCARGS2 starts with argc, then the executable path and alignment NULs,
 * then exactly argc argv strings, then envp. Count argv, including empty strings:
 * searching the entire buffer for KEY= would let diagnostic argv authorize kills.
 * Python's isolated mode excludes user startup hooks and third-party modules.
 */
const HELPER = String.raw`
import ctypes, json, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
libc.sysctl.restype = ctypes.c_int
limit = ctypes.c_int()
size = ctypes.c_size_t(ctypes.sizeof(limit))
if libc.sysctl((ctypes.c_int * 2)(1, 8), 2, ctypes.byref(limit), ctypes.byref(size), None, 0) != 0 or not 0 < limit.value <= 32 * 1024 * 1024:
    raise RuntimeError('Kernel argument limit unavailable')
buffer = ctypes.create_string_buffer(limit.value)

def mark(pid):
    size = ctypes.c_size_t(len(buffer))
    if libc.sysctl((ctypes.c_int * 3)(1, 49, pid), 3, buffer, ctypes.byref(size), None, 0) != 0:
        raise ValueError('Process environment unavailable')
    data = buffer.raw[:size.value]
    if len(data) < 4:
        raise ValueError('Missing argc')
    argc = struct.unpack_from('=i', data)[0]
    if argc <= 0 or argc > len(data):
        raise ValueError('Invalid argc')
    cursor = data.index(b'\0', 4) + 1
    while cursor < len(data) and data[cursor] == 0:
        cursor += 1
    for _ in range(argc):
        cursor = data.index(b'\0', cursor) + 1
    found = None
    while cursor < len(data):
        end = data.index(b'\0', cursor)
        entry = data[cursor:end]
        if not entry:
            return found
        if entry.startswith(b'AGENTMONITORS_COMMAND_LIFE='):
            if found is not None:
                raise ValueError('Ambiguous duplicate mark')
            found = entry.split(b'=', 1)[1].decode('utf-8', errors='strict')
        cursor = end + 1
    raise ValueError('Unterminated environment')

for line in sys.stdin:
    result = []
    for pid in json.loads(line):
        try:
            result.append([pid, mark(pid), False])
        except (ValueError, UnicodeError):
            result.append([pid, None, True])
    print(json.dumps(result), flush=True)
`;

/** CLT/Xcode absence is ordinary unavailability, never permission to invoke the shim. */
async function hasDeveloperTools(): Promise<boolean> {
  try {
    if ((await stat('/Library/Developer/CommandLineTools')).isDirectory())
      return true;
  } catch {
    /* Full Xcode can supply the interpreter without the standalone CLT directory. */
  }
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/xcode-select',
      ['-p'],
      { timeout: 5_000, maxBuffer: 4096 },
      (error) => {
        resolve(error === null);
      },
    );
  });
}

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

  /** Lazy startup leaves empty sweeps free of helper and developer-tool probes. */
  private async start(): Promise<void> {
    if (this.child || this.failure) return;
    if (!(await hasDeveloperTools())) {
      this.failure =
        'macOS environment reader unavailable: Command Line Tools or Xcode required; Python shim was not launched';
      return;
    }
    // Reader infrastructure is not command work, even when a daemon was itself
    // launched by a marked command from an earlier life.
    const env = { ...process.env };
    delete env['AGENTMONITORS_COMMAND_LIFE'];
    const child = spawn('/usr/bin/python3', ['-I', '-u', '-c', HELPER], {
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
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
    await this.start();
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
          'macOS kernel process environment could not be read; ownership is unproven',
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
