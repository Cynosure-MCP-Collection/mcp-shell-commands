# Shell Commands MCP

MCP server for running Bash commands with configurable working directories, timeouts, environment overrides, stdin, and bounded output capture.

## Security

This server intentionally provides arbitrary command execution with the permissions of its operating-system process. The allowed-directory setting restricts the initial working directory only; it is not a filesystem sandbox and commands can access other paths, programs, credentials, and the network available to that process. Run the server in a container or restricted OS account when it will handle untrusted requests.

## Configuration

By default, commands start in the server process's current working directory and use `/bin/bash` (`bash` from `PATH` on Windows).

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHELL_COMMANDS_ALLOWED_DIRECTORIES` | Current working directory | Platform path-list of permitted starting directories (`:` on Linux/macOS, `;` on Windows) |
| `SHELL_COMMANDS_SHELL` | `/bin/bash` | Bash-compatible shell executable |
| `SHELL_COMMANDS_DEFAULT_TIMEOUT_MS` | `120000` | Default timeout, from 100 ms to the configured maximum |
| `SHELL_COMMANDS_MAX_TIMEOUT_MS` | `600000` | Maximum timeout, capped at 3600000 ms |
| `SHELL_COMMANDS_MAX_OUTPUT_BYTES` | `262144` | Maximum bytes retained separately for stdout and stderr, capped at 10485760 |

Example:

```bash
SHELL_COMMANDS_ALLOWED_DIRECTORIES="/path/to/project:/path/to/another-project" \
SHELL_COMMANDS_MAX_TIMEOUT_MS=900000 \
npx -y @cynosure-mcp/shell-commands
```

## Tools

- `execute_shell_command` runs one Bash command string. It accepts an optional working directory, timeout, stdin text, environment overrides, and environment-variable names to unset. It returns the exit code or terminating signal plus captured stdout and stderr.
- `get_shell_configuration` reports the effective shell path, allowed starting directories, timeout limits, and output limit without exposing environment values.

Commands run via `bash -lc`, so pipelines, redirects, conditionals, and shell built-ins are available. If a command times out or the MCP request is cancelled, the server terminates its process group where the platform supports it. Output beyond the configured limit is discarded and marked as truncated.

## Development

```bash
npm install
npm run build
npm run dev
```
