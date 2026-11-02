# pi-opencode-subagents

Specialized subagent delegation with Git worktree isolation, multi-turn continuation, and bounded result envelopes for the **pi** coding agent.

Designed with a barebone, minimal aesthetic matching **pi**'s native UI conventions (such as `/fork`, `/tree`, and `/resume`), while providing full feature parity with **OpenCode**'s subagent architecture.

---

## Features

1. **Specialized Agent Profiles (`agent` parameter):**
   - **`general`** *(default)*: General-purpose agent for researching complex questions and executing multi-step tasks in parallel. Standard tools enabled, nested subagent spawning prevented.
   - **`explore`**: Fast read-only codebase search specialist. Guided by OpenCode's exploration instructions with read-only tools (`read`, `glob`, `grep`, `web_fetch`, `websearch`, read-only `bash`). Modification tools (`edit`, `write`, `subagent`) are disabled.
   - **Custom Agents**: Automatically discovers project and user markdown agents from:
     - `.opencode/agents/<name>.md`
     - `~/.config/opencode/agents/<name>.md`
     - `.pi/agents/<name>.md`
     - `~/.pi/agent/agents/<name>.md`

2. **Multi-Turn Conversation Continuation (`sessionID` parameter):**
   - Continue a child conversation across turns by passing its `sessionID`.
   - Preserves message history and context from earlier turns.
   - Calls without `sessionID` start fresh child sessions with standard subagent instructions.

3. **Non-Blocking Background Execution (Default):**
   - Subagents run asynchronously in the background by default and return immediately to avoid holding the main chat.
   - Returns a running status envelope with the `sessionID`.
   - Once completed, automatically delivers a notification and result envelope into the session.
   - Set `background: false` if you explicitly need synchronous/blocking execution.

4. **Native Pi UI (Inspired by Pi's `/fork`):**
   - Barebone, clean terminal UI using native `DynamicBorder` and Pi component styling.
   - Selector list: `› ` cursor on active item, bold titles, muted metadata (`[id] · agent · status · duration · tokens`), blank line spacing, and scroll counter.
   - Interactive transcript viewer: Clean header, scrollable transcript lines, live spinner ticks during active execution, and instant navigation.
   - Keybindings: `↑/↓` or `j/k` to navigate, `enter` to view transcript, `esc/q` to return or close.

5. **Filesystem Isolation via Git Worktrees (`isolated: true`):**
   - Tasks run in temporary detached Git worktrees (`/tmp/pi-worktrees/<id>`).
   - Multiple parallel subagents cannot clobber the primary repository tree or collide with each other.

6. **Bounded Result Envelopes (`<subagent>` / `<task-result>`):**
   - Parent receives a clean XML envelope with full resource usage stats:
     ```xml
     <subagent sessionID="subagent_94f2a1" state="completed" duration="14.2s" tokens_in="12400" tokens_out="850" cache_read="45200" tool_calls="5">
     Found the authentication bug: refreshToken() was expiring before cookie sync.
     Updated src/auth/token.ts and added regression test.
     Stats: 12.4k in · 850 out · 45.2k cache · 5 tools
     Full transcript: ~/.pi/agent/subagents/subagent_94f2a1.log
     </subagent>
     ```

7. **Recursion Ceiling:**
   - Strict `maxDepth = 1` recursion guard prevents subagents from spawning runaway child subagents.

---

## Tool Parameters

The `subagent` tool accepts the following parameters:

| Parameter | Type | Default | Description |
|---|---|---|---|
| `task` | `string` | *(required)* | Task description for the subagent to perform |
| `prompt` | `string` | — | Alias for `task` |
| `agent` | `string` | `"general"` | Specialized agent: `"general"`, `"explore"`, or a custom agent name |
| `description` | `string` | — | Short 3-5 word label/title for UI headers and status badges |
| `sessionID` | `string` | — | Pass an existing sessionID to continue that conversation |
| `background` | `boolean` | `true` | Run asynchronously in background without blocking main chat (set `false` to block) |
| `model` | `string` | — | Optional model override (e.g. `"provider/model"` or model ID) |
| `isolated` | `boolean` | `true` | Run in an isolated Git worktree |

---

## Commands

- `/subagents` - Open native Pi-style selector or viewer (`/subagents [id]`)
- `/subagents-toggle` (or `/subagents toggle`) - 3-way toggle for subagent display:
  1. `input` — Pinned widget above text input
  2. `sidebar` — Sidebar panel
  3. `both` — Both input widget and sidebar

---

## Running Tests

```bash
bun test
```
