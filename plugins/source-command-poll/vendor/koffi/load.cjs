/**
 * Native capture and admission are package-relative and allowlisted. The daemon
 * reads limits; disposable launchers mutate process state. No registry resolution,
 * native search, lifecycle script or source compilation can be a fallback.
 * The refresh script copies this file into each package beside its payload.
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
  const native = require(path.join(__dirname, platform, 'koffi.node'));
  const wrap = require('./wrapper.cjs');
  const binding = wrap(native);
  // Only glibc prebuilds ship. Check its native symbol without diagnostics,
  // which can wait on workers or reverse-resolve unrelated daemon sockets.
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
