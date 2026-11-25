## 2026-11-16 — Bound internal external-envelope admission

002 §16.1 and 004 §6.1 define inclusive envelope limits and their exact boundary
coverage. Resource admission now counts escaped UTF-8 bytes before canonical JSON
work, including shared-child graphs. Byte, cardinality and container-depth overruns
use permanent `payload_too_large`, resolving the mismatch with the declared error
contract. Malformed JSON and schema-shape failures retain `invalid_envelope`.
String length now bounds work before code-unit access, including rope flattening.
Admission captures intrinsics for byte counting and semantic validation so later
prototype replacements cannot execute producer code or alter admission. Actual
canonical output bytes are checked independently before normalization. Tests pin
the complete numeric contract, multibyte scope boundaries, isolated allocation and
prototype behavior, and refusal when preflight is made to undercount.
Refusal classification uses private identity tokens without mutable error
constructors or membership hooks. Scope boundaries include short and control
escapes at 32,768 and 32,769 canonical bytes below the envelope budget.
The canonical JSON foundation's domain and prototype policies remain authoritative.
The internal envelope contract remains outside the package-root API.

