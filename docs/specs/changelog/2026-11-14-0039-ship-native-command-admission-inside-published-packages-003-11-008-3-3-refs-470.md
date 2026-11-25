## 2026-11-14 — Ship native command admission inside published packages (003 §11; 008 §3.3) — Refs #470

Vendor Koffi 3.3.7 JavaScript, MIT license and four unmodified prebuilds in the CLI and
command-poll tarballs: macOS arm64/x64 and Linux glibc arm64/x64. Remove registry native
binding dependencies. Resolve the payload relative to our own ESM/CJS entry point and
select the exact prebuild through a checked explicit-native wrapper shim. Unsupported
hosts (including Windows and musl), missing or corrupt binaries refuse work with a
platform diagnostic, without plain-spawn or source-build fallback. The refresh command
`node scripts/vendor-koffi.mjs` verifies registry SHA-512 integrity; a committed manifest
and offline hash/tampering tests protect shipped bytes. The standalone consumer denies
native package registry requests and requires a real installed CLI monitor to fire.
Koffi's source-build fallback fails to link on macOS 27.3, CMake 4.3.4, Apple clang 21
(`napi_*` undefined); it is never triggered.

