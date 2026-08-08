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

Auth:
  --bearer <token>       Bearer token from DevTools (or CHATGPT_BEARER_TOKEN env)
  --account-id <id>      Teams/Business account ID (auto-detected when possible)

Output:
  -o, --output <dir>     Output directory (default: ./chatliberate-export)
  --format <fmt>         json | markdown | both (default: both)

Scope:
  --no-archived          Skip archived conversations
  --no-projects          Skip project conversations
  --projects-only        Export ONLY project conversations
  --conv <ids>           Only these conversation IDs (comma-separated)
  --proj <ids>           Only these project IDs (comma-separated)
  --max <n>              Cap number of conversations this run
  --update               Incremental: only re-fetch conversations changed since
                         the last export in this output dir (smart diff, not a
                         full re-download)

Files:
  --no-files             Skip ALL downloads (images, canvas, attachments)
  --no-images            Skip DALL-E / uploaded images
  --no-canvas            Skip canvas / textdoc assets
  --no-attachments       Skip other file attachments

Behaviour:
  --throttle <ms>        Delay between API calls in ms (default: 1500; the
                         exporter also auto-slows itself on 429s)
  --non-interactive      Never prompt (fail if token missing)
  --verbose              Print every progress event
  --help                 Show this help

Get your bearer token:
  1. Open https://chatgpt.com and log in
  2. DevTools (F12) → Network → filter "conversations"
  3. Copy the Authorization header value (the eyJ... part after "Bearer ")
