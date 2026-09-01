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

**`commands/`** provides custom slash commands.

## How to use

### Agents

There are 3 user-facing agents: `@build`, `@manager`, `@qna`. The other agents are subagents that do not interact directly with the you (user). Switch the 3 based on your needs.
- `@build`: The default agent. Use this for simple/general tasks that don't require complex coordination.
- `@manager`: Agent for teamwork workflow. Use this for coding and any complex tasks.
- `@qna`: Designed for question-answering and information retrieval, read-only. Use this when you do not expect an implementation.

## Models and Thinking mode

You can [specify the model for each agents](https://opencode.ai/docs/agents/#model). It is recommended for subagents since you can not switch the subagent's model in runtime.

Example:
```markdown
---
name: reviewer
model: anthropic/claude-opus-5
variant: max
---
```

> Note: For `@vision` agent, make sure you use visual-capable models (image/video input) or it will not function properly.

### Plan mode

I disabled the built-in `@plan` agent since `@build` and `@manager` have already in plan mode by default. If you want to go back to plan mode in the middle of tasks, use the `/plan` slash command.

### `/whip` command

Use `/whip` when agent makes a mistake or violates your instructions. You can also add following messages/details (e.g., `/whip Do not use 'read' command`).
