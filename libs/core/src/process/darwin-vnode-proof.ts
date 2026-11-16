/**
 * Stock JXA libproc codec for a candidate's inherited regular-file identity.
 * Darwin arm64/x86_64 share the fixed-width proc_info layouts: fd entries are
 * 8 bytes; vnode_fdinfowithpath is 1200 bytes, with device/inode/path at 24/32/176.
 * Full-size replies and bounded enumeration are mandatory; stale or truncated
 * bytes never count. No PID, sibling, descriptor number or pathname alone proves
 * ownership. Only an exact journaled tuple may yield its life nonce.
 */

/** Embedded in the scoped ownership helper; requires only stock Foundation. @internal */
export const DARWIN_VNODE_PROOF = String.raw`
var vnodeBound = false;
// Fixed capacity bounds both storage and native work. Saturation is uncertainty,
// even if the returned prefix happens to contain a convincing descriptor.
var descriptorCapacity = 32768;
var descriptorData = $.NSMutableData.dataWithLength(descriptorCapacity);
var vnodeData = $.NSMutableData.dataWithLength(1200);
// Copy each bounded native reply once. Per-byte Objective-C pointer reads make
// scan cost depend on pathname length and can exhaust the helper's fixed budget.
// Latin-1 preserves every byte, including NUL and all uint64 inode bits.
function vnodeBytes(value, length) {
  var data = ObjC.unwrap($.NSString.alloc.initWithDataEncoding(value.subdataWithRange($.NSMakeRange(0, length)), $.NSISOLatin1StringEncoding));
  if (typeof data !== 'string' || data.length !== length)
    throw new Error('macOS vnode bytes unavailable or truncated');
  return data;
}
// Descriptor and device fields are unsigned 32-bit values, exact in a JXA Number.
function vnodeInteger(data, offset, width) {
  var value = 0;
  for (var i = width - 1; i >= 0; i--) value = value * 256 + data.charCodeAt(offset + i);
  return value;
}
// JXA lacks BigInt. Decimal arithmetic preserves all 64 inode bits without
// ever passing an imprecise JavaScript Number across the protocol boundary.
function vnodeDecimal(data, offset) {
  var value = '0';
  for (var i = 7; i >= 0; i--) {
    var carry = data.charCodeAt(offset + i), next = '';
    for (var j = value.length - 1; j >= 0; j--) {
      var digit = Number(value[j]) * 256 + carry;
      next = String(digit % 10) + next;
      carry = Math.floor(digit / 10);
    }
    value = (carry ? String(carry) : '') + next;
  }
  return value.replace(/^0+(?=.)/, '');
}
// A nonce can be returned only for the requested PID's own complete vnode detail.
function queryVnodeOwnership(pid, tokens) {
  if (!vnodeBound) {
    try {
      ObjC.bindFunction('proc_pidinfo', ['int', ['int', 'int', 'unsigned long long', 'void *', 'int']]);
      ObjC.bindFunction('proc_pidfdinfo', ['int', ['int', 'int', 'int', 'void *', 'int']]);
      vnodeBound = true;
    } catch (_) { throw new Error('macOS vnode native bridge unavailable'); }
  }
  var count = $.proc_pidinfo(pid, 1, 0, descriptorData.mutableBytes, descriptorCapacity);
  if (count <= 0 || count >= descriptorCapacity || count % 8 !== 0)
    throw new Error('macOS vnode descriptor enumeration unavailable, truncated or saturated');
  var listing = vnodeBytes(descriptorData, count);
  // Compare the canonical path's exact UTF-8 bytes without per-byte bridge calls.
  var expectedPaths = tokens.map(function(token) {
    return encodeURIComponent(token.path).replace(/%([0-9A-F]{2})/g, function(_, hex) {
      return String.fromCharCode(parseInt(hex, 16));
    });
  });
  for (var offset = 0; offset < count; offset += 8) {
    if (vnodeInteger(listing, offset + 4, 4) !== 1) continue;
    var fd = vnodeInteger(listing, offset, 4);
    // A disappearing descriptor is unavailable evidence, never stale proof.
    if ($.proc_pidfdinfo(pid, fd, 2, vnodeData.mutableBytes, 1200) !== 1200)
      throw new Error('macOS vnode detail unavailable or truncated');
    var data = vnodeBytes(vnodeData, 1200);
    var end = data.indexOf('\0', 176);
    if (end < 0) throw new Error('macOS vnode path is unterminated');
    var name = data.slice(176, end);
    var device = String(vnodeInteger(data, 24, 4));
    var inode = vnodeDecimal(data, 32);
    for (var index = 0; index < tokens.length; index++) {
      var token = tokens[index];
      if (name === expectedPaths[index] && device === token.device && inode === token.inode)
        return token.life;
    }
  }
  throw new Error('macOS ownership unreadable; no matching inherited vnode');
}
`;
