# pi-opencode-subagents

Context-isolated subagent delegation with Git worktree isolation and bounded result envelopes for the **pi** coding agent.

## Why This Architecture Minimizes Tokens

1. **Context Isolation (Zero Intermediate Leakage):**
   When a subagent runs, it executes in a separate child session. If the subagent reads 30 files, greps 10 patterns, and tests multiple hypotheses, **zero** of those exploratory tokens enter the parent conversation history.
2. **Bounded `<task-result>` Envelope with Resource Stats:**
   The parent agent receives a clean, structured XML envelope with full token and tool call stats:
   ```xml
   <task-result id="subagent_94f2a1" status="completed" duration="14.2s" tokens_in="12400" tokens_out="850" cache_read="45200" tool_calls="5" cost="$0.015">
   Found the authentication bug: refreshToken() was expiring before cookie sync.
   Updated src/auth/token.ts and added regression test in test/auth.test.ts.
   Stats: 12.4k in · 850 out · 45.2k cache · 5 tools · $0.015
   Full transcript: /tmp/pi-subagents/subagent_94f2a1.log
   </task-result>
   ```
3. **Main Chat & Sidebar Stats:**
   - Every subagent completion card in the main chat displays a live stats badge (e.g. `↳ 12.4k in · 850 out · 45.2k cache · 5 tools · $0.015`).
   - Expanded view displays full token metrics, operations count, and worktree info.
   - Sidebar panel synchronizes with pi-sidebar-tui at 90ms animation ticks and displays vibrant green completion status (`● "task" · done in 14.2s`).
4. **Filesystem Isolation via Git Worktrees:**
   Coding tasks run in temporary detached Git worktrees (`/tmp/pi-worktrees/<id>`). Parallel subagents cannot clobber the primary repository tree or interfere with each other.
5. **Recursion Ceiling:**
   Enforces a strict `maxDepth = 1` ceiling to prevent subagents from recursively spawning runaway subagents.

## Commands

- `/subagents` - Inspect active or past subagents
- `/subagents-toggle` (or `/subagents toggle`, `/subagents-sidebar`) - 3-way toggle for subagent display:
  1. `input` — Only above text input (pinned widget below editor)
  2. `sidebar` — Only sidebar (sidebar panel)
  3. `both` — Both above text input and sidebar
  *(Running without arguments cycles through: `both` → `input` → `sidebar` → `both`)*
- `/sidebar-tui subagents <input|sidebar|both>` — Configure subagent display from sidebar TUI

*(Stats automatically aggregate into the main chat result cards and the sidebar tokens panel; manual commands are no longer needed.)*

## Running Tests

```bash
bun test
```
