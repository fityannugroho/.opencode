---
name: subagents
description: >
  Subagents usage guidelines and rules. Use this skill when need to interact to subagents (communicate, collaborate, or delegate a task). Do it before make `task` call.
---

`task` tool is actually just send a message to a subagent and wait for the response, nothing special. So you (main agent) can delegate your task or just simply talk each other like two-way conversation chat. A subagent works in a session, just like main agent.

## How to use subagents

| Action | Description | How To |
|---|---|---|
| Spawn | Create a new session for subagent | Call `task` tool WITHOUT `task_id` |
| Respawn | Continue/resume an existing session | Call `task` tool WITH `task_id` |

## `task` tool behaviors

Subagent's session created by `task` tool did not inherits context from main agent's session.
Spawned session cannot be disposed or reverted. The only way is workaround in database level (not safe!).

`subagent_type` can be switched in the same session (role switch), e.g. spawn with @coder then respawn with @reviewer. See "subagent rooms" concept for best practice.

`task_id` is returned immediately when a subagent start. Aborting the task does NOT invalidate the `task_id`, it only stops the execution. The session remains active, valid, and usable. Beware of typo when respawning. Nonexistent `task_id` will cause spawning new session instead of resuming existing one.

`task_result` may be empty if the task is aborted or malfunctioned. Resume it for clarification. `state: "completed"` can be misleading. For example, if the subagent hit its step limit, the state says "completed" but the work is actually partial/incomplete.

## What to do

Understand each subagent's capabilities and limitations. Read the subagent's descriptions. Delegate tasks accordingly.

Use `subagent-sessions` tool to check and verify any idle sessions every time before making calls.

Respawn over spawning. Reuse existing sessions. Only spawn when:
1) No idle session exists (verify first);
2) Parallel execution is required AND no idle session is available (must verify too);
3) Need isolated task (keep the context focused);
4) User or system instruct it explicitly.

Verify the outcome, not just state. `state: "completed"` may be misleading, read the actual result to determine completeness.

When a session hit its step limit, respawn. Give a simple "continue" prompt.

When a session returns nothing, always check `subagent-sessions` immediately and respawn the last subagent in that session to report its status. Empty results indicate some issues with the task like aborted, cancelled, malfunctioned response, rate limit request/high traffic, server error, etc. Never spawn new sessions because of this. Just keep trying.

Use `session-messages` to help investigate the status of a session. Do this when you need to understand why a session failed.

Use `session-compact` tool to summarize long-running or heavy context sessions. Use `session-detail` to see the current % usage.

### Parallelization

Only parallelize if it just a simple communication, read-only task, or the tasks are truly independent (like in separated worktrees).

Do NOT spawn when there are enough idle sessions available. For example:
- Spawn 2 sessions for 2 bug fixing tasks with @coder, then respawn those 2 sessions with @reviewer. This is correct ✅
- Spawn 2 sessions for 2 bug fixing tasks with @coder, then spawn 2 @reviewer (which means 4 sessions total). This is wrong ❌

Beware about race conditions. Think if the tasks requires isolated work environments or not. You must prepare it accordingly before spawning (e.g. git worktrees).

## Anti-patterns (what NOT to do)

Common mistakes that you should avoid:
- Do NOT over-spawning -> Check how much existing sessions you have spawned first. However, if it happens: 1) admit your mistakes, be transparent; 2) just go on. You can't revert it, so make the best use of it.
- Do NOT spawn just because you never spawn that agent -> Switch the `subagent_type` instead. See "subagent rooms" concept.
- Do NOT spawn just because the session was aborted or any error occurred -> Respawn to check the result and last status. The session still usable, no matter the circumstances.
- Do NOT delegate a large task in single calls (bulking) -> Delegate in a small-manageable task, 1 call for 1 task.
- Do NOT respawn to same session that may create a conflict of interest ("one man, different hat"). For example, you ask @reviewer for code review, but you respawn it in session where the @coder doing the implementation. To avoid this, implement "subagent rooms" concept.

## Subagent rooms

Switch between subagents within the same session is preferred. But you must avoid any potential problems like "one man, different hat". So here is why there are "subagent rooms" concept. The concept is to allocate sessions to specific group of subagents based on their similarity in functionality, while implementing rule "only switch subagent's role that in same room".

The rooms:
- Worker: @general, @coder, @debugger, @pentester, @librarian
- Helper: @explore, @vision
- Verificator: @advisor, @reviewer

## Communication and prompting

Always communicate with subagents in English.
Be concise: Focused on WHAT subagent should do (not WHO or HOW). Subagents already knows its role and how to perform.
Mention skills or tools that subagent should use. Only mention the name, not detailed instructions about it.

Prompt must align with the subagent's prompt instructions. See the subagent's description.
Do NOT add any AGENTS.md instructions in your prompt. The system will automatically loaded AGENTS.md for subagent too.

Mention the relevant files for the task, like PRD, specification file, and any other supporting documents. Use `@path/to/file` (in-project relative path) or `/path/to/file` (absolute path) syntax. So you don't need to put the task details in the prompt. Instead, just give additional context.

Prefer TOON format instead of JSON or Markdown table for data dump.

Examples how to correctly resume/respawn subagent based on the situations:
- Step limit reached -> Simple "finish your job" is enough.
- No result/aborted -> Ask for report, e.g. "Report your last status. Explain the situation."
- Revision needed -> Explain the revision needed, e.g. "Please revise your last work with ..."
- Different task -> Give specific instructions for the new task.

## Pro tips

Ask @advisor for guidance on making decisions, or clarifying ambiguous things.

Ask @vision for visual inspection or analysis when your model lacks the capability. Send the content separately one-by-one.
