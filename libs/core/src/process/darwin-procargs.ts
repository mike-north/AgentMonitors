/**
 * Portable byte parser shared verbatim with the stock macOS JXA helper. The
 * source string avoids a second parser implementation at the process boundary
 * and lets crafted buffers exercise the exact code used for signal authority.
 */
/** Exact parser source for the isolated native helper and portable fixtures. @internal */
export const DARWIN_PROCARGS_PARSER = String.raw`
function parseDarwinProcargs(data) {
  function terminated(cursor) {
    var end = data.indexOf('\0', cursor);
    if (end < 0) throw new Error('Truncated kernel arguments');
    return end;
  }
  if (data.length < 4) throw new Error('Missing argc');
  var argc = 0;
  for (var i = 3; i >= 0; i--) argc = argc * 256 + data.charCodeAt(i);
  if (argc <= 0 || argc > data.length) throw new Error('Invalid argc');
  var cursor = terminated(4) + 1;
  // The executable path is followed by alignment NULs before argv[0]. Never
  // search for a key to locate envp: even convincing marker text can be argv.
  while (cursor < data.length && data.charCodeAt(cursor) === 0) cursor++;
  for (var arg = 0; arg < argc; arg++) {
    var end = terminated(cursor);
    // Empty arguments and title-rewrite padding cannot be distinguished here.
    // Refuse that PID rather than placing envp inside the old argv allocation.
    if (end === cursor) throw new Error('Ambiguous argv padding');
    cursor = end + 1;
  }
  var found = null;
  var entries = 0;
  while (cursor < data.length) {
    var end = terminated(cursor);
    var entry = data.slice(cursor, end);
    if (!entry) {
      // An empty first entry could be leftover argv padding. A nonempty,
      // structurally valid envp must establish the boundary before termination.
      if (entries === 0) throw new Error('Unproven environment boundary');
      return found;
    }
    if (entry.indexOf('=') <= 0) throw new Error('Invalid environment entry');
    entries++;
    var prefix = 'AGENTMONITORS_COMMAND_LIFE=';
    if (entry.indexOf(prefix) === 0) {
      if (found !== null) throw new Error('Duplicate ownership mark');
      // Kernel strings are bytes. Decode only the reserved value, strictly;
      // unrelated environment and argument data never leave the helper.
      var encoded = '';
      for (var j = prefix.length; j < entry.length; j++)
        encoded += '%' + ('0' + entry.charCodeAt(j).toString(16)).slice(-2);
      found = decodeURIComponent(encoded);
    }
    cursor = end + 1;
  }
  throw new Error('Unterminated environment');
}
`;
