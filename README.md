# claude-export-to-supermemory

Import Claude export archives into Supermemory using Bun.

## What this does

This project backfills Claude conversations and selected Claude metadata from an export ZIP, an extracted export directory, or raw JSON files into Supermemory.

v1 supports:

- `conversations.json`
- `memories.json`
- `project_memories` from `memories.json`
- optional `projects.json` docs import

By default it imports:

- conversations
- top-level Claude conversation memory
- project memories

It does **not** include Claude thinking/tool traces unless you ask for them.

## Why this is easier than ChatGPT export

Claude's export format is more straightforward. The sample archive inspected for this project contained:

- `users.json`
- `projects.json`
- `memories.json`
- `conversations.json`

And `conversations.json` was a plain array of conversation objects with ordered `chat_messages` arrays.

## Requirements

- Bun
- `mcporter` configured with access to the `supermemory` MCP server
- a valid Supermemory container tag, or let it default to `sm_project_default`

## Install

```bash
bun install
```

## CLI

```bash
bun run src/cli.ts --input /path/to/claude-export.zip
```

You can also pass:

- an extracted export directory containing `conversations.json`
- `conversations.json` directly

### Options

```bash
--container <tag>         Supermemory container tag
--manifest <path>         Local manifest path for dedupe tracking
--max-chars <n>           Max chars per saved memory item, default 120000
--limit <n>               Only import the first N conversations after filtering
--since <iso-date>        Only import conversations updated on or after this ISO date
--include-thinking        Include Claude thinking blocks
--include-tools           Include tool_use and tool_result blocks
--skip-memories           Skip top-level conversations_memory import
--skip-project-memories   Skip project_memories import
--include-project-docs    Include project docs from projects.json
--dry-run                 Parse and prepare items without sending to Supermemory
--verbose                 Print per-item progress
--help                    Show usage
```

## Examples

Dry run against a ZIP:

```bash
bun run src/cli.ts --input ~/Downloads/claude-export.zip --dry-run --verbose
```

Include project docs too:

```bash
bun run src/cli.ts --input ~/Downloads/claude-export.zip --include-project-docs
```

Import only recent conversations:

```bash
bun run src/cli.ts --input ~/Downloads/claude-export.zip --since 2025-01-01T00:00:00Z
```

## Development

```bash
bun run check
bun run lint
bun run test
```
