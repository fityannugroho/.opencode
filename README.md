# .opencode

How I customize [OpenCode](https://opencode.ai) to match my workflow. This repository overrides built-in agents and adds custom agents, skills, plugins, and commands.

## Structure

```
.opencode/
├── AGENTS.md                 # Global instructions for all agents
├── opencode.jsonc            # Core config: agents, permissions, MCP, providers
├── tui.jsonc                 # TUI preferences
├── agents/*                  # Custom agents
├── plugins/                  # Custom plugins
│   ├── bash-guard.ts
│   ├── reminder.ts
│   └── task-tools.ts
├── skills/
│   └── subagents/SKILL.md
└── commands/
    ├── plan.md
    ├── notify.md
    ├── restart.md
    └── whip.md
```

## Customizations

This config adapts defaults to enforce a structured, safe, and agent-delegated workflow.

**`opencode.jsonc`** adjusts agent behavior, hardens permissions, and extends capabilities via MCP servers and an additional provider.

**`AGENTS.md`** defines the system prompt for OpenCode.

**`agents/`** defines a set of primary and sub-agent roles with specific instructions and responsibilities, injected to the system prompt.

**`plugins/`** adds lightweight tooling on top of OpenCode:
- `bash-guard.ts` — guards bash usage to prefer native tools.
- `reminder.ts` — provides persistent reminders and time utilities for sessions.
- `task-tools.ts` — helps inspect sessions and sub-agent tasks.

**`skills/subagents`** documents how sub-agents should be spawned, respawned, and grouped to avoid conflicts.

> I put the global skills in `~/.agents/skills` by default. The `subagents` skill is only for OpenCode, so I'm not including it in that directory. See my custom skills in [fityannugroho/skills](https://github.com/fityannugroho/skills).

**`commands/`** provides slash commands that control plan mode and agent coordination.
