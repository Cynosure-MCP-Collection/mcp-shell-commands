# Shell Commands MCP

MCP server for running Bash commands and interacting with managed long-running or terminal processes.

## Security and authorization

This server intentionally provides arbitrary command execution with the permissions of its operating-system process. It does not parse commands, restrict paths, or provide a filesystem or network sandbox. Authorization is expected to be handled by the MCP client's human-in-the-loop gate. Run the server in a container or restricted OS account when requests are not fully trusted.

Linux and macOS are the supported platforms. Pipe mode may work on Windows when a Bash-compatible shell is installed, and PTY mode uses ConPTY where `node-pty` supports it, but Windows process-tree cleanup is currently best-effort.

## Tools

### `exec_command`

Starts one command using `bash -c`. Short commands return their final output directly. If a command is still running after `yield_time_ms`, the result has status `running` and includes a `session_id` for later calls.

Inputs include:

- `command` and optional `cwd`
- `yield_time_ms` from 250 to 30000, defaulting to 10000
- optional `timeout_ms`; omitted means no absolute runtime limit
- initial `stdin`, environment overrides, and inherited variables to unset
- `close_stdin`, defaulting to true for pipes and false for PTYs
- `pty`, with optional terminal `columns` and `rows`

### `interact_with_process`

Uses a returned `session_id` to retrieve incremental output, send exact input, close pipe stdin, resize a PTY, or send `interrupt`, `terminate`, or `kill`. Input is written exactly as supplied; callers must include newlines or control characters themselves.

Pipe processes return separate `stdout` and `stderr`. PTY processes return merged `output`. Both tools also return validated structured data describing status, exit code, signal, duration, termination reason, and dropped output.

## Long-running process lifecycle

Managed sessions expire after ten minutes without a poll or input by default. Output activity does not reset that deadline. Explicit termination and idle expiry send `SIGTERM`, then `SIGKILL` after one second on POSIX. All sessions are also stopped when the MCP transport or server shuts down.

Output is retained incrementally. If unread output exceeds the configured limit, the oldest bytes are discarded so recent logs and final errors remain available; results report the number of discarded bytes.

PTY support is provided by the optional native `node-pty` dependency. A failed optional installation does not disable pipe execution; requesting `pty: true` will instead return an actionable error.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHELL_COMMANDS_SHELL` | `/bin/bash` | Bash-compatible shell executable (`bash` from `PATH` on Windows) |
| `SHELL_COMMANDS_MAX_OUTPUT_BYTES` | `262144` | Maximum unread bytes retained per output stream, from 1024 to 10485760 |
| `SHELL_COMMANDS_SESSION_IDLE_TIMEOUT_MS` | `600000` | Session idle lifetime, from 5000 to 86400000 ms |
| `SHELL_COMMANDS_MAX_CONCURRENT_PROCESSES` | `8` | Maximum concurrently running processes, from 1 to 64 |

Example:

```bash
SHELL_COMMANDS_SESSION_IDLE_TIMEOUT_MS=1800000 \
SHELL_COMMANDS_MAX_CONCURRENT_PROCESSES=4 \
npx -y @cynosure-mcp/shell-commands
```

## Development

```bash
npm install
npm test
```
