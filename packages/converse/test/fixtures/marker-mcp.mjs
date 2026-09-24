// Minimal stdio MCP server with one tool, "touch", that appends to MARKER_FILE.
// With {"note":"slow"} it waits SLOW_MS first, so a test can cancel mid-call and
// then prove from disk that the side effect still happened.
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const marker = process.env.MARKER_FILE;
const slowMs = Number(process.env.SLOW_MS ?? '1500');
const server = new Server({ name: 'marker', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [{ name: 'touch', description: 'Append a line to a marker file.', inputSchema: { type: 'object' } }],
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params?.arguments?.note === 'slow') await new Promise((r) => setTimeout(r, slowMs));
  fs.appendFileSync(marker, 'TOOL RAN\n');
  return { content: [{ type: 'text', text: 'touched' }] };
});
await server.connect(new StdioServerTransport());
