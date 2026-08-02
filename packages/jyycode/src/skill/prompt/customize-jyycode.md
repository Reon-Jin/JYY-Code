<!-- Built-in guidance for configuring JYYCode itself. -->

# Customize JYYCode

Use this skill only when the user is editing JYYCode configuration, project
sub-agent profiles, skills, plugins, MCP servers, permissions, or related
`.jyycode/` files. Do not use it for application code. This skill is built in,
read-only, and is never visible to a child Agent.

## Source of truth

JYYCode validates configuration strictly. Before writing a field whose exact
shape is unclear, read the published schema at
`https://jyycode.ai/config.json`. A `jyycode.json` or `jyycode.jsonc` should
declare that URL in its `$schema` field. After changing configuration or
another config-time file, tell the user to restart JYYCode; the running
instance does not hot-reload these changes.

## Project sub-agent profiles

The desktop right rail is the project-level configuration entry point. Profiles
are stored in `subagents.profiles` and must include the enabled or disabled
`general` profile. Each profile has:

- `id`: stable dispatch identifier;
- `name` and `description`: roster text shown to the main Agent;
- `prompt`: launch-only instructions, copied into a child launch snapshot;
- `avatar`: one of `bot`, `search`, `code`, `bug`, `chart`, `file`, `image`,
  `folder`, `pen`, or `sparkles`;
- optional `model` (`provider/model-id`) and `variant`; and
- `enabled`: whether the profile may be dispatched.

The dispatch tool requires an enabled profile id. A running task keeps the
role, model, and launch prompt captured at dispatch time, so later profile
edits do not rewrite history.

## Skill boundaries

Global skills live under `~/.jyycode/skills/<skill-name>/SKILL.md` and are
available only to the root or single Agent. A role skill lives under
`~/.jyycode/role/<role-id>/skills/<skill-name>/SKILL.md` and is available only
to a child launched with that role. Child Agents must not discover or call
global skills, this built-in skill, or another role's skills.

Users may place a role `SKILL.md` manually, or use the right rail's private
skill form with a safe skill name and Markdown content. A skill should include
the required frontmatter:

```markdown
---
name: concise-lowercase-name
description: What the skill does and when to use it.
---

# Skill title

Instructions, examples, and references.
```

The frontmatter `name` must be lowercase, hyphen-separated, match the skill
directory, and be no longer than 64 characters. The `description` should state
both the capability and its trigger conditions.

## Other configuration

Project configuration is usually `./jyycode.json`, `./jyycode.jsonc`, or
`.jyycode/jyycode.json`; global configuration is under
`~/.config/jyycode/`. Keep models in `provider/model-id` form, use arrays for
MCP commands, and consult the published schema for every field not covered
above.
