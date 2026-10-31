---
tracker:
  kind: linear
  provider:
    api_key: $LINEAR_API_KEY
    project_slug: a664f9cde1d5
  required_labels: [symphony]
  active_states: [Todo, In Progress]
  terminal_states: [Done, Canceled, Cancelled, Duplicate]
polling:
  interval_ms: 30000
workspace:
  root: $SYMPHONY_WORKSPACE_ROOT
hooks:
  timeout_ms: 180000
  after_create: |
    bash "$SYMPHONY_PROJECT_ROOT/scripts/symphony/bootstrap.sh"
  before_run: |
    set -eu
    test -d .git && test -d .symphony/beads && test -f .symphony/bootstrap-complete
    export PATH="$SYMPHONY_NODE_BIN:$PATH"
    node "$SYMPHONY_PROJECT_ROOT/scripts/symphony/prepare-workspace.mjs"
agent:
  max_concurrent_agents: 2
  max_turns: 10
codex:
  command: 'bash "$SYMPHONY_PROJECT_ROOT/scripts/symphony/codex.sh"'
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy:
    type: workspaceWrite
    networkAccess: true
  turn_timeout_ms: 3600000
server:
  host: 127.0.0.1
  port: 4000
---

You are working on Linear issue {{ issue.identifier }} in an isolated clone of harness-study.

Title: {{ issue.title }}
State: {{ issue.state }}
URL: {{ issue.url }}
Description:
{% if issue.description %}{{ issue.description }}{% else %}No description provided.{% endif %}
{% if attempt %}This is continuation attempt {{ attempt }}. Inspect existing changes and local records before working to avoid duplication.{% endif %}

Execution rules:

1. Read AGENTS.md and run `bd prime`. Find or create a local beads implementation
   issue with the Linear identifier in its title, then claim it before working.
   BEADS_DIR points to this clone's `.symphony/beads`. Do not connect to the main
   repository database or run Dolt remote sync. Linear tracks scheduling states;
   beads stores local implementation details and context across retries.
2. Use the injected `linear_graphql` tool to query this issue and its team states.
   Work only while the issue is Todo / In Progress and still has the symphony label.
   Change Todo to In Progress when starting. Operate only on this issue in this
   project; do not process other issues or projects.
3. Implement and validate in the current working directory. Node 22 is on PATH
   and dependencies are installed. Run at least `npm run check` and `npm test`;
   also run `npm run test:coverage` when changing tools. Do not call real model
   APIs unless the issue explicitly requires that validation.
4. The user explicitly authorizes this Symphony workflow to automatically commit
   task changes, push the issue branch, create or update its GitHub pull request,
   and attach the PR link to this Linear issue after validation. This is the
   user-authorized exception to AGENTS.md's default conservative git policy;
   no additional per-issue approval is needed for these delivery actions.
   A newer explicit user prohibition still takes precedence. Do not merge PRs,
   enable auto-merge, push directly to the default branch, force-push, deploy,
   or run Dolt remote sync. Do not send unsolicited comments, emails, or messages.
5. Deliver the implementation as a reviewable PR before reporting success:
   - Use the issue's existing `codex/symphony-<identifier>` branch in this clone.
     Inspect status, untracked files, and the complete diff before staging only
     files relevant to the issue. Exclude secrets, runtime data, local beads,
     and `.symphony/`. Preserve unrelated changes and existing commits.
   - Use `gh` to inspect the origin repository and its default branch. Fetch
     origin, confirm the intended PR base and diff, and check that required
     predecessor changes are present. A Linear Done state alone does not copy
     dependency code into this clone. The before_run hook fetches the remote
     default branch and fast-forwards only clean, non-diverged issue branches.
     Inspect `.symphony/base-sync.json`; preserved-dirty / preserved-diverged /
     preserved-operation means existing work was deliberately left intact.
     If required dependency code is still missing, report a blocker rather
     than resetting, rebasing, discarding work, or opening a misleading PR.
   - After the required checks pass, commit relevant changes with the Linear
     identifier in the message, then push this branch to origin with upstream
     tracking. Reuse a matching open PR on retries instead of creating duplicates.
     Do not create empty commits or empty PRs. If a previous PR is merged or closed,
     inspect the branch and report any delivery ambiguity instead of overwriting it.
   - Create or update a PR against the verified default branch. Include the issue
     identifier in the title and the Linear URL in the body. Describe the concrete
     behavior change, validation results, and any limitations. Use `--body-file`
     for multiline text. Check available CI results and report pending checks
     accurately; failed required checks must not be presented as successful delivery.
   - Attach the PR URL to this Linear issue using the injected `linear_graphql`
     tool after inspecting the available schema; reuse an existing matching link.
     If the Codex PR artifact attachment tool is available, also attach the PR
     to the current chat. Verify and record the PR URL and commit SHA.
6. Write changed files, validation and CI results, the absolute workspace path,
   beads identifier, commit SHA, PR URL, and blockers to `.symphony/result.md`.
   This is a delivery report, not a task list. After successful PR delivery,
   close completed beads work, move the Linear issue to the existing In Review
   state, and stop for human review. If requirements, tools, credentials, push,
   PR creation, or linking fail, preserve all work and record the exact failure
   in the report and this issue's description under a delivery-blocker section.
   Leave beads unfinished and move to the existing Blocked state for human
   assistance. Never use In Review without a verified PR URL attached to this
   issue. Blocked is neither an execution state nor a terminal state; preserve
   its workspace for recovery.
7. In Review is not an automatic execution state. A human can move an issue back
   to Todo / In Progress for rework; reuse its local changes and existing open PR.
   Do not mark Done automatically. A human should review and merge the PR before
   marking Done and starting dependent work. Symphony removes terminal workspaces.
   Use Chinese for delivery reports and user-facing summaries.
