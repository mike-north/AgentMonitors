## 2026-11-14 — External JSON post-load prototype independence (002 §16)

Require zero caller-code execution for every input under the module-load built-in
trust assumption. Internal buffers and traversal must not consult mutable
prototype protocols or inherited numeric setters. Exclude URL and URLSearchParams
from the detectable hidden-state list: JavaScript brand-error construction can
itself invoke inherited hooks. Preserve native/private-brand refusal checks,
first-invalid-member order, depth bounds and canonical bytes.

