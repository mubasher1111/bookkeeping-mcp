// bookkeeping-mcp: lets Claude and other AI assistants do real bookkeeping work
// on your own files: read bank statements, reconcile them with invoices, and
// create professional invoices. Everything runs locally; no file leaves your computer.

import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises';
import { resolve, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { readStatement, reconcileFiles, toReportCSV, formatDate } from 'reconcile-kit';
import { calculateInvoice, renderInvoiceHTML, nextInvoiceNumber } from 'pk-invoice';

export const VERSION = '1.0.0';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITES_FILE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };

function ok(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}
function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}
const round2 = (n) => Math.round(n * 100) / 100;

/** Reads a CSV/TXT file the user pointed to. Excel files must be saved as CSV first. */
async function readTable(path, label) {
  const full = resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
  const ext = extname(full).toLowerCase();
  if (ext === '.xlsx' || ext === '.xls') {
    throw new Error(`${label}: Excel files aren't read directly. In Excel choose File > Save As > CSV, then use the .csv file.`);
  }
  const info = await stat(full).catch(() => null);
  if (!info || !info.isFile()) throw new Error(`${label}: file not found: ${full}`);
  if (info.size > MAX_FILE_BYTES) throw new Error(`${label}: file is larger than 10 MB`);
  return readFile(full, 'utf8');
}

/** Returns CSV text from either a file path or inline CSV. */
async function source(path, csv, label) {
  if (path) return readTable(path, label);
  if (csv) return csv;
  throw new Error(`Provide ${label} as a file path or as CSV text.`);
}

async function safeWrite(path, content, overwrite) {
  const full = resolve(path.replace(/^~(?=$|[\\/])/, homedir()));
  const exists = await access(full).then(() => true, () => false);
  if (exists && !overwrite) throw new Error(`File already exists: ${full}. Pass overwrite: true to replace it.`);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, content, 'utf8');
  return full;
}

const defaultInvoiceDir = () => process.env.BOOKKEEPING_INVOICE_DIR || join(homedir(), 'Invoices');

const partySchema = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  ntn: z.string().optional(),
  strn: z.string().optional(),
  logo: z.string().optional().describe('https URL or data:image URL (seller only)'),
}).optional();

const invoiceSchema = z.object({
  number: z.string().optional().describe('Invoice number, e.g. INV-2026-0042'),
  date: z.string().optional().describe('YYYY-MM-DD'),
  dueDate: z.string().optional().describe('YYYY-MM-DD'),
  reference: z.string().optional(),
  currency: z.string().optional().describe('PKR (default), USD, EUR, GBP, AED, SAR...'),
  taxRate: z.number().min(0).max(100).optional().describe('Default sales tax % for items, e.g. 18'),
  taxLabel: z.string().optional(),
  seller: partySchema,
  buyer: partySchema,
  items: z.array(z.object({
    description: z.string(),
    quantity: z.number().nonnegative().optional(),
    unit: z.string().optional(),
    unitPrice: z.number().nonnegative(),
    discount: z.number().min(0).max(100).optional().describe('Line discount %'),
    taxRate: z.number().min(0).max(100).optional().describe('Overrides the default tax %'),
  })).min(1),
  discount: z.object({ type: z.enum(['percent', 'amount']), value: z.number().nonnegative() }).optional(),
  shipping: z.number().nonnegative().optional(),
  amountPaid: z.number().nonnegative().optional(),
  payment: z.object({
    bank: z.string().optional(), accountTitle: z.string().optional(),
    accountNumber: z.string().optional(), iban: z.string().optional(), other: z.string().optional(),
  }).optional(),
  notes: z.string().optional(),
  terms: z.string().optional(),
  title: z.string().optional(),
  accentColor: z.string().optional(),
});

function totalsOf(c) {
  return {
    currency: c.currency,
    subtotal: c.subtotal,
    discount: c.totalDiscount,
    taxableAmount: c.taxableAmount,
    taxes: c.taxes,
    totalTax: c.totalTax,
    shipping: c.shipping,
    total: c.total,
    amountPaid: c.amountPaid,
    balanceDue: c.balanceDue,
    words: c.words,
  };
}

