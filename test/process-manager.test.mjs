import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../dist/config.js';
import { OutputBuffer } from '../dist/output-buffer.js';
import { ProcessManager } from '../dist/process-manager.js';

function settings(overrides = {}) {
  return { ...config, sessionIdleTimeoutMs: 5_000, ...overrides };
}

function command(overrides = {}) {
  return {
    command: 'true',
    yieldTimeMs: 1_000,
    pty: false,
    columns: 120,
    rows: 30,
    ...overrides,
  };
}

async function pollUntilExited(manager, sessionId, initial = '') {
  let output = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = await manager.interact({
      sessionId,
      closeStdin: false,
      yieldTimeMs: 1_000,
    });
    output += result.stdout ?? result.output ?? '';
    if (result.status !== 'running') return { result, output };
  }
  assert.fail('Process did not exit after polling');
}

test('output buffer keeps recent bytes and reports discarded bytes', () => {
  const buffer = new OutputBuffer(8);
  buffer.append('01234');
  buffer.append('56789');
  assert.deepEqual(buffer.drain(), { text: '23456789', droppedBytes: 2 });
  assert.deepEqual(buffer.drain(), { text: '', droppedBytes: 0 });
});

test('output buffer does not begin retained UTF-8 with a partial code point', () => {
  const buffer = new OutputBuffer(7);
  buffer.append('αβγδε');
  assert.deepEqual(buffer.drain(), { text: 'γδε', droppedBytes: 4 });
});

test('short pipe command supports cwd, stdin, and environment changes', async () => {
  const manager = new ProcessManager(settings());
  try {
    const result = await manager.execute(command({
      command: 'read value; printf "%s:%s:%s" "$GREETING" "$value" "$PWD"',
      cwd: '/',
      stdin: 'world\n',
      environment: { GREETING: 'hello' },
    }));
    assert.equal(result.status, 'exited');
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, 'hello:world:/');
    assert.equal(result.session_id, null);
  } finally {
    await manager.shutdown();
  }
});

test('long-running command yields, accepts later input, and drains output incrementally', async () => {
  const manager = new ProcessManager(settings());
  try {
    const started = await manager.execute(command({
      command: 'printf first; read value; printf ":%s" "$value"',
      closeStdin: false,
      yieldTimeMs: 30,
    }));
    assert.equal(started.status, 'running');
    assert.equal(started.stdout, 'first');
    assert.ok(started.session_id);

    const afterInput = await manager.interact({
      sessionId: started.session_id,
      input: 'second\n',
      closeStdin: true,
      yieldTimeMs: 1_000,
    });
    const completed = afterInput.status === 'running'
      ? await pollUntilExited(manager, started.session_id, afterInput.stdout ?? '')
      : { result: afterInput, output: afterInput.stdout ?? '' };
    assert.equal(completed.result.status, 'exited');
    assert.equal(completed.result.exit_code, 0);
    assert.equal(completed.output, ':second');
  } finally {
    await manager.shutdown();
  }
});

test('output limits retain the newest command output', async () => {
  const manager = new ProcessManager(settings({ maxOutputBytes: 8 }));
  try {
    const result = await manager.execute(command({ command: 'printf 0123456789' }));
    assert.equal(result.stdout, '23456789');
    assert.equal(result.truncated, true);
    assert.equal(result.dropped_bytes.stdout, 2);
  } finally {
    await manager.shutdown();
  }
});

test('timeout terminates a process with an explicit reason', async () => {
  const manager = new ProcessManager(settings());
  try {
    const result = await manager.execute(command({ command: 'sleep 10', timeoutMs: 50 }));
    assert.equal(result.status, 'exited');
    assert.equal(result.termination_reason, 'timeout');
  } finally {
    await manager.shutdown();
  }
});

test('cancelling the initial request terminates its process', async () => {
  const manager = new ProcessManager(settings());
  try {
    const controller = new AbortController();
    const pending = manager.execute(command({ command: 'sleep 10', yieldTimeMs: 1_000 }), controller.signal);
    setTimeout(() => controller.abort(), 30);
    const result = await pending;
    assert.equal(result.status, 'exited');
    assert.equal(result.termination_reason, 'cancelled');
    assert.equal(result.session_id, null);
  } finally {
    await manager.shutdown();
  }
});

test('termination kills nested processes on POSIX', { skip: process.platform === 'win32' }, async () => {
  const manager = new ProcessManager(settings());
  try {
    const started = await manager.execute(command({
      command: 'sleep 10 & child=$!; printf "%s" "$child"; wait',
      closeStdin: false,
      yieldTimeMs: 30,
    }));
    const childPid = Number(started.stdout);
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    await manager.interact({
      sessionId: started.session_id,
      closeStdin: false,
      signal: 'terminate',
      yieldTimeMs: 1_000,
    });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
  } finally {
    await manager.shutdown();
  }
});

