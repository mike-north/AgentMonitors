## 2026-06-12 — Activation skill authors verified-firing monitors from intent (006 §5.6)

Issue #95 upgrades the activation plugin's bundled `setup-monitors` skill from setup/scaffolding
guidance into an intent-to-working-monitor workflow. The skill frontmatter now triggers on plain
language authoring requests ("watch this file", "tell me when...", "notify me when..."), and the
body instructs agents to select the smallest shipped source type, ask only for required config,
write the monitor body as user judgment, run `agentmonitors validate`, and verify that the monitor
fires before calling setup done. The debug playbook now routes "it didn't fire" reports through
`agentmonitors monitor explain` rather than ad hoc guessing.

- Plugin-skill/test/docs only; no published package changeset.

