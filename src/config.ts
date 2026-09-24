export const VERSION = '0.2.0';

function boundedInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

export const MIN_YIELD_MS = 250;
export const MAX_YIELD_MS = 30_000;
export const DEFAULT_YIELD_MS = 10_000;
export const MAX_RUNTIME_MS = 24 * 60 * 60 * 1_000;
export const FORCE_KILL_DELAY_MS = 1_000;

export const config = {
  shell: process.env.SHELL_COMMANDS_SHELL || (process.platform === 'win32' ? 'bash' : '/bin/bash'),
  maxOutputBytes: boundedInteger('SHELL_COMMANDS_MAX_OUTPUT_BYTES', 256 * 1024, 1024, 10 * 1024 * 1024),
  sessionIdleTimeoutMs: boundedInteger(
    'SHELL_COMMANDS_SESSION_IDLE_TIMEOUT_MS',
    10 * 60 * 1_000,
    5_000,
    24 * 60 * 60 * 1_000,
  ),
  maxConcurrentProcesses: boundedInteger('SHELL_COMMANDS_MAX_CONCURRENT_PROCESSES', 8, 1, 64),
};

export type ShellConfig = typeof config;
