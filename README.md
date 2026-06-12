# pi-code-formatter

A [pi](https://pi.dev) extension that automatically formats files after every `edit` tool call, and updates the reported `patch`/`diff` to include the formatting changes.

The model sees a clean diff from **original → formatted**, with both its semantic edits and any formatting corrections baked in. No more "oh the model left trailing whitespace / wrong indentation / steering messages" noise.

## How it works

```
User prompt ──► model calls Edit tool ──► file is written ──► formatter runs ──► patch/diff updated
                                                                    ▲
                                                  pi-code-formatter │
```

The extension hooks into two events:

| Event | What happens |
|-------|-------------|
| `tool_call` ("edit") | The extension stores the **original file content** before the edit runs. Only fires for files whose type has a configured formatter. |
| `tool_result` ("edit") | After the edit is applied, the extension runs the configured formatter on the file. If the formatter changed anything, it computes a new unified patch from original → formatted content and returns updated `patch`, `diff`, and `firstChangedLine` in the tool result `details`. |

Since `tool_result` handlers chain like middleware, the model only ever sees the final formatted patch — the intermediate unformatted state is invisible. No steering messages, no error handling.

## Install

### From GitHub

```bash
pi install git:github.com/losnappas/pi-code-formatter
```

Or manually:

```bash
git clone https://github.com/losnappas/pi-code-formatter ~/.pi/agent/extensions/pi-code-formatter
cd ~/.pi/agent/extensions/pi-code-formatter
npm install
```

Then restart pi or use `/reload`.

## Configuration

Config is loaded from two locations and merged (project overrides global):

| Scope | Path |
|-------|------|
| Global | `~/.pi/agent/extensions/pi-code-formatter/config.json` |
| Project | `.pi/extensions/pi-code-formatter/config.json` |

Project-level keys in `commands` and `filetypes` override global keys with the same name.

### Example

```json
{
  "commands": {
    "pi-treefmt": ["treefmt"],
    "prettier":   ["prettier", "--write"],
    "ruff":       ["ruff", "format"]
  },
  "filetypes": {
    "*":     "pi-treefmt",
    "*.py":  "ruff",
    "*.ts":  "prettier"
  }
}
```

The extension runs `<command> -- <file>` on each edited file.

### `commands`

A map of short names to executable + argument arrays.

```json
"commands": {
  "my-formatter": ["tool", "--flag", "--option value"]
}
```

### `filetypes`

A map of file patterns to command names. Patterns are checked in order — more specific patterns first, then the `"*"` fallback.

| Pattern | Meaning |
|---------|---------|
| `"*"` | Match all files (fallback) |
| `"*.ts"` | Files ending in `.ts` |
| `".rs$"` | Regex: files ending in `.rs` |
| `"/\.py$/"` | Explicit regex pattern |

If no formatter matches  file, the extension skips it entirely.

## Limitations

- **Parallel edits to the same file:** If the model makes two separate `edit` calls to the same file in one turn, the formatter runs between them. The second edit is applied to the already-formatted file. In practice the model nearly always uses one `edit` with multiple `edits[]` entries per file.

## Troubleshooting

This is a vibe coded project. Try [asking Devin](https://deepwiki.com/losnappas/pi-code-formatter) first.
