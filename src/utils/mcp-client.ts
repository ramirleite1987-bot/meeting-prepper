import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { logger } from './logger.js';
import { tokenManager } from './token-manager.js';

const log = logger.child('MCPClient');

interface MCPClientOptions {
  serverUrl: string;
  service: string;
  clientName?: string;
  clientVersion?: string;
}

export async function createMCPClient(options: MCPClientOptions): Promise<Client> {
  const { serverUrl, service, clientName = 'meeting-prepper', clientVersion = '0.1.0' } = options;

  const token = await tokenManager.getValidToken(service);

  const headers: Record<string, string> = {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: { headers },
  });

  const client = new Client({ name: clientName, version: clientVersion }, { capabilities: {} });

  await client.connect(transport);
  log.info('MCP client connected', { service, serverUrl });

  return client;
}
