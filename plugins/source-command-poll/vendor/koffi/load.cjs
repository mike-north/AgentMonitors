/**
 * Native capture and admission are package-relative and allowlisted. The daemon
 * reads limits; disposable launchers mutate process state. No registry resolution,
 * native search, lifecycle script or source compilation can be a fallback.
 * Linux admission inspects mapped libc before any native initializer can run;
 * uncertain evidence refuses without diagnostics or subprocesses. The refresh
 * script copies this file into each package beside its payload.
 */
const path = require('node:path');
const platform = `${process.platform}-${process.arch}`;
try {
  if (
    !['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].includes(
      platform,
    )
  ) {
    throw new Error('unsupported platform');
  }
  if (process.platform === 'linux') {
    let filenames;
    try {
      // Read the running process, not installed libraries: compatibility layers
      // may supply libc.so.6 while the process itself still uses musl.
      const maps = require('node:fs').readFileSync('/proc/self/maps', 'utf8');
      filenames = maps
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          // Only LF separates records; kernel paths can retain CR and Unicode
          // line separators, so the pathname remainder must use dotAll.
          const record = line.match(
            /^[\da-f]+-[\da-f]+\s+[rwxps-]{4}\s+[\da-f]+\s+[\da-f]+:[\da-f]+\s+\d+(?:\s+(.*))?$/s,
          );
          if (!record) throw new Error('unrecognized mapping');
          // Deleted files remain mapped evidence until the process unmaps them.
          return path.posix.basename(
            (record[1] || '').replace(/ \(deleted\)$/, ''),
          );
        });
    } catch {
      throw new Error('glibc is required');
    }
    // A positive glibc filename alone is insufficient when musl is also mapped.
    // Static Node builds and hidden/unknown libc mappings deliberately refuse.
    const glibc = filenames.some((name) =>
      /^(?:libc\.so\.6|libc-2\.\d+\.so)$/.test(name),
    );
    // Musl wildcards cover every pathname character accepted by the record
    // parser; a legal line separator must never hide negative ABI evidence.
    const musl = filenames.some((name) =>
      /^(?:ld-musl-.+\.so\.1|libc\.musl-.+)$/s.test(name),
    );
    if (!glibc || musl) throw new Error('glibc is required');
  }
  const native = require(path.join(__dirname, platform, 'koffi.node'));
  const wrap = require('./wrapper.cjs');
  const binding = wrap(native);
  // Mapped filenames admit loading; the exported glibc symbol remains a second
  // consistency check before exposing the binding to callers.
  if (process.platform === 'linux') {
    try {
      binding.load(null).func('const char *gnu_get_libc_version()')();
    } catch {
      throw new Error('glibc is required');
    }
  }
  module.exports = binding;
} catch (error) {
  throw new Error(
    `Native exec support for ${platform} could not be loaded: ${error.message}`,
    { cause: error },
  );
}
