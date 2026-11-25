# 📒 bookkeeping-mcp

**Let Claude do your bookkeeping, on your own files.**
An MCP server that gives Claude, Cursor, VS Code and other AI assistants real bookkeeping tools: summarise bank statements, reconcile them with your invoices, and create professional invoices with sales tax.

> AI is great at talking about accounting, and bad at adding up 300 bank entries. With this server, Claude calls tested code for every number and every match, and explains the result to you.

[![Tests](https://github.com/mubasher1111/bookkeeping-mcp/actions/workflows/test.yml/badge.svg)](https://github.com/mubasher1111/bookkeeping-mcp/actions/workflows/test.yml)
[![npm](https://img.shields.io/npm/v/bookkeeping-mcp)](https://www.npmjs.com/package/bookkeeping-mcp)
![License](https://img.shields.io/badge/license-MIT-blue)
![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)

📖 **[Full guide](https://zexcart.site/bookkeeping-mcp/)** · Built on [reconcile-kit](https://github.com/mubasher1111/reconcile-kit) and [pk-invoice](https://github.com/mubasher1111/pk-invoice)

---

## What you can ask

- *"Summarise `Downloads/november-statement.csv`. How much came in and went out, and what were the biggest payments?"*
- *"Reconcile `statement.csv` with `invoices.csv` and save the report to `Desktop/reconciliation.csv`. Which invoices are still unpaid?"*
- *"Make an invoice for Ahmed Textiles: 100 T-shirts at Rs 850 with 18% sales tax, Rs 50,000 already paid."*
- *"What's the next invoice number after INV-2026-0042?"*

## Tools

| Tool | What it does |
|---|---|
| `read_bank_statement` | Period, money in and out, net, monthly totals and the largest entries. Works with any bank's CSV export (title rows, Dr/Cr columns, lakh amounts, DD/MM dates). |
| `reconcile` | Matches statement entries with invoices: confidence (high/medium/low) and reasons, one payment for several invoices, instalments, and what's left unmatched. Optionally saves an Excel-ready CSV report. |
| `calculate_invoice` | Every amount on an invoice: line and invoice discounts (before tax), sales tax by rate, delivery, amount paid, balance due, total in words (English + Urdu for PKR). |
| `create_invoice` | Saves a print-ready A4 invoice (HTML → Save as PDF). "Sales Tax Invoice" when tax is charged and the seller has an NTN/STRN. |
| `next_invoice_number` | INV-2026-0042 → INV-2026-0043 |

**Your files stay on your computer.** The server reads only the files you name, never overwrites a file unless you say so, and makes no network calls.

## Setup

You need [Node.js](https://nodejs.org) 20 or newer.

### Claude Desktop

Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "bookkeeping": {
      "command": "npx",
      "args": ["-y", "bookkeeping-mcp"]
    }
  }
}
```

Restart Claude Desktop.

### Claude Code

```bash
claude mcp add bookkeeping -- npx -y bookkeeping-mcp
```

### Cursor / VS Code

Use the same `command` and `args` in `.cursor/mcp.json`, or in `.vscode/mcp.json` with `"type": "stdio"`.

### Where invoices are saved

By default, in an `Invoices` folder in your home folder. To change it, set an environment variable:

```json
"env": { "BOOKKEEPING_INVOICE_DIR": "D:\\Accounts\\Invoices" }
```

## Tips

- **Excel files:** save them as CSV first (File → Save As → CSV). Bank exports are usually CSV already.
- **Best matches:** ask customers to write the invoice number in their transfer description.
- **Always review** medium and low matches before posting them to your books. The tool shows its reasons so this is quick.

## Development

```bash
git clone https://github.com/mubasher1111/bookkeeping-mcp.git
cd bookkeeping-mcp
npm install
npm test     # starts the server over stdio and calls every tool with real files
```

## License

[MIT](LICENSE). Made by [ZexCart](https://zexcart.site). More free tools: [zexcart.site/dev-tools](https://zexcart.site/dev-tools/).

If it saves you time at month-end, please ⭐ **star the repo**.
