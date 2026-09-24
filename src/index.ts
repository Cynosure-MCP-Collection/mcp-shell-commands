#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  config,
  DEFAULT_YIELD_MS,
  MAX_RUNTIME_MS,
  MAX_YIELD_MS,
  MIN_YIELD_MS,
  VERSION,
} from './config.js';
import { ProcessManager, type ProcessResult } from './process-manager.js';

const EnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(131_072),
).refine(value => Object.keys(value).length <= 100, 'At most 100 environment variables may be supplied.');

const UnsetEnvironmentSchema = z.array(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
).max(100);

const ResultSchema = z.object({
  mode: z.enum(['pipes', 'pty']).nullable(),
  status: z.enum(['running', 'exited', 'error']),
  session_id: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  signal: z.string().nullable(),
  termination_reason: z.enum(['exit', 'signal', 'timeout', 'cancelled', 'idle_timeout', 'terminated', 'killed']).nullable(),
  duration_ms: z.number().int().nonnegative(),
  stdout: z.string().nullable(),
  stderr: z.string().nullable(),
  output: z.string().nullable(),
  truncated: z.boolean(),
  dropped_bytes: z.object({ stdout: z.number().int(), stderr: z.number().int(), output: z.number().int() }),
  error: z.string().nullable(),
});

export function formatResult(result: ProcessResult): string {
  if (result.status === 'error') return `Error: ${result.error ?? 'Unknown process error'}`;
  const chunks: string[] = [];
  if (result.mode === 'pipes') {
    if (result.stdout) chunks.push(result.stdout);
    if (result.stderr) chunks.push(`stderr:\n${result.stderr}`);
  } else if (result.output) chunks.push(result.output);

  if (result.truncated) {
    const total = result.dropped_bytes.stdout + result.dropped_bytes.stderr + result.dropped_bytes.output;
    chunks.push(`[${total} earlier output bytes dropped]`);
  }
  if (result.status === 'running') chunks.push(`[process running; session_id=${result.session_id}]`);
  else {
    const completion = result.termination_reason === 'exit'
      ? `exit code ${result.exit_code}`
      : `${result.termination_reason}${result.signal ? ` (${result.signal})` : ''}`;
    chunks.push(`[process completed: ${completion}; ${result.duration_ms} ms]`);
  }
  return chunks.join('\n');
}

function toolResult(result: ProcessResult) {
  const failed = result.status === 'error'
    || (result.status === 'exited' && (result.termination_reason !== 'exit' || result.exit_code !== 0));
  return {
    content: [{ type: 'text' as const, text: formatResult(result) }],
    structuredContent: result,
    isError: failed,
  };
}

export function createServer(manager = new ProcessManager()): McpServer {
  const server = new McpServer({
    name: '@cynosure-mcp/shell-commands',
    title: 'Shell Commands',
    version: VERSION,
    description: 'Run Bash commands and interact with managed long-running or terminal processes.',
    icons: [{ src: `https://unpkg.com/@cynosure-mcp/shell-commands@${VERSION}/icon.png`, mimeType: 'image/png' }],
  }, {
    instructions: `Use exec_command to start Bash commands. It returns a session_id when a command is still running; pass that ID to interact_with_process to poll output, write stdin, resize a PTY, or stop it. Output is bounded to ${config.maxOutputBytes} bytes per stream and sessions expire after ${config.sessionIdleTimeoutMs} ms without interaction. Commands have the full OS permissions of this server.`,
  });

  server.registerTool('exec_command', {
    title: 'Execute Command',
    description: `Run a command with ${config.shell} -c. Returns on completion or after yield-time with a managed session ID. At most ${config.maxConcurrentProcesses} processes may run concurrently.`,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      command: z.string().min(1).max(131_072).describe('Bash command string to execute.'),
      cwd: z.string().optional().describe('Existing starting working directory. Defaults to the server working directory.'),
      yield_time_ms: z.number().int().min(MIN_YIELD_MS).max(MAX_YIELD_MS).default(DEFAULT_YIELD_MS).describe('How long to wait for completion before returning a managed session.'),
      timeout_ms: z.number().int().min(100).max(MAX_RUNTIME_MS).optional().describe('Optional absolute runtime limit. Omit for no runtime limit.'),
      stdin: z.string().max(1_048_576).optional().describe('Initial UTF-8 text written exactly as supplied.'),
      close_stdin: z.boolean().optional().describe('Close stdin after initial input. Defaults to true for pipes and false for PTY mode.'),
      environment: EnvironmentSchema.optional().describe('Environment variables to add or override.'),
      unset_environment: UnsetEnvironmentSchema.optional().describe('Inherited environment-variable names to remove.'),
      pty: z.boolean().default(false).describe('Use an interactive pseudo-terminal. Requires the optional node-pty dependency.'),
      columns: z.number().int().min(20).max(500).default(120).describe('PTY width in columns.'),
      rows: z.number().int().min(5).max(200).default(30).describe('PTY height in rows.'),
    }),
    outputSchema: ResultSchema,
  }, async (args, extra) => toolResult(await manager.execute({
    command: args.command,
    cwd: args.cwd,
    yieldTimeMs: args.yield_time_ms,
    timeoutMs: args.timeout_ms,
    stdin: args.stdin,
    closeStdin: args.close_stdin,
    environment: args.environment,
    unsetEnvironment: args.unset_environment,
    pty: args.pty,
    columns: args.columns,
    rows: args.rows,
  }, extra.signal)));

  server.registerTool('interact_with_process', {
    title: 'Interact with Process',
    description: 'Poll incremental output from a managed process, write exact input, close pipe stdin, resize a PTY, or send a control signal.',
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    inputSchema: z.object({
      session_id: z.string().uuid().describe('Session ID returned by exec_command.'),
      input: z.string().max(1_048_576).optional().describe('UTF-8 text written exactly as supplied; no newline is added.'),
      close_stdin: z.boolean().default(false).describe('Close stdin for a pipe-mode process after any input.'),
      signal: z.enum(['interrupt', 'terminate', 'kill']).optional().describe('Signal the process instead of writing input.'),
      yield_time_ms: z.number().int().min(MIN_YIELD_MS).max(MAX_YIELD_MS).default(1_000).describe('How long to wait for new output or process exit.'),
      columns: z.number().int().min(20).max(500).optional().describe('New PTY width; must be supplied with rows.'),
      rows: z.number().int().min(5).max(200).optional().describe('New PTY height; must be supplied with columns.'),
    }),
    outputSchema: ResultSchema,
  }, async (args, extra) => toolResult(await manager.interact({
    sessionId: args.session_id,
    input: args.input,
    closeStdin: args.close_stdin,
    signal: args.signal,
    yieldTimeMs: args.yield_time_ms,
    columns: args.columns,
    rows: args.rows,
  }, extra.signal)));

  return server;
}

async function main(): Promise<void> {
  const manager = new ProcessManager();
  const server = createServer(manager);
  const transport = new StdioServerTransport();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    await manager.shutdown();
  };
  server.server.onclose = () => void shutdown();
  process.once('SIGINT', () => void shutdown().finally(() => process.exit(130)));
  process.once('SIGTERM', () => void shutdown().finally(() => process.exit(143)));
  process.stdin.once('end', () => void shutdown());
  await server.connect(transport);
  process.stderr.write(`Shell Commands MCP ${VERSION} ready\n`);
}

const isEntrypoint = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntrypoint) {
  main().catch(error => {
    process.stderr.write(`Shell Commands MCP failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exit(1);
  });
}
