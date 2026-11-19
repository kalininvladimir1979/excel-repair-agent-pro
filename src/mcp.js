import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export const mcpVersion = '2.3.2';

export function createMcp(directory, command = process.env.UVX_BIN || 'uvx') {
  let connected;

  async function close() {
    const client = connected;
    connected = undefined;
    await client?.close().catch(() => {});
  }

  async function connect() {
    if (connected) return connected;
    const client = new Client({ name: 'excel-repair-agent-pro', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command,
      args: [`excel-mcp-server==${mcpVersion}`, 'stdio', '--allow-dir', directory],
      stderr: 'pipe',
    });
    transport.stderr?.resume();

    // The SDK's initialize request has its own timeout once the process starts.
    try {
      await client.connect(transport);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
    connected = client;
    client.onclose = () => {
      if (connected === client) connected = undefined;
    };
    return client;
  }

  async function call(context, name, args) {
    const entry = { name, arguments: args };
    context.log.push(entry);
    let reply;
    try {
      const client = await connect();
      reply = await client.callTool({ name, arguments: args }, undefined, { timeout: 25_000 });
    } catch (error) {
      await close();
      entry.error = String(error.message).slice(0, 1000);
      throw new Error('Excel MCP недоступен. Проверьте установку uvx и повторите чтение.', { cause: error });
    }

    if (reply.isError) {
      entry.error = reply.content.map(part => part.text).filter(Boolean).join('\n') || 'Ошибка инструмента';
      throw new Error(`Excel MCP: ${entry.error.slice(0, 1000)}`);
    }
    const result = reply.structuredContent ?? reply.content.find(part => part.type === 'text')?.text;
    try {
      entry.result = typeof result === 'string' ? JSON.parse(result) : result;
      if (!entry.result || typeof entry.result !== 'object') throw new Error();
      return entry.result;
    } catch {
      entry.error = 'Excel MCP вернул результат в неожиданном формате.';
      throw new Error(entry.error);
    }
  }

  async function catalog() {
    try {
      const client = await connect();
      const tools = [];
      let cursor;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: 25_000 });
        tools.push(...page.tools.map(tool => tool.name));
        cursor = page.nextCursor;
      } while (cursor);
      return tools;
    } catch {
      await close();
      throw new Error('Каталог MCP недоступен. Проверьте uvx и права на каталог книги.');
    }
  }

  return { call, catalog, close };
}

export function serialQueue() {
  let tail = Promise.resolve();
  return work => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
}
