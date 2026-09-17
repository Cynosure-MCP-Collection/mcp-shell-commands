#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const VERSION = '0.1.0';
const MIN_TIMEOUT_MS = 100;
const ABSOLUTE_MAX_TIMEOUT_MS = 3_600_000;
const DEFAULT_TIMEOUT_MS = boundedInteger('SHELL_COMMANDS_DEFAULT_TIMEOUT_MS', 120_000, MIN_TIMEOUT_MS, ABSOLUTE_MAX_TIMEOUT_MS);
const MAX_TIMEOUT_MS = boundedInteger('SHELL_COMMANDS_MAX_TIMEOUT_MS', 600_000, MIN_TIMEOUT_MS, ABSOLUTE_MAX_TIMEOUT_MS);
const MAX_OUTPUT_BYTES = boundedInteger('SHELL_COMMANDS_MAX_OUTPUT_BYTES', 256 * 1024, 1024, 10 * 1024 * 1024);
const SHELL = process.env.SHELL_COMMANDS_SHELL || (process.platform === 'win32' ? 'bash' : '/bin/bash');

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function configuredAllowedDirectories(): string[] {
  const configured = process.env.SHELL_COMMANDS_ALLOWED_DIRECTORIES;
  const directories = configured
    ? configured.split(path.delimiter).map(value => value.trim()).filter(Boolean)
    : [process.cwd()];
  return [...new Set(directories.map(directory => path.resolve(directory)))];
}

const ALLOWED_DIRECTORIES = configuredAllowedDirectories();

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

async function resolveWorkingDirectory(input?: string): Promise<string> {
  const requested = path.resolve(input || process.cwd());
  const resolved = await fs.realpath(requested);
  const stats = await fs.stat(resolved);
  if (!stats.isDirectory()) throw new Error(`Working directory is not a directory: ${input}`);

  for (const configuredRoot of ALLOWED_DIRECTORIES) {
    let root: string;
    try {
      root = await fs.realpath(configuredRoot);
    } catch {
      continue;
    }
    if (isWithin(root, resolved)) return resolved;
  }

  throw new Error(`Working directory is outside SHELL_COMMANDS_ALLOWED_DIRECTORIES: ${input || process.cwd()}`);
}

interface CapturedStream {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function captureChunk(stream: CapturedStream, chunk: Buffer): void {
  const remaining = MAX_OUTPUT_BYTES - stream.bytes;
  if (remaining <= 0) {
    stream.truncated = true;
    return;
  }
  if (chunk.length > remaining) {
    stream.chunks.push(chunk.subarray(0, remaining));
    stream.bytes += remaining;
    stream.truncated = true;
    return;
  }
  stream.chunks.push(chunk);
  stream.bytes += chunk.length;
}

function streamText(stream: CapturedStream): string {
  const text = Buffer.concat(stream.chunks).toString('utf8');
  return stream.truncated ? `${text}\n[output truncated after ${MAX_OUTPUT_BYTES} bytes]` : text;
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch {
    // The process may already have exited.
  }
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
}

async function runCommand(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  stdin?: string;
  environment?: Record<string, string>;
  unsetEnvironment?: string[];
  abortSignal?: AbortSignal;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const environment: NodeJS.ProcessEnv = { ...process.env, ...options.environment };
    for (const name of options.unsetEnvironment || []) delete environment[name];

    const stdout: CapturedStream = { chunks: [], bytes: 0, truncated: false };
    const stderr: CapturedStream = { chunks: [], bytes: 0, truncated: false };
    const startedAt = Date.now();
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    let stopping = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = spawn(SHELL, ['-lc', options.command], {
      cwd: options.cwd,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (chunk: Buffer) => captureChunk(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => captureChunk(stderr, chunk));

    const stop = (reason: 'timeout' | 'cancelled') => {
      if (settled || stopping) return;
      stopping = true;
      timedOut = reason === 'timeout';
      cancelled = reason === 'cancelled';
      terminateProcess(child.pid, 'SIGTERM');
      forceKillTimer = setTimeout(() => terminateProcess(child.pid, 'SIGKILL'), 1_000);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => stop('timeout'), options.timeoutMs);
    timeout.unref();
    const onAbort = () => stop('cancelled');
    options.abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (options.abortSignal?.aborted) onAbort();

    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.abortSignal?.removeEventListener('abort', onAbort);
      reject(error);
    });

    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      options.abortSignal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode,
        signal,
        stdout: streamText(stdout),
        stderr: streamText(stderr),
        timedOut,
        cancelled,
        durationMs: Date.now() - startedAt,
      });
    });

    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

