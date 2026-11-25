## 2026-11-12 — The ordering rebuild states what it preserves, loses and refuses (002 §5.2) — Refs #569

Carried expression defaults are now written back as expressions (`PRAGMA table_xinfo` reports
them without their parentheses, which made the rebuilt `CREATE TABLE` invalid and failed every
open). A retained `NULL` in a `NOT NULL DEFAULT` column now raises a `SchemaMigrationError` naming
the real table and column. A live table with a `UNIQUE` or `PRIMARY KEY` constraint other than the
lone `id` key (including a rowid-alias primary key on another column), or any `CHECK` or `REFERENCES`
constraint, or a `STRICT` table, is refused rather than silently loosened; only collation and the `NOT NULL` of a carried column without a default are lost. The check ignores
SQL comments, and the refusal message says that SQLite cannot drop a column or table constraint in place, so the table
must be rebuilt by hand or the database restored. A carried default that ends in a line comment is
written back with a newline before its closing parenthesis. 002 §5.2 lists what is preserved, lost and refused.

