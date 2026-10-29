## MODIFIED Requirements

### Requirement: Workspace path for project-relative scope

For project monitor evaluation the runtime SHALL supply `context.workspacePath`, the runtime workspace/config root. File-system-oriented sources SHALL use it to resolve project-relative scope instead of depending on the daemon process cwd. For a user-level monitor using absolute or home-relative globs, `context.workspacePath` SHALL be absent and the source MUST NOT use the daemon process cwd as a fallback for glob resolution.

#### Scenario: Project monitor resolution is independent of daemon cwd

- **GIVEN** a daemon whose process cwd is `/` and a project monitor in `/repo/.claude/monitors/x/MONITOR.md`
- **WHEN** the runtime calls the monitor's file-system source
- **THEN** `context.workspacePath` is `/repo` and the source resolves relative scope against `/repo`, not `/`

#### Scenario: User-level monitor gets no workspace

- **GIVEN** a user-level monitor with `globs: ['~/notes/**/*.md']` and a daemon whose process cwd is `/srv`
- **WHEN** the runtime calls the source
- **THEN** `context.workspacePath` is absent and no pattern is resolved against `/srv`