/** Creates a new server instance with all tools registered. */
export function createServer() {
  const server = new McpServer(
    { name: 'bookkeeping-mcp', title: 'Bookkeeping Tools', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        'Bookkeeping tools that work on the user\'s own files. Use read_bank_statement to summarise a bank ' +
        'statement CSV, reconcile to match a statement with an invoice list, and create_invoice to make a ' +
        'print-ready invoice (open it in a browser and Save as PDF). Do the arithmetic with these tools ' +
        'instead of calculating totals, tax or matches yourself. Excel files must be saved as CSV first.',
    },
  );

  // ---------- Bank statements ----------
  server.registerTool(
    'read_bank_statement',
    {
      title: 'Read a bank statement',
      description:
        'Reads a bank statement CSV (from any bank: Date, Narration/Description, Debit/Credit or Amount columns; ' +
        'title rows above the table are fine) and returns a summary: period, money in, money out, net, monthly ' +
        'totals and the largest entries. Give a file path or paste the CSV text.',
      inputSchema: z.object({
        path: z.string().optional().describe('Path to the statement .csv file'),
        csv: z.string().optional().describe('Statement CSV text, if not using a file'),
        day_first: z.boolean().optional().describe('Read 05/11/2026 as 5 November (default true)'),
      }),
      annotations: READ_ONLY,
    },
    async ({ path, csv, day_first = true }) => {
      let s;
      try {
        s = readStatement(await source(path, csv, 'statement'), { dayFirst: day_first });
      } catch (err) {
        return fail(err.message);
      }
      const tx = s.transactions;
      if (!tx.length) return fail('No transactions found in the statement.');
      const dates = tx.map((t) => t.date).sort((a, b) => a - b);
      const moneyIn = round2(tx.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0));
      const moneyOut = round2(tx.filter((t) => t.amount < 0).reduce((a, t) => a - t.amount, 0));
      const byMonth = {};
      for (const t of tx) {
        const m = formatDate(t.date).slice(0, 7);
        byMonth[m] ??= { in: 0, out: 0, count: 0 };
        if (t.amount > 0) byMonth[m].in = round2(byMonth[m].in + t.amount);
        else byMonth[m].out = round2(byMonth[m].out - t.amount);
        byMonth[m].count++;
      }
      const brief = (t) => ({ date: formatDate(t.date), description: t.description, reference: t.reference || undefined, amount: t.amount });
      return ok({
        transactions: tx.length,
        skippedRows: s.skipped,
        period: { from: formatDate(dates[0]), to: formatDate(dates[dates.length - 1]) },
        moneyIn,
        moneyOut,
        net: round2(moneyIn - moneyOut),
        byMonth,
        largestIn: tx.filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount).slice(0, 5).map(brief),
        largestOut: tx.filter((t) => t.amount < 0).sort((a, b) => a.amount - b.amount).slice(0, 5).map(brief),
        columnsDetected: s.columns,
      });
    },
  );

  server.registerTool(
    'reconcile',
    {
      title: 'Reconcile bank statement with invoices',
      description:
        'Matches bank statement entries with invoices or bills. Returns every match with a confidence level ' +
        '(high/medium/low) and the reasons, including one payment for several invoices and instalments, plus the ' +
        'bank entries and invoices left unmatched. Optionally saves an Excel-ready CSV report. Invoices need an ' +
        'Amount column and at least one of Invoice No, Customer or Date.',
      inputSchema: z.object({
        statement_path: z.string().optional().describe('Path to the bank statement .csv'),
        statement_csv: z.string().optional(),
        invoices_path: z.string().optional().describe('Path to the invoices/bills .csv'),
        invoices_csv: z.string().optional(),
        tolerance: z.number().nonnegative().optional().describe('Allowed amount difference, e.g. 1 for rounding (default 0)'),
        days_after: z.number().nonnegative().optional().describe('Payment may come up to this many days after the invoice (default 60)'),
        direction: z.enum(['both', 'in', 'out']).optional().describe('in = money received, out = money paid (default both)'),
        day_first: z.boolean().optional().describe('Read 05/11/2026 as 5 November (default true)'),
        report_path: z.string().optional().describe('Save a CSV report here (optional)'),
        overwrite: z.boolean().optional().describe('Replace report_path if it exists (default false)'),
      }),
      annotations: WRITES_FILE,
    },
    async (a) => {
      let result;
      try {
        const statement = await source(a.statement_path, a.statement_csv, 'statement');
        const invoices = await source(a.invoices_path, a.invoices_csv, 'invoices');
        // Only pass options the caller set, so the library's defaults stay in place.
        const options = Object.fromEntries(Object.entries({
          tolerance: a.tolerance, daysAfter: a.days_after, direction: a.direction, dayFirst: a.day_first ?? true,
        }).filter(([, v]) => v !== undefined));
        result = reconcileFiles(statement, invoices, options);
      } catch (err) {
        return fail(err.message);
      }
      let savedReport;
      if (a.report_path) {
        try {
          savedReport = await safeWrite(a.report_path, '﻿' + toReportCSV(result), a.overwrite);
        } catch (err) {
          return fail(err.message);
        }
      }
      const tx = (t) => ({ date: formatDate(t.date), description: t.description, amount: t.amount });
      const inv = (r) => ({ number: r.number, party: r.party, date: r.date ? formatDate(r.date) : null, amount: r.amount });
      return ok({
        summary: result.summary,
        matches: result.matches.map((m) => ({
          confidence: m.confidence, score: m.score, type: m.type,
          bank: m.bank.map(tx), invoices: m.records.map(inv), difference: m.difference, reasons: m.reasons,
        })),
        unmatchedBank: result.unmatchedBank.map(tx),
        unmatchedInvoices: result.unmatchedRecords.map(inv),
        savedReport,
        note: 'Low-confidence matches need a human check before posting to the books.',
      });
    },
  );

  // ---------- Invoices ----------
  server.registerTool(
    'calculate_invoice',
    {
      title: 'Calculate invoice totals',
      description:
        'Works out every amount on an invoice without saving anything: line and invoice discounts (applied before ' +
        'tax), sales tax by rate, delivery charges, amount paid, balance due, and the total in words (English and ' +
        'Urdu for PKR).',
      inputSchema: z.object({ invoice: invoiceSchema }),
      annotations: READ_ONLY,
    },
    async ({ invoice }) => {
      try {
        return ok(totalsOf(calculateInvoice(invoice)));
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'create_invoice',
    {
      title: 'Create an invoice',
      description:
        'Creates a professional, print-ready A4 invoice as an HTML file (open it in a browser and choose Print > ' +
        'Save as PDF). It becomes a "Sales Tax Invoice" when tax is charged and the seller has an NTN/STRN. Saves ' +
        `to output_path, or to the Invoices folder in the user's home folder by default. Returns the file path and totals.`,
      inputSchema: z.object({
        invoice: invoiceSchema,
        output_path: z.string().optional().describe('Where to save the .html file (optional)'),
        overwrite: z.boolean().optional().describe('Replace the file if it exists (default false)'),
        urdu_words: z.boolean().optional().describe('Show the total in Urdu words for PKR (default true)'),
      }),
      annotations: WRITES_FILE,
    },
    async ({ invoice, output_path, overwrite, urdu_words = true }) => {
      try {
        const totals = totalsOf(calculateInvoice(invoice));
        const name = `${String(invoice.number || 'invoice').replace(/[^a-z0-9._-]+/gi, '-')}.html`;
        const path = await safeWrite(output_path || join(defaultInvoiceDir(), name), renderInvoiceHTML(invoice, { urduWords: urdu_words }), overwrite);
        return ok({ savedTo: path, totals, howToPdf: 'Open the file in a browser and choose Print > Save as PDF.' });
      } catch (err) {
        return fail(err.message);
      }
    },
  );

  server.registerTool(
    'next_invoice_number',
    {
      title: 'Next invoice number',
      description: 'Suggests the next invoice number, keeping prefix and zero padding: INV-2026-0042 → INV-2026-0043.',
      inputSchema: z.object({ previous: z.string().describe('The last invoice number used') }),
      annotations: READ_ONLY,
    },
    async ({ previous }) => ok({ next: nextInvoiceNumber(previous) }),
  );

  return server;
}
