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
    ['execute_shell_command', 'get_shell_configuration'],
  );

  const configuration = await client.callTool({
    name: 'get_shell_configuration',
    arguments: {},
  });
  assert.notEqual(configuration.isError, true);
  assert.match(configuration.content[0].text, /maximumOutputBytesPerStream/);

  const successful = await client.callTool({
    name: 'execute_shell_command',
    arguments: {
      command: 'read value; printf "%s:%s" "$GREETING" "$value"',
      stdin: 'world\n',
      environment: { GREETING: 'hello' },
    },
  });
  assert.equal(successful.isError, false);
  assert.match(successful.content[0].text, /hello:world/);

  const failed = await client.callTool({
    name: 'execute_shell_command',
    arguments: { command: 'printf failure >&2; exit 7' },
  });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /exited with code 7/);
  assert.match(failed.content[0].text, /failure/);

  const timedOut = await client.callTool({
    name: 'execute_shell_command',
    arguments: { command: 'sleep 2', timeout_ms: 100 },
  });
  assert.equal(timedOut.isError, true);
  assert.match(timedOut.content[0].text, /timed out/);

  const rejectedDirectory = await client.callTool({
    name: 'execute_shell_command',
    arguments: { command: 'pwd', cwd: '/' },
  });
  assert.equal(rejectedDirectory.isError, true);
  assert.match(rejectedDirectory.content[0].text, /outside SHELL_COMMANDS_ALLOWED_DIRECTORIES/);

  process.stdout.write('Smoke tests passed.\n');
} finally {
  await client.close();
}
