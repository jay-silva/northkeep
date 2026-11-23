// The MCP server an agent under test connects to: NorthKeep's real server over
// a throwaway vault, plus what the chosen design adds. It runs embedded, so no
// sync engine starts and nothing leaves the machine.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { assertThrowawayHome } from './seed.mjs';
import { findPage, servesPages } from './designs.mjs';

const home = process.env.NORTHKEEP_HOME ?? '';
assertThrowawayHome(home);
process.env.NORTHKEEP_NO_KEYCHAIN = '1';
delete process.env.NORTHKEEP_SCOPES;
delete process.env.NORTHKEEP_REDACT_TIER;

const { setPlatform } = await import('../../packages/core/dist/index.js');
const { nodePlatform } = await import('../../packages/platform-node/dist/index.js');
const { createServer } = await import('../../packages/mcp-server/dist/server.js');
setPlatform(nodePlatform());
// Take zod and the transport from the server's own copies, so tool schemas match.
const fromServer = createRequire(new URL('../../packages/mcp-server/package.json', import.meta.url));
const load = (id) => import(pathToFileURL(fromServer.resolve(id)).href);
const { z } = await load('zod');
const { StdioServerTransport } = await load('@modelcontextprotocol/sdk/server/stdio.js');

const server = createServer(path.join(home, 'vault.nkv'));
const arm = process.env.BENCH_ARM ?? 'search';
const extra = process.env.BENCH_EXTRA_FILE ? fs.readFileSync(process.env.BENCH_EXTRA_FILE, 'utf8') : '';
// The SDK keeps the handshake text in a private field; a prototype may reach in.
if (extra) server.server._instructions = `${server.server._instructions}\n${extra}`;

if (servesPages(arm)) {
  const { pages } = JSON.parse(fs.readFileSync(process.env.BENCH_PAGES_FILE, 'utf8'));
  const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
  server.registerTool(
    'page_list',
    { title: 'List pages', description: 'List the pages NorthKeep keeps for the people, organizations, properties and pets in the user\'s life, one line each.', inputSchema: {} },
    async () => text({ pages: pages.map(({ name, kind, summary }) => ({ name, kind, summary })) }),
  );
  server.registerTool(
    'page_get',
    {
      title: 'Read a page',
      description: 'Read the current page for one person, organization, property or pet in the user\'s life. The page holds the facts as they stand now.',
      inputSchema: { name: z.string().max(200).describe('The page name, as page_list or the instructions give it') },
    },
    async ({ name }) => {
      const page = findPage(pages, name);
      return page ? text(page) : text({ error: `No page named "${name}".`, pages: pages.map((p) => p.name) });
    },
  );
}

await server.connect(new StdioServerTransport());
process.stdin.on('end', () => process.exit(0));
process.stdin.on('close', () => process.exit(0));
