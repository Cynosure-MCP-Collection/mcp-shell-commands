import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { config, FORCE_KILL_DELAY_MS, type ShellConfig } from './config.js';
import { OutputBuffer } from './output-buffer.js';

type ProcessMode = 'pipes' | 'pty';
type ProcessStatus = 'running' | 'exited' | 'error';
type TerminationReason = 'exit' | 'signal' | 'timeout' | 'cancelled' | 'idle_timeout' | 'terminated' | 'killed' | null;
type ControlSignal = 'interrupt' | 'terminate' | 'kill';

interface PtyProcess {
  pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): { dispose(): void };
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void };
}

interface PtyModule {
  spawn(file: string, args: string[], options: object): PtyProcess;
}

type PtyLoader = () => Promise<PtyModule>;

async function loadOptionalPty(): Promise<PtyModule> {
  const moduleName = 'node-pty';
  return await import(moduleName) as PtyModule;
}

interface Session {
  id: string;
  mode: ProcessMode;
  startedAt: number;
  exposed: boolean;
  stdinClosed: boolean;
  child?: ChildProcessWithoutNullStreams;
  pty?: PtyProcess;
  stdout: OutputBuffer;
  stderr: OutputBuffer;
  output: OutputBuffer;
  events: EventEmitter;
  exitCode: number | null;
  signal: string | null;
  exited: boolean;
  terminationReason: TerminationReason;
  error: string | null;
  timeout?: NodeJS.Timeout;
  idleTimer?: NodeJS.Timeout;
  idleDeadline?: number;
  forceKillTimer?: NodeJS.Timeout;
  operationQueue: Promise<void>;
}

export interface ExecuteOptions {
  command: string;
  cwd?: string;
  yieldTimeMs: number;
  timeoutMs?: number;
  stdin?: string;
  closeStdin?: boolean;
  environment?: Record<string, string>;
  unsetEnvironment?: string[];
  pty: boolean;
  columns: number;
  rows: number;
}

export interface InteractOptions {
  sessionId: string;
  input?: string;
  closeStdin: boolean;
  signal?: ControlSignal;
  yieldTimeMs: number;
  columns?: number;
  rows?: number;
}

export interface ProcessResult extends Record<string, unknown> {
  mode: ProcessMode | null;
  status: ProcessStatus;
  session_id: string | null;
  exit_code: number | null;
  signal: string | null;
  termination_reason: TerminationReason;
  duration_ms: number;
  stdout: string | null;
  stderr: string | null;
  output: string | null;
  truncated: boolean;
  dropped_bytes: { stdout: number; stderr: number; output: number };
  error: string | null;
}

export class ProcessManager {
  private readonly sessions = new Map<string, Session>();
  private shuttingDown = false;

  constructor(
    private readonly settings: ShellConfig = config,
    private readonly ptyLoader: PtyLoader = loadOptionalPty,
  ) {}

  async execute(options: ExecuteOptions, abortSignal?: AbortSignal): Promise<ProcessResult> {
    if (this.shuttingDown) return this.errorResult('The shell process manager is shutting down.');
    if (this.runningCount() >= this.settings.maxConcurrentProcesses) {
      return this.errorResult(`At most ${this.settings.maxConcurrentProcesses} concurrent processes are allowed.`);
    }

    const session = this.createSession(options.pty);
    this.sessions.set(session.id, session);

    try {
      const cwd = await this.resolveWorkingDirectory(options.cwd);
      if (this.shuttingDown || this.sessions.get(session.id) !== session) {
        throw new Error('The shell process manager is shutting down.');
      }
      const environment: NodeJS.ProcessEnv = { ...process.env, ...options.environment };
      for (const name of options.unsetEnvironment ?? []) delete environment[name];

      if (options.pty) await this.spawnPty(session, options, cwd, environment);
      else this.spawnPipes(session, options, cwd, environment);

      if (options.timeoutMs !== undefined) {
        session.timeout = setTimeout(() => this.stop(session, 'timeout', 'SIGTERM', true), options.timeoutMs);
        session.timeout.unref();
      }

      const aborted = await this.waitForExit(session, options.yieldTimeMs, abortSignal);
      if (aborted && !session.exited) await this.stopAndWait(session, 'cancelled', 'SIGTERM', true);

      if (session.exited) {
        const result = this.snapshot(session, false);
        this.removeSession(session);
        return result;
      }

      session.exposed = true;
      this.scheduleIdleExpiry(session);
      return this.snapshot(session, true);
    } catch (error) {
      if (!session.exited && (session.child || session.pty)) {
        await this.stopAndWait(session, 'terminated', 'SIGTERM', true);
      }
      this.removeSession(session);
      return this.errorResult(this.errorMessage(error), options.pty ? 'pty' : 'pipes');
    }
  }

