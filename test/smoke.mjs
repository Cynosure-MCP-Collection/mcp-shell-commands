import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['dist/index.js'],
  cwd: process.cwd(),
  stderr: 'pipe',
});
const client = new Client({ name: 'shell-commands-smoke-test', version: '1.0.0' });

try {
  await client.connect(transport);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map(tool => tool.name).sort(),
    ['exec_command', 'interact_with_process'],
  );

  const successful = await client.callTool({
    name: 'exec_command',
    arguments: {
      command: 'read value; printf "%s:%s" "$GREETING" "$value"',
      stdin: 'world\n',
      environment: { GREETING: 'hello' },
    },
  });
  assert.equal(successful.isError, false);
  assert.equal(successful.structuredContent.status, 'exited');
  assert.equal(successful.structuredContent.stdout, 'hello:world');

  const ongoing = await client.callTool({
    name: 'exec_command',
    arguments: {
      command: 'printf ready; read value; printf ":%s" "$value"',
      close_stdin: false,
      yield_time_ms: 250,
    },
  });
  assert.equal(ongoing.structuredContent.status, 'running');
  assert.equal(ongoing.structuredContent.stdout, 'ready');
  const sessionId = ongoing.structuredContent.session_id;
  assert.equal(typeof sessionId, 'string');

  let completed = await client.callTool({
    name: 'interact_with_process',
    arguments: { session_id: sessionId, input: 'done\n', close_stdin: true, yield_time_ms: 1000 },
  });
  let output = completed.structuredContent.stdout ?? '';
  if (completed.structuredContent.status === 'running') {
    completed = await client.callTool({
      name: 'interact_with_process',
      arguments: { session_id: sessionId, yield_time_ms: 1000 },
    });
    output += completed.structuredContent.stdout ?? '';
  }
  assert.equal(completed.structuredContent.status, 'exited');
  assert.equal(output, ':done');

  const failed = await client.callTool({
    name: 'exec_command',
    arguments: { command: 'printf failure >&2; exit 7' },
  });
  assert.equal(failed.isError, true);
  assert.equal(failed.structuredContent.exit_code, 7);
  assert.equal(failed.structuredContent.stderr, 'failure');

  process.stdout.write('Smoke tests passed.\n');
} finally {
  await client.close();
}
