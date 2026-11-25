## 2026-06-28 — `command-poll` teaches the inline pipeline idiom (003 §11.1)

Ergonomics/discoverability (no contract change): the argv-only rule for `command` is unchanged, but
a bare-string `command` is now rejected with a message that names the supported inline form,
`['sh', '-c', '<pipeline>']`, and the `init --type command-poll` template documents it in a comment.
[003 §11.1](../003-source-plugins.md) clarifies that shell features are opt-in via an explicit
`['sh','-c',…]` argv (the shell is `argv[0]`, author-chosen, not silently interposed). Part of the
"simple cases feel simple" authoring-ergonomics pass.