  async interact(options: InteractOptions, abortSignal?: AbortSignal): Promise<ProcessResult> {
    const session = this.sessions.get(options.sessionId);
    if (!session || !session.exposed) return this.errorResult(`Unknown process session: ${options.sessionId}`);

    return this.withSessionLock(session, async () => {
      if (this.sessions.get(session.id) !== session) return this.errorResult(`Unknown process session: ${options.sessionId}`);
      this.touch(session);

      if (options.signal && (options.input !== undefined || options.closeStdin)) {
        return this.errorResult('signal cannot be combined with input or close_stdin.', session.mode);
      }
      if ((options.columns === undefined) !== (options.rows === undefined)) {
        return this.errorResult('columns and rows must be supplied together.', session.mode);
      }
      if ((options.columns !== undefined || options.rows !== undefined) && session.mode !== 'pty') {
        return this.errorResult('Terminal resize is only available for PTY sessions.', session.mode);
      }
      if (options.closeStdin && session.mode === 'pty') {
        return this.errorResult('PTY sessions do not support close_stdin; send the appropriate terminal control character instead.', session.mode);
      }

      if (!session.exited) {
        if (options.columns !== undefined && options.rows !== undefined) session.pty?.resize(options.columns, options.rows);
        if (options.input !== undefined && session.stdinClosed) {
          return this.errorResult('Process stdin is already closed.', session.mode);
        }
        if (options.input !== undefined) this.write(session, options.input);
        if (options.closeStdin) {
          session.child?.stdin.end();
          session.stdinClosed = true;
        }
        if (options.signal) {
          const signal = options.signal === 'interrupt' ? 'SIGINT' : options.signal === 'terminate' ? 'SIGTERM' : 'SIGKILL';
          const reason: TerminationReason = options.signal === 'kill' ? 'killed' : 'terminated';
          this.stop(session, reason, signal, options.signal === 'terminate');
        }
      }

      if (!session.exited && !this.hasOutput(session)) await this.waitForActivity(session, options.yieldTimeMs, abortSignal);

      const result = this.snapshot(session, !session.exited);
      if (session.exited) this.removeSession(session);
      return result;
    });
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const running = [...this.sessions.values()].filter(session => !session.exited && (session.child || session.pty));
    await Promise.all(running.map(session => this.stopAndWait(session, 'terminated', 'SIGTERM', true)));
    for (const session of [...this.sessions.values()]) this.removeSession(session);
  }

  private createSession(pty: boolean): Session {
    return {
      id: randomUUID(),
      mode: pty ? 'pty' : 'pipes',
      startedAt: Date.now(),
      exposed: false,
      stdinClosed: false,
      stdout: new OutputBuffer(this.settings.maxOutputBytes),
      stderr: new OutputBuffer(this.settings.maxOutputBytes),
      output: new OutputBuffer(this.settings.maxOutputBytes),
      events: new EventEmitter(),
      exitCode: null,
      signal: null,
      exited: false,
      terminationReason: null,
      error: null,
      operationQueue: Promise.resolve(),
    };
  }

