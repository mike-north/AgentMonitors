/**
 * Native capture and admission are package-relative and allowlisted. The daemon
 * reads limits; disposable launchers mutate process state. No registry resolution,
 * native search, lifecycle script or source compilation can be a fallback.
 * Linux admission requires file-backed glibc before any native initializer can run;
 * musl-shaped names veto loading even on synthetic mappings. Ambiguous labels
 * deliberately cause needless refusal, never positive evidence. The refresh
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
          // Preserve every name for the musl veto. Deleted real files still
          // establish glibc; removing this kernel suffix also exposes musl labels.
          return (record[1] || '').replace(/ \(deleted\)$/, '');
        });
    } catch {
      throw new Error('glibc is required');
    }
    // Only absolute, nonsynthetic paths can establish glibc. Caller-chosen
    // memfd/dmabuf labels cannot be distinguished from real paths under matching
    // root directories, so both deliberately remain ineligible as positive evidence.
    // Linux sources: fs/proc/task_mmu.c, mm/memfd.c, ipc/shm.c,
    // mm/{shmem,mmap,secretmem}.c, fs/aio.c, fs/anon_inodes.c and
    // drivers/dma-buf/dma-buf.c (https://github.com/torvalds/linux).
    // Device numbers cannot distinguish synthetic objects from real files:
    // container overlays also allocate anonymous devices for mapped libc.
    const glibc = filenames.some(
      (filename) =>
        filename.startsWith('/') &&
        !/^\/(?:memfd:|dmabuf:|SYSV[\da-f]{8}$|dev\/zero$|anon_hugepage$|secretmem$|\[aio\]$)/.test(
          filename,
        ) &&
        /^(?:libc\.so\.6|libc-2\.\d+\.so)$/.test(path.posix.basename(filename)),
    );
    // A musl name at any slash/colon/bracket boundary vetoes loading, including
    // synthetic and nonabsolute names. Wildcards may span those delimiters too:
    // splitting first could hide a real musl basename containing ':' or brackets.
    // Harmless labels or directory segments may therefore cause needless refusal.
    // dotAll keeps legal non-LF separators from hiding negative ABI evidence.
    const musl = filenames.some((filename) =>
      /(?:^|\/|:|\[|\])(?:ld-musl-.+\.so\.1|libc\.musl-.+)(?=$|\/|:|\[|\])/s.test(
        filename,
      ),
    );
    // Static Node builds and hidden/unknown libc mappings deliberately refuse.
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
