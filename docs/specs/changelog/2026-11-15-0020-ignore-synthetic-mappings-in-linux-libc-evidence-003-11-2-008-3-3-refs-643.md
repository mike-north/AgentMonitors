## 2026-11-15 — Ignore synthetic mappings in Linux libc evidence (003 §11.2; 008 §3.3) — Refs #643

Only absolute filesystem paths contribute mapped libc evidence. Kernel memory-object
names, bracketed pseudo-mappings and pathless/nonabsolute records contribute nothing,
including caller-controlled memfd and DMA-buffer labels that resemble libc filenames.
Deleted real files still count; anonymous device numbers do not exclude real overlay
files. Injected maps tests cover synthetic names beside glibc and as the only evidence,
while preserving real musl precedence and refusal before native loading.

