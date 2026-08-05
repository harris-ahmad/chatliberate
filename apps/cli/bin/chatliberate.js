#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  createHeaders,
  decodeUserIdFromToken,
  exportAllConversations,
  fetchWithRetry,
  getApiBase,
  toMarkdownExportLayout,
  toOpenAIExportFormat,
} from '@chatliberate/core';

const HELP = `
ChatLiberate — export ALL ChatGPT conversations (including Business/Teams)

Usage:
  chatliberate [options]

Options:
  --bearer <token>       Bearer token from DevTools (or CHATGPT_BEARER_TOKEN env)
  --account-id <id>      Teams/Business account ID (auto-detected when possible)
  -o, --output <dir>     Output directory (default: ./chatliberate-export)
  --format <fmt>         json | markdown | both | zip (default: both)
  --no-archived          Skip archived conversations
  --no-projects          Skip project conversations
  --no-files             Skip image/file downloads
  --throttle <ms>        Delay between API calls (default: 1500)
  --help                 Show this help

Get your bearer token:
  1. Open https://chatgpt.com and log in
  2. DevTools (F12) → Network → filter "conversations"
  3. Copy the Authorization header value (the eyJ... part after "Bearer ")
`;

function parseArgs(argv) {
  const opts = {
    bearer: process.env.CHATGPT_BEARER_TOKEN,
    accountId: process.env.CHATGPT_ACCOUNT_ID,
    output: './chatliberate-export',
    format: 'both',
    includeArchived: true,
    includeProjects: true,
    downloadFiles: true,
    throttleMs: 1500,
  };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      process.exit(0);
    } else if (arg === '--bearer') opts.bearer = argv[++i];
    else if (arg === '--account-id') opts.accountId = argv[++i];
    else if (arg === '-o' || arg === '--output') opts.output = argv[++i];
    else if (arg === '--format') opts.format = argv[++i];
    else if (arg === '--no-archived') opts.includeArchived = false;
    else if (arg === '--no-projects') opts.includeProjects = false;
    else if (arg === '--no-files') opts.downloadFiles = false;
    else if (arg === '--throttle') opts.throttleMs = Number(argv[++i]);
  }

  return opts;
}

async function promptToken() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question('Paste your ChatGPT bearer token (eyJ...): ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function detectAccountId(token) {
  try {
    const response = await fetchWithRetry(`${getApiBase()}/accounts/check`, {
      headers: createHeaders({ accessToken: token }),
    });
    const data = await response.json();
    return data.account_id ?? data.accounts?.[0]?.account_id;
  } catch {
    return undefined;
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeExport(result, opts) {
  const userId = decodeUserIdFromToken(opts.bearer) ?? 'export';
  const baseDir = path.join(opts.output, userId);
  ensureDir(baseDir);

  const oaiFormat = toOpenAIExportFormat(result.conversations);

  if (opts.format === 'json' || opts.format === 'both' || opts.format === 'zip') {
    const jsonPath = path.join(baseDir, 'conversations.json');
    fs.writeFileSync(jsonPath, JSON.stringify(oaiFormat, null, 2));
    console.log(`\n✓ Wrote ${jsonPath} (${result.conversations.length} conversations)`);
    console.log('  Compatible with Memory Forge, context-pack, and OpenAI import tools');
  }

  if (opts.format === 'markdown' || opts.format === 'both' || opts.format === 'zip') {
    const layout = toMarkdownExportLayout(result.conversations, {
      fileMeta: result.fileMeta,
      index: result.index,
    });
    fs.writeFileSync(path.join(baseDir, 'INDEX.md'), layout.indexMarkdown);
    for (const [relPath, md] of layout.files) {
      const full = path.join(baseDir, relPath);
      ensureDir(path.dirname(full));
      fs.writeFileSync(full, md);
    }
    console.log(`✓ Wrote INDEX.md + ${layout.files.size} markdown files under ${path.join(baseDir, 'markdown')}`);
  }

  if (result.files.size > 0) {
    const filesDir = path.join(baseDir, 'files');
    ensureDir(filesDir);
    for (const [fileId, data] of result.files) {
      const meta = result.fileMeta.get(fileId);
      const ext = meta?.fileName ? path.extname(meta.fileName) : '.bin';
      fs.writeFileSync(path.join(filesDir, `${fileId}${ext}`), data);
    }
    console.log(`✓ Downloaded ${result.files.size} images/files to ${filesDir}`);
  }

  const statsPath = path.join(baseDir, 'export-stats.json');
  fs.writeFileSync(
    statsPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        ...result.stats,
        tool: 'chatliberate',
        version: '0.1.2',
      },
      null,
      2,
    ),
  );

  console.log(`\nStats: ${result.stats.conversationCount} conversations, ${result.stats.branchCount} branches, ${result.stats.fileCount} files`);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.bearer) {
    console.error('No bearer token provided.\n');
    opts.bearer = await promptToken();
  }

  if (!opts.bearer) {
    console.error('Bearer token required.');
    process.exit(1);
  }

  if (!opts.accountId) {
    opts.accountId = await detectAccountId(opts.bearer);
    if (opts.accountId) {
      console.log(`Detected Teams/Business account: ${opts.accountId}`);
    }
  }

  const session = { accessToken: opts.bearer, accountId: opts.accountId };

  console.log('\n🚀 ChatLiberate export starting…\n');

  const result = await exportAllConversations(session, {
    includeArchived: opts.includeArchived,
    includeProjects: opts.includeProjects,
    downloadFiles: opts.downloadFiles,
    throttleMs: opts.throttleMs,
    onProgress: (event) => {
      if (event.phase === 'downloading' && event.current && event.total) {
        process.stdout.write(`\r  [${event.current}/${event.total}] ${event.message.slice(0, 60).padEnd(60)}`);
      } else if (event.phase === 'indexing') {
        process.stdout.write(`\r  ${event.message}`.padEnd(70));
      }
    },
  });

  console.log('\n');
  writeExport(result, opts);
  console.log('\nDone! Your data is yours.\n');
}

main().catch((err) => {
  console.error('\nExport failed:', err.message);
  process.exit(1);
});
