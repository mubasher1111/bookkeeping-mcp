#!/usr/bin/env node
// Starts bookkeeping-mcp over stdio for Claude Desktop, Claude Code, Cursor, VS Code and other MCP clients.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer, VERSION } from '../src/server.js';

if (process.argv.includes('--version') || process.argv.includes('-v')) {
  console.log(VERSION);
  process.exit(0);
}

serveStdio(() => createServer(), {
  onerror: (err) => console.error('[bookkeeping-mcp]', err?.message ?? err),
});
