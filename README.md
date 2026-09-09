# pi-opencode-subagents

Context-isolated subagent delegation with Git worktree isolation and bounded result envelopes for the **pi** coding agent.

## Why This Architecture Minimizes Tokens

1. **Context Isolation (Zero Intermediate Leakage):**
   When a subagent runs, it executes in a separate child session. If the subagent reads 30 files, greps 10 patterns, and tests multiple hypotheses, **zero** of those exploratory tokens enter the parent conversation history.
2. **Bounded `<task-result>` Envelope:**
   The parent agent only receives a clean, structured XML envelope:
   ```xml
   <task-result id="subagent_94f2a1" status="completed" duration="14.2s">
   Found the authentication bug: refreshToken() was expiring before cookie sync.
   Updated src/auth/token.ts and added regression test in test/auth.test.ts.
   Full transcript: /tmp/pi-subagents/subagent_94f2a1.log
   </task-result>
   ```
3. **Filesystem Isolation via Git Worktrees:**
   Coding tasks run in temporary detached Git worktrees (`/tmp/pi-worktrees/<id>`). Parallel subagents cannot clobber the primary repository tree or interfere with each other.
4. **Recursion Ceiling:**
   Enforces a strict `maxDepth = 1` ceiling to prevent subagents from recursively spawning runaway subagents.

## Running Tests

```bash
bun test
```
