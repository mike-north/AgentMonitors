/**
 * Native admission is package-relative and allowlisted. This module runs only
 * inside the disposable launcher, never on observe. No registry resolution,
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
  // Only glibc prebuilds ship. Refuse musl rather than guessing binary compatibility.
  if (
    process.platform === 'linux' &&
    !process.report.getReport().header.glibcVersionRuntime
  ) {
    throw new Error('glibc is required');
  }
  const native = require(path.join(__dirname, platform, 'koffi.node'));
  const wrap = require('./wrapper.cjs');
  module.exports = wrap(native);
} catch (error) {
  throw new Error(
    `Native exec support for ${platform} could not be loaded: ${error.message}`,
    { cause: error },
  );
}