test('concurrency limit rejects another running process', async () => {
  const manager = new ProcessManager(settings({ maxConcurrentProcesses: 1 }));
  try {
    const first = await manager.execute(command({ command: 'sleep 10', yieldTimeMs: 20 }));
    assert.equal(first.status, 'running');
    const rejected = await manager.execute(command({ command: 'true' }));
    assert.equal(rejected.status, 'error');
    assert.match(rejected.error, /At most 1 concurrent/);
    await manager.interact({ sessionId: first.session_id, closeStdin: false, signal: 'terminate', yieldTimeMs: 1_000 });
  } finally {
    await manager.shutdown();
  }
});

test('concurrency reservations apply to simultaneous starts', async () => {
  const manager = new ProcessManager(settings({ maxConcurrentProcesses: 1 }));
  try {
    const [first, second] = await Promise.all([
      manager.execute(command({ command: 'sleep 10', yieldTimeMs: 20 })),
      manager.execute(command({ command: 'sleep 10', yieldTimeMs: 20 })),
    ]);
    assert.equal(first.status, 'running');
    assert.equal(second.status, 'error');
    assert.match(second.error, /At most 1 concurrent/);
  } finally {
    await manager.shutdown();
  }
});

test('simultaneous polls are serialized without duplicating output', async () => {
  const manager = new ProcessManager(settings());
  try {
    const started = await manager.execute(command({
      command: 'sleep 0.05; printf one; sleep 0.05; printf two',
      yieldTimeMs: 20,
    }));
    const polled = await Promise.all([
      manager.interact({ sessionId: started.session_id, closeStdin: false, yieldTimeMs: 1_000 }),
      manager.interact({ sessionId: started.session_id, closeStdin: false, yieldTimeMs: 1_000 }),
    ]);
    let output = polled.map(result => result.stdout ?? '').join('');
    let final = polled.find(result => result.status === 'exited') ?? polled.findLast(result => result.status === 'running');
    if (final?.status === 'running') {
      const completed = await pollUntilExited(manager, started.session_id);
      output += completed.output;
      final = completed.result;
    }
    assert.equal(output, 'onetwo');
    assert.equal(final.status, 'exited');
  } finally {
    await manager.shutdown();
  }
});

test('idle expiry removes an abandoned session', async () => {
  const manager = new ProcessManager(settings({ sessionIdleTimeoutMs: 60 }));
  try {
    const started = await manager.execute(command({ command: 'sleep 10', yieldTimeMs: 20 }));
    await new Promise(resolve => setTimeout(resolve, 180));
    const result = await manager.interact({ sessionId: started.session_id, closeStdin: false, yieldTimeMs: 20 });
    assert.equal(result.status, 'error');
    assert.match(result.error, /Unknown process session/);
  } finally {
    await manager.shutdown();
  }
});

test('manager shutdown terminates and forgets active sessions', { skip: process.platform === 'win32' }, async () => {
  const manager = new ProcessManager(settings());
  const started = await manager.execute(command({
    command: 'printf "%s" "$$"; while :; do sleep 1; done',
    yieldTimeMs: 30,
  }));
  const pid = Number(started.stdout);
  await manager.shutdown();
  assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  const unknown = await manager.interact({ sessionId: started.session_id, closeStdin: false, yieldTimeMs: 20 });
  assert.equal(unknown.status, 'error');
});

test('PTY mode exposes a terminal when node-pty is available', async t => {
  try {
    await import('node-pty');
  } catch {
    t.skip('optional node-pty dependency is unavailable');
    return;
  }
  const manager = new ProcessManager(settings());
  try {
    const result = await manager.execute(command({ command: '[ -t 0 ] && printf tty', pty: true }));
    assert.equal(result.status, 'exited');
    assert.match(result.output, /tty/);
  } finally {
    await manager.shutdown();
  }
});

test('PTY mode returns an actionable error when its optional module is unavailable', async () => {
  const manager = new ProcessManager(settings(), async () => {
    throw new Error('module unavailable');
  });
  const result = await manager.execute(command({ command: 'true', pty: true }));
  assert.equal(result.status, 'error');
  assert.match(result.error, /Install the optional node-pty dependency/);
});

test('PTY sessions accept resize and later input', async t => {
  try {
    await import('node-pty');
  } catch {
    t.skip('optional node-pty dependency is unavailable');
    return;
  }
  const manager = new ProcessManager(settings());
  try {
    const started = await manager.execute(command({
      command: 'stty size; read value; stty size',
      pty: true,
      yieldTimeMs: 30,
    }));
    assert.equal(started.status, 'running');
    assert.match(started.output, /30 120/);
    const afterInput = await manager.interact({
      sessionId: started.session_id,
      input: 'continue\r',
      closeStdin: false,
      yieldTimeMs: 1_000,
      columns: 100,
      rows: 40,
    });
    const completed = afterInput.status === 'running'
      ? await pollUntilExited(manager, started.session_id, afterInput.output ?? '')
      : { result: afterInput, output: afterInput.output ?? '' };
    assert.equal(completed.result.status, 'exited');
    assert.match(completed.output, /40 100/);
  } finally {
    await manager.shutdown();
  }
});