function formatResult(command: string, cwd: string, result: CommandResult): string {
  const status = result.timedOut
    ? 'timed out'
    : result.cancelled
      ? 'cancelled'
      : result.signal
        ? `terminated by ${result.signal}`
        : `exited with code ${result.exitCode}`;
  const stdout = result.stdout || '(empty)';
  const stderr = result.stderr || '(empty)';
  return [
    `Command ${status} after ${result.durationMs} ms.`,
    `Working directory: ${cwd}`,
    `Command: ${command}`,
    '',
    'stdout:',
    stdout,
    '',
    'stderr:',
    stderr,
  ].join('\n');
}

const EnvironmentSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  z.string().max(131_072),
).refine(value => Object.keys(value).length <= 100, 'At most 100 environment variables may be supplied.');

const UnsetEnvironmentSchema = z.array(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
).max(100);

const server = new McpServer({
  name: '@cynosure-mcp/shell-commands',
  title: 'Shell Commands',
  version: VERSION,
  description: 'Run Bash shell commands with configurable working directories, timeouts, environment values, stdin, and bounded output.',
  icons: [{ src: `https://unpkg.com/@cynosure-mcp/shell-commands@${VERSION}/icon.png`, mimeType: 'image/png' }],
});

server.registerTool('execute_shell_command', {
  title: 'Execute Shell Command',
  description: 'Run one command string through Bash. Supports shell syntax including pipelines, redirects, conditionals, and built-ins. Commands have the full operating-system permissions of this MCP server.',
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  inputSchema: {
    command: z.string().min(1).max(131_072).describe('Bash command string to execute.'),
    cwd: z.string().optional().describe('Starting working directory. Must be within a configured allowed directory. Defaults to the server working directory.'),
    timeout_ms: z.number().int().min(MIN_TIMEOUT_MS).max(MAX_TIMEOUT_MS).default(Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)).describe(`Timeout in milliseconds (maximum ${MAX_TIMEOUT_MS}).`),
    stdin: z.string().max(1_048_576).optional().describe('Optional UTF-8 text sent to the command on standard input.'),
    environment: EnvironmentSchema.optional().describe('Environment variables to add or override for this command.'),
    unset_environment: UnsetEnvironmentSchema.optional().describe('Inherited environment-variable names to remove for this command.'),
  },
}, async ({ command, cwd, timeout_ms, stdin, environment, unset_environment }, extra) => {
  try {
    const resolvedCwd = await resolveWorkingDirectory(cwd);
    const result = await runCommand({
      command,
      cwd: resolvedCwd,
      timeoutMs: timeout_ms,
      stdin,
      environment,
      unsetEnvironment: unset_environment,
      abortSignal: extra.signal,
    });
    return {
      content: [{ type: 'text', text: formatResult(command, resolvedCwd, result) }],
      isError: result.timedOut || result.cancelled || result.exitCode !== 0,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
});

server.registerTool('get_shell_configuration', {
  title: 'Get Shell Configuration',
  description: 'Report the effective shell-command limits and permitted starting directories. Environment values are not included.',
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputSchema: {},
}, async () => ({
  content: [{
    type: 'text',
    text: JSON.stringify({
      shell: SHELL,
      allowedDirectories: ALLOWED_DIRECTORIES,
      defaultTimeoutMs: Math.min(DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      maximumTimeoutMs: MAX_TIMEOUT_MS,
      maximumOutputBytesPerStream: MAX_OUTPUT_BYTES,
    }, null, 2),
  }],
}));

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`Shell Commands MCP ${VERSION} ready\n`);
}

main().catch(error => {
  process.stderr.write(`Shell Commands MCP failed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exit(1);
});
