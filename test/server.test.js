// End-to-end: starts the real CLI over stdio (like Claude Desktop) and calls every tool.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const examples = fileURLToPath(new URL('../node_modules/reconcile-kit/examples/', import.meta.url));
const STATEMENT = join(examples, 'bank-statement.csv');
const INVOICES = join(examples, 'invoices.csv');
const BIN = fileURLToPath(new URL('../bin/bookkeeping-mcp.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'bookkeeping-mcp-'));
let client;

before(async () => {
  client = new Client({ name: 'bookkeeping-mcp-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [BIN],
    env: { ...process.env, BOOKKEEPING_INVOICE_DIR: join(dir, 'Invoices') },
  }));
});
after(async () => { await client?.close(); });

const call = (name, args = {}) => client.callTool({ name, arguments: args });

const invoice = {
  number: 'INV-0007',
  date: '2026-11-25',
  taxRate: 18,
  seller: { name: 'Crescent Garments', ntn: '1234567-8' },
  buyer: { name: 'Ahmed Textiles' },
  items: [{ description: 'T-shirts', quantity: 100, unitPrice: 850 }],
  amountPaid: 50000,
};

test('lists tools with correct annotations', async () => {
  const { tools } = await client.listTools();
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.deepEqual(Object.keys(byName).sort(), ['calculate_invoice', 'create_invoice', 'next_invoice_number', 'read_bank_statement', 'reconcile']);
  assert.equal(byName.read_bank_statement.annotations.readOnlyHint, true);
  assert.equal(byName.create_invoice.annotations.readOnlyHint, false);
  for (const t of tools) assert.ok(t.description.length > 40);
});

test('read_bank_statement from a file', async () => {
  const r = await call('read_bank_statement', { path: STATEMENT });
  const s = r.structuredContent;
  assert.equal(s.transactions, 12);
  assert.deepEqual(s.period, { from: '2026-11-04', to: '2026-11-30' });
  // Credits: 150,000 + 45,500 + 100,000 + 75,000 + 30,000 + 32,250 + 30,000 + 12,000 + 9,999
  assert.equal(s.moneyIn, 484749);
  assert.equal(s.moneyOut, 113600); // 18,450 + 95,000 + 150
  assert.equal(s.net, 371149);
  assert.equal(s.largestIn[0].amount, 150000);
  assert.equal(s.byMonth['2026-11'].count, 12);
});

test('read_bank_statement errors are friendly', async () => {
  assert.match((await call('read_bank_statement', { path: join(dir, 'nope.csv') })).content[0].text, /file not found/);
  assert.match((await call('read_bank_statement', { path: 'statement.xlsx' })).content[0].text, /Save As > CSV/);
  assert.equal((await call('read_bank_statement', {})).isError, true);
});

test('reconcile files and save a report', async () => {
  const report = join(dir, 'reports', 'nov.csv');
  const r = await call('reconcile', { statement_path: STATEMENT, invoices_path: INVOICES, report_path: report });
  const s = r.structuredContent;
  assert.equal(s.summary.matches, 7);
  assert.deepEqual(s.summary.byConfidence, { high: 2, medium: 4, low: 1 });
  assert.equal(s.unmatchedBank.length, 4);
  assert.equal(s.unmatchedInvoices.length, 2);
  assert.ok(s.matches.some((m) => m.type === 'one-to-many'));
  assert.equal(s.savedReport, report);
  assert.match(readFileSync(report, 'utf8'), /Status,Confidence,Score/);
  // Does not overwrite by default.
  const again = await call('reconcile', { statement_path: STATEMENT, invoices_path: INVOICES, report_path: report });
  assert.match(again.content[0].text, /already exists/);
});

test('reconcile with inline CSV', async () => {
  const r = await call('reconcile', {
    statement_csv: 'Date,Narration,Credit\n10/11/2026,IBFT INV-1 ALI,500\n',
    invoices_csv: 'Invoice No,Date,Customer,Amount\nINV-1,09/11/2026,Ali,500\n',
  });
  assert.equal(r.structuredContent.matches[0].confidence, 'high');
});

test('calculate_invoice', async () => {
  const r = await call('calculate_invoice', { invoice });
  assert.equal(r.structuredContent.total, 100300);
  assert.equal(r.structuredContent.balanceDue, 50300);
  assert.match(r.structuredContent.words.english, /^One Lakh Three Hundred Rupees Only$/);
  const bad = await call('calculate_invoice', { invoice: { items: [] } });
  assert.equal(bad.isError, true);
});

test('create_invoice saves HTML to the default folder and refuses to overwrite', async () => {
  const r = await call('create_invoice', { invoice });
  const path = r.structuredContent.savedTo;
  assert.equal(path, join(dir, 'Invoices', 'INV-0007.html'));
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, 'utf8'), /Sales Tax Invoice/);
  assert.equal((await call('create_invoice', { invoice })).isError, true);
  const custom = join(dir, 'custom.html');
  writeFileSync(custom, 'old');
  const r2 = await call('create_invoice', { invoice, output_path: custom, overwrite: true });
  assert.equal(r2.structuredContent.savedTo, custom);
  assert.match(readFileSync(custom, 'utf8'), /INV-0007/);
});

test('next_invoice_number', async () => {
  assert.equal((await call('next_invoice_number', { previous: 'INV-2026-0042' })).structuredContent.next, 'INV-2026-0043');
});