  private spawnPipes(session: Session, options: ExecuteOptions, cwd: string, environment: NodeJS.ProcessEnv): void {
    const child = spawn(this.settings.shell, ['-c', options.command], {
      cwd,
      env: environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    session.child = child;
    child.stdout.on('data', (chunk: Buffer) => this.append(session, session.stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => this.append(session, session.stderr, chunk));
    child.stdin.on('error', () => {
      // EPIPE and write-after-exit races are reflected by process status/output.
    });
    child.once('error', error => this.finish(session, null, null, error.message));
    child.once('close', (exitCode, signal) => this.finish(session, exitCode, signal));

    if (options.stdin !== undefined) {
      if (options.closeStdin ?? true) {
        child.stdin.end(options.stdin);
        session.stdinClosed = true;
      }
      else child.stdin.write(options.stdin);
    } else if (options.closeStdin ?? true) {
      child.stdin.end();
      session.stdinClosed = true;
    }
  }

  private async spawnPty(session: Session, options: ExecuteOptions, cwd: string, environment: NodeJS.ProcessEnv): Promise<void> {
    let ptyModule: PtyModule;
    try {
      ptyModule = await this.ptyLoader();
    } catch {
      throw new Error('PTY support is unavailable. Install the optional node-pty dependency or use pty: false.');
    }
    if (options.closeStdin === true) {
      throw new Error('PTY sessions do not support close_stdin; send the appropriate terminal control character instead.');
    }

    const terminal = ptyModule.spawn(this.settings.shell, ['-c', options.command], {
      name: 'xterm-256color',
      cols: options.columns,
      rows: options.rows,
      cwd,
      env: environment as Record<string, string>,
    });
    session.pty = terminal;
    terminal.onData(data => this.append(session, session.output, data));
    terminal.onExit(({ exitCode, signal }) => this.finish(session, exitCode, signal === undefined ? null : String(signal)));
    if (options.stdin !== undefined) terminal.write(options.stdin);
  }

  private append(session: Session, buffer: OutputBuffer, data: Buffer | string): void {
    buffer.append(data);
    session.events.emit('activity');
  }

  private finish(session: Session, exitCode: number | null, signal: string | null, error?: string): void {
    if (session.exited) return;
    session.exited = true;
    session.exitCode = exitCode;
    session.signal = signal;
    session.error = error ?? null;
    if (!session.terminationReason) session.terminationReason = signal ? 'signal' : 'exit';
    this.clearRuntimeTimers(session);
    session.events.emit('activity');
  }

  private stop(
    session: Session,
    reason: Exclude<TerminationReason, 'exit' | 'signal' | null>,
    signal: NodeJS.Signals,
    escalate: boolean,
  ): void {
    if (session.exited) return;
    session.terminationReason = reason;
    this.sendSignal(session, signal);
    if (escalate && signal !== 'SIGKILL' && !session.forceKillTimer) {
      session.forceKillTimer = setTimeout(() => this.sendSignal(session, 'SIGKILL'), FORCE_KILL_DELAY_MS);
      session.forceKillTimer.unref();
    }
  }

  private async stopAndWait(
    session: Session,
    reason: Exclude<TerminationReason, 'exit' | 'signal' | null>,
    signal: NodeJS.Signals,
    escalate: boolean,
  ): Promise<void> {
    this.stop(session, reason, signal, escalate);
    if (!session.exited) await this.waitForExit(session, FORCE_KILL_DELAY_MS + 2_000);
    if (!session.exited) {
      this.sendSignal(session, 'SIGKILL');
      await this.waitForExit(session, 1_000);
    }
  }

  private sendSignal(session: Session, signal: NodeJS.Signals): void {
    try {
      if (session.pty) session.pty.kill(process.platform === 'win32' ? undefined : signal);
      else if (session.child?.pid) {
        if (process.platform === 'win32') session.child.kill(signal);
        else process.kill(-session.child.pid, signal);
      }
    } catch {
      // The process may already have exited.
    }
  }

  private write(session: Session, input: string): void {
    if (session.mode === 'pty') session.pty?.write(input);
    else session.child?.stdin.write(input);
  }

  private waitForExit(session: Session, milliseconds: number, signal?: AbortSignal): Promise<boolean> {
    if (session.exited) return Promise.resolve(false);
    return new Promise(resolve => {
      let aborted = false;
      const timer = setTimeout(done, milliseconds);
      const onActivity = () => {
        if (session.exited) done();
      };
      const onAbort = () => {
        aborted = true;
        done();
      };
      function done() {
        clearTimeout(timer);
        session.events.removeListener('activity', onActivity);
        signal?.removeEventListener('abort', onAbort);
        resolve(aborted);
      }
      session.events.on('activity', onActivity);
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  }

  private waitForActivity(session: Session, milliseconds: number, signal?: AbortSignal): Promise<void> {
    if (session.exited || this.hasOutput(session) || signal?.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const timer = setTimeout(done, milliseconds);
      const onAbort = () => done();
      function done() {
        clearTimeout(timer);
        session.events.removeListener('activity', done);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      session.events.once('activity', done);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private snapshot(session: Session, includeSessionId: boolean): ProcessResult {
    const stdout = session.stdout.drain();
    const stderr = session.stderr.drain();
    const output = session.output.drain();
    const dropped = { stdout: stdout.droppedBytes, stderr: stderr.droppedBytes, output: output.droppedBytes };
    return {
      mode: session.mode,
      status: session.error ? 'error' : session.exited ? 'exited' : 'running',
      session_id: includeSessionId ? session.id : null,
      exit_code: session.exitCode,
      signal: session.signal,
      termination_reason: session.exited ? session.terminationReason : null,
      duration_ms: Date.now() - session.startedAt,
      stdout: session.mode === 'pipes' ? stdout.text : null,
      stderr: session.mode === 'pipes' ? stderr.text : null,
      output: session.mode === 'pty' ? output.text : null,
      truncated: dropped.stdout > 0 || dropped.stderr > 0 || dropped.output > 0,
      dropped_bytes: dropped,
      error: session.error,
    };
  }

  private errorResult(message: string, mode: ProcessMode | null = null): ProcessResult {
    return {
      mode,
      status: 'error',
      session_id: null,
      exit_code: null,
      signal: null,
      termination_reason: null,
      duration_ms: 0,
      stdout: mode === 'pipes' ? '' : null,
      stderr: mode === 'pipes' ? '' : null,
      output: mode === 'pty' ? '' : null,
      truncated: false,
      dropped_bytes: { stdout: 0, stderr: 0, output: 0 },
      error: message,
    };
  }

  private hasOutput(session: Session): boolean {
    return session.stdout.hasData || session.stderr.hasData || session.output.hasData;
  }

  private touch(session: Session): void {
    this.scheduleIdleExpiry(session);
  }

  private scheduleIdleExpiry(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleDeadline = Date.now() + this.settings.sessionIdleTimeoutMs;
    this.armIdleTimer(session, this.settings.sessionIdleTimeoutMs);
  }

  private armIdleTimer(session: Session, delayMs: number): void {
    session.idleTimer = setTimeout(() => void this.withSessionLock(session, async () => {
      if (this.sessions.get(session.id) !== session) return;
      const remaining = (session.idleDeadline ?? 0) - Date.now();
      if (remaining > 0) {
        this.armIdleTimer(session, remaining);
        return;
      }
      if (!session.exited) await this.stopAndWait(session, 'idle_timeout', 'SIGTERM', true);
      this.removeSession(session);
    }), delayMs);
    session.idleTimer.unref();
  }

  private async withSessionLock<T>(session: Session, operation: () => Promise<T>): Promise<T> {
    const previous = session.operationQueue;
    let release!: () => void;
    session.operationQueue = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private clearRuntimeTimers(session: Session): void {
    if (session.timeout) clearTimeout(session.timeout);
    if (session.forceKillTimer) clearTimeout(session.forceKillTimer);
    session.timeout = undefined;
    session.forceKillTimer = undefined;
  }

  private removeSession(session: Session): void {
    this.clearRuntimeTimers(session);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.events.removeAllListeners();
    if (this.sessions.get(session.id) === session) this.sessions.delete(session.id);
  }

  private runningCount(): number {
    let count = 0;
    for (const session of this.sessions.values()) if (!session.exited) count += 1;
    return count;
  }

  private async resolveWorkingDirectory(input?: string): Promise<string> {
    const resolved = await fs.realpath(input ?? process.cwd());
    const stats = await fs.stat(resolved);
    if (!stats.isDirectory()) throw new Error(`Working directory is not a directory: ${input}`);
    return resolved;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
