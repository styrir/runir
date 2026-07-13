# runir CLI

Command-line interface for the Rúnir memory service.

## Installation

```bash
# From the repo root
npm link
```

Or run directly:

```bash
node --import tsx/esm cli/index.ts <command>
```

## Configuration

Set `RUNIR_URL` to point to your service (default: `http://localhost:7700`).

```bash
export RUNIR_URL=http://localhost:7700
```

## Commands

### health

Check service health.

```bash
runir health
```

### recall

Pre-turn recall — returns context to prepend to the agent's prompt.

```bash
runir recall --query "How do I configure logging?"
```

### capture

Post-turn capture — extracts facts from a conversation.

```bash
runir capture --messages ./conversation.json
runir capture --messages ./conversation.json --session-id abc123
```

### session-end

End-of-session summarization — segments topics and creates summaries.

```bash
runir session-end --messages ./conversation.json
runir session-end --messages ./conversation.json --session-id abc123
```

### store

Store a memory manually.

```bash
runir store --text "User prefers dark mode"
runir store --text "User prefers dark mode" --tags "preferences,ui"
runir store --text "Session-specific note" --scope session --session-id abc123
```

### search

Search memories.

```bash
runir search --query "user preferences"
runir search --query "user preferences" --limit 10
runir search --query "user preferences" --scope user
```

## Messages File Format

For `capture` and `session-end`, provide a JSON file with an array of messages:

```json
[
  { "role": "user", "content": "Hello, how are you?" },
  { "role": "assistant", "content": "I'm doing well, thanks for asking!" }
]
```

## Global Options

| Option | Description |
|--------|-------------|
| `--session-id <id>` | Session ID for scoped operations |
| `--user-id <id>` | User ID for all commands; should be the real human identity |

> **Note:** The CLI forwards `--user-id` to all commands, including `recall`, `capture`, and `session-end`. Prefer setting `RUNIR_USER_ID` to a real human identity (for example `brooks`) so multiple tools share one memory graph.

## Store Options

| Option | Description |
|--------|-------------|
| `--tags <t1,t2,...>` | Comma-separated tags |
| `--scope <scope>` | `session`, `user`, or `global` |

## Search Options

| Option | Description |
|--------|-------------|
| `--limit <n>` | Max results (default: 5) |
| `--scope <scope>` | Filter by scope |
