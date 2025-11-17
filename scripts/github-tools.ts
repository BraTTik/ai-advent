import { Client } from '@modelcontextprotocol/sdk/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env.local') })
const MCP_SERVER_URL = 'https://api.githubcopilot.com/mcp/';

async function main() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error('Set GITHUB_TOKEN with a GitHub MCP access token before running.');
    process.exit(1);
  }

  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });

  const client = new Client({
    name: 'github-mcp-tool-list',
    version: '1.0.0',
  });

  try {
    await client.connect(transport);
    
    const { tools } = await client.listTools();

    console.log('Available GitHub MCP tools:');
    for (const tool of tools) {
      const description = tool.description ?? 'no description';
      console.log(`- ${tool.name}: ${description}`);
    }
  } finally {
    await client.close();
    await transport.close();
  }
}

main().catch((error) => {
  console.error('Failed to list MCP tools:', error);
  process.exit(1);
});