`;

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const opts = {
    bearer: process.env.CHATGPT_BEARER_TOKEN,
    accountId: process.env.CHATGPT_ACCOUNT_ID,
    output: './chatliberate-export',
    format: 'both',
    includeArchived: true,
    includeProjects: true,
    projectsOnly: false,
    downloadFiles: true,
    downloadImages: true,
    downloadCanvas: true,
    downloadAttachments: true,
    throttleMs: 1500,
    maxConversations: undefined,
    conversationIds: undefined,
    projectIds: undefined,
    update: false,
    nonInteractive: false,
    verbose: false,
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
    else if (arg === '--projects-only') opts.projectsOnly = true;
    else if (arg === '--no-files') opts.downloadFiles = false;
    else if (arg === '--no-images') opts.downloadImages = false;
    else if (arg === '--no-canvas') opts.downloadCanvas = false;
    else if (arg === '--no-attachments') opts.downloadAttachments = false;
    else if (arg === '--throttle') opts.throttleMs = Number(argv[++i]);
    else if (arg === '--max') opts.maxConversations = Number(argv[++i]);
    else if (arg === '--conv') opts.conversationIds = splitList(argv[++i]);
    else if (arg === '--proj') opts.projectIds = splitList(argv[++i]);
    else if (arg === '--update') opts.update = true;
    else if (arg === '--non-interactive') opts.nonInteractive = true;
    else if (arg === '--verbose') opts.verbose = true;
    else console.error(`Unknown option: ${arg}`);
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

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Load prior conversations + file metadata for an incremental --update run. */
function loadPriorExport(baseDir) {
  const conversations = readJsonIfExists(path.join(baseDir, 'conversations.json'));
  const manifest = readJsonIfExists(path.join(baseDir, 'files-manifest.json'));

  const knownUpdateTimes = {};
  const priorConversations = Array.isArray(conversations) ? conversations : [];
  for (const c of priorConversations) {
    const id = c.conversation_id ?? c.id;
    if (id) knownUpdateTimes[id] = Number(c.update_time ?? 0);
  }

  const priorFileMeta = new Map();
  if (manifest && typeof manifest === 'object') {
    for (const [fileId, meta] of Object.entries(manifest)) priorFileMeta.set(fileId, meta);
  }

  return { priorConversations, knownUpdateTimes, priorFileMeta };
}

function writeExport(result, opts, baseDir) {
  ensureDir(baseDir);

  const oaiFormat = toOpenAIExportFormat(result.conversations);

  if (opts.format === 'json' || opts.format === 'both') {
    const jsonPath = path.join(baseDir, 'conversations.json');
    fs.writeFileSync(jsonPath, JSON.stringify(oaiFormat, null, 2));
    console.log(`\n✓ Wrote ${jsonPath} (${result.conversations.length} conversations)`);
    console.log('  Compatible with Memory Forge, context-pack, and OpenAI import tools');
  }

  if (opts.format === 'markdown' || opts.format === 'both') {
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

  // Persist file metadata so a later --update can regenerate markdown for
  // unchanged conversations with correct file extensions.
  const manifest = {};
  for (const [fileId, meta] of result.fileMeta) manifest[fileId] = meta;
  fs.writeFileSync(path.join(baseDir, 'files-manifest.json'), JSON.stringify(manifest, null, 2));

  const statsPath = path.join(baseDir, 'export-stats.json');
  fs.writeFileSync(
    statsPath,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        ...result.stats,
        tool: 'chatliberate',
        version: '0.1.4',
      },
      null,
      2,
    ),
  );

  console.log(`\nStats: ${result.stats.conversationCount} conversations, ${result.stats.branchCount} branches, ${result.stats.fileCount} files`);
}

function makeProgress(opts) {
  return (event) => {
    if (event.phase === 'rate-limited') {
      process.stdout.write(`\n  ⏳ ${event.message}\n`);
    } else if (opts.verbose) {
      process.stdout.write(`\n[${event.phase}] ${event.message}`);
    } else if (event.phase === 'downloading' && event.current && event.total) {
      process.stdout.write(`\r  [${event.current}/${event.total}] ${event.message.slice(0, 60).padEnd(60)}`);
    } else if (event.phase === 'indexing') {
      process.stdout.write(`\r  ${event.message}`.padEnd(70));
    }
  };
}

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.bearer) {
    if (opts.nonInteractive) {
      console.error('Bearer token required (--bearer or CHATGPT_BEARER_TOKEN).');
      process.exit(1);
    }
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
  const userId = decodeUserIdFromToken(opts.bearer) ?? 'export';
  const baseDir = path.join(opts.output, userId);

  let knownUpdateTimes;
  let priorConversations = [];
  let priorFileMeta = new Map();
  if (opts.update) {
    ({ priorConversations, knownUpdateTimes, priorFileMeta } = loadPriorExport(baseDir));
    console.log(`Incremental update — ${priorConversations.length} conversations from the previous export.`);
  }

  console.log('\n🚀 ChatLiberate export starting…\n');

  const result = await exportAllConversations(session, {
    includeArchived: opts.includeArchived,
    includeProjects: opts.includeProjects,
    projectsOnly: opts.projectsOnly,
    downloadFiles: opts.downloadFiles,
    downloadImages: opts.downloadImages,
    downloadCanvas: opts.downloadCanvas,
    downloadAttachments: opts.downloadAttachments,
    throttleMs: opts.throttleMs,
    maxConversations: opts.maxConversations,
    conversationIds: opts.conversationIds,
    projectIds: opts.projectIds,
    knownUpdateTimes,
    onProgress: makeProgress(opts),
  });

  // Incremental merge: keep unchanged conversations from the prior export, and
  // fold in prior file metadata so their markdown regenerates correctly.
  if (opts.update) {
    const fetchedIds = new Set(result.conversations.map((c) => c.conversation_id ?? c.id));
    const unchanged = priorConversations.filter((c) => !fetchedIds.has(c.conversation_id ?? c.id));
    result.conversations = [...unchanged, ...result.conversations];
    for (const [fileId, meta] of priorFileMeta) {
      if (!result.fileMeta.has(fileId)) result.fileMeta.set(fileId, meta);
    }
    result.stats.conversationCount = result.conversations.length;
    console.log(`\n  Updated/added ${fetchedIds.size}, unchanged ${unchanged.length}.`);
  }

  console.log('\n');
  writeExport(result, opts, baseDir);
  console.log('\nDone! Your data is yours.\n');
}

main().catch((err) => {
  console.error('\nExport failed:', err.message);
  process.exit(1);
});
