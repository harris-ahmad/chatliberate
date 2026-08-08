import type { ChatGPTMessage, Conversation, FileReference } from './types.js';
import { getActivePath, splitBranchesBySharedPrefix } from './branches.js';

/**
 * Headers used when a "Branch in new chat" fork is split. Phrased for the
 * target model you paste into, not ChatGPT's internal UI. Exported so callers
 * can detect that a split happened without brittle inline string matching.
 */
export const CHAT_BRANCH_SHARED_LABEL = '_Earlier context (carried over from a previous chat):_';
export const CHAT_BRANCH_CONTINUES_LABEL = '_This branch continues from here:_';

export function formatDate(timestamp?: number | string | null): string {
  if (!timestamp) return 'unknown';
  try {
    const date =
      typeof timestamp === 'string' ? new Date(timestamp) : new Date(Number(timestamp) * 1000);
    if (Number.isNaN(date.getTime())) return 'unknown';
    return date.toISOString();
  } catch {
    return 'unknown';
  }
}

export function escapeYaml(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
}

export function sanitizeFilename(name: string): string {
  if (!name) return 'untitled';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\.{2,}/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100)
    .replace(/^\.+$/, 'untitled');
}

export function extractFileReferences(conversation: Conversation): FileReference[] {
  const files: FileReference[] = [];
  const mapping = conversation.mapping;
  if (!mapping) return files;

  const conversationId = conversation.conversation_id ?? conversation.id ?? '';

  for (const node of Object.values(mapping)) {
    if (!node.message?.content) continue;
    const content = node.message.content;

    if (content.content_type === 'multimodal_text' && Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (!part || typeof part !== 'object') continue;
        const p = part as Record<string, unknown>;
        if (!p.asset_pointer || typeof p.asset_pointer !== 'string') continue;

        const fileId = p.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
        if (!fileId) continue;

        let type: FileReference['type'] = 'attachment';
        if (p.content_type === 'image_asset_pointer') type = 'image';
        else if (p.content_type === 'canvas_asset_pointer' || p.content_type === 'canvas') type = 'canvas';

        files.push({
          fileId,
          conversationId,
          type,
          metadata: (p.metadata as Record<string, unknown>) ?? {},
          sizeBytes: typeof p.size_bytes === 'number' ? p.size_bytes : undefined,
        });
      }
    }

    if (
      (content.content_type === 'canvas' || content.content_type === 'canvas_asset_pointer') &&
      content.asset_pointer
    ) {
      const fileId = content.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
      if (fileId) {
        files.push({
          fileId,
          conversationId,
          type: 'canvas',
          metadata: content.metadata ?? {},
        });
      }
    }
  }

  return files;
}

// ChatGPT wraps some replies in container directives such as
// :::writing{variant="chat_message" id="47081"} … :::
// The fences are internal markup, not content, so drop them but keep the body.
const DIRECTIVE_OPEN = /^:::+[a-zA-Z][\w-]*(\{[^}]*\})?\s*$/;
const DIRECTIVE_CLOSE = /^:::+\s*$/;
const CODE_FENCE = /^(```|~~~)/;

export function stripDirectiveMarkup(text: string): string {
  if (!text.includes(':::')) return text;

  let inCodeFence = false;
  const kept = text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (CODE_FENCE.test(trimmed)) {
      inCodeFence = !inCodeFence;
      return true;
    }
    if (inCodeFence) return true;
    return !DIRECTIVE_OPEN.test(trimmed) && !DIRECTIVE_CLOSE.test(trimmed);
  });

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Drop repeated parts — ChatGPT sometimes emits the same block twice */
function dedupeParts(parts: string[]): string[] {
  const seen = new Set<string>();
  return parts.filter((part) => {
    const key = part.trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract text from a dict-type message part (audio_transcription, tether_quote, etc.) */
function extractPartText(p: Record<string, unknown>): string {
  // audio_transcription: { content_type: 'audio_transcription', text: '...', direction: 'in'|'out' }
  if (typeof p.text === 'string' && p.text.trim()) return p.text.trim();
  // tether_browsing_display, tether_quote: { content_type, ..., title, url, text }
  if (typeof p.tether_id === 'string') return ''; // skip tether metadata
  // summary inside thoughts
  if (typeof p.summary === 'string' && p.summary.trim()) return p.summary.trim();
  return '';
}

export function extractMessageText(
  message: ChatGPTMessage,
  fileExtMap: Map<string, string> = new Map(),
  filesRelPath = '../files',
): string {
  const content = message.content;
  if (!content) return '';

  // Skip internal tool scaffolding (e.g. {"skipped_mainline":true})
  const role = message.author?.role ?? '';
  if (role === 'tool' || role === 'system') return '';

  if (content.content_type === 'text' && Array.isArray(content.parts)) {
    const parts = content.parts
      .map((p) => (typeof p === 'string' ? p : extractPartText(p as Record<string, unknown>)))
      .map(stripDirectiveMarkup)
      .filter(Boolean);
    return dedupeParts(parts).join('\n');
  }

  if (content.content_type === 'code' && typeof content.text === 'string') {
    // Skip pure JSON blobs that are internal tool state, not user-visible content
    const trimmed = content.text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        JSON.parse(trimmed);
        return ''; // silently drop internal JSON tool messages
      } catch {
        // not valid JSON — render as a code block
      }
    }
    const lang = (content.metadata?.language as string) ?? '';
    return `\`\`\`${lang}\n${content.text}\n\`\`\``;
  }

  if (content.content_type === 'multimodal_text' && Array.isArray(content.parts)) {
    const parts = content.parts
      .map((part) => {
        if (typeof part === 'string') return stripDirectiveMarkup(part);
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (p.content_type === 'image_asset_pointer' && p.asset_pointer) {
            const rawId = String(p.asset_pointer).replace(/^(sediment|file-service):\/\//, '');
            // Look up extension from download map; fallback to no extension
            const ext = fileExtMap.get(rawId) ?? '';
            return `![image](${filesRelPath}/${rawId}${ext})`;
          }
          // audio_transcription, tether_quote, or any dict part with a text field
          return stripDirectiveMarkup(extractPartText(p as Record<string, unknown>));
        }
        return '';
      })
      .filter(Boolean);
    return dedupeParts(parts).join('\n');
  }

  if (content.content_type === 'thoughts' && Array.isArray(content.parts)) {
    const thoughts = content.parts
      .map((p) => (typeof p === 'object' && p && 'summary' in p ? String((p as { summary?: string }).summary) : ''))
      .filter(Boolean)
      .join('\n');
    return thoughts ? `<details><summary>Thinking</summary>\n\n${thoughts}\n\n</details>` : '';
  }

  return '';
}

export function messageToMarkdown(
  message: ChatGPTMessage,
  fileExtMap: Map<string, string> = new Map(),
  filesRelPath = '../files',
): string {
  const role = message.author?.role ?? 'unknown';
  // Skip system, tool, and internal scaffolding messages
  if (role === 'system' || role === 'tool') return '';
  const text = extractMessageText(message, fileExtMap, filesRelPath);
  if (!text.trim()) return '';

  const label = role === 'user' ? '**You**' : '**Assistant**';
  const time = message.create_time ? ` _(${formatDate(message.create_time)})_` : '';
  return `${label}${time}:\n\n${text}\n`;
}

export function conversationToMarkdown(
  conversation: Conversation,
  options: {
    includeAllBranches?: boolean;
    fileExtMap?: Map<string, string>;
    filesRelPath?: string;
    projectName?: string;
  } = {},
): string {
  const title = conversation.title ?? 'Untitled';
  const id = conversation.conversation_id ?? conversation.id ?? '';
  const model = conversation.default_model_slug ?? 'unknown';
  const projectName =
    options.projectName ??
    (typeof conversation._projectName === 'string' ? conversation._projectName : undefined);

  const frontmatterLines = [
    '---',
    `title: "${escapeYaml(title)}"`,
    `id: ${id}`,
    `create_time: ${formatDate(conversation.create_time)}`,
    `update_time: ${formatDate(conversation.update_time)}`,
    `model: ${model}`,
    ...(conversation.gizmo_id ? [`project_id: ${conversation.gizmo_id}`] : []),
    ...(projectName ? [`project: "${escapeYaml(projectName)}"`] : []),
    '---',
  ];
  const frontmatter = frontmatterLines.join('\n') + '\n\n';

  const fmap = options.fileExtMap ?? new Map<string, string>();
  const filesRel = options.filesRelPath ?? '../files';
  const toMd = (m: ChatGPTMessage) => messageToMarkdown(m, fmap, filesRel);

  if (options.includeAllBranches) {
    const split = splitBranchesBySharedPrefix(conversation);
    if (!split) {
      const path = getActivePath(conversation);
      const body = path.messages.map(toMd).filter(Boolean).join('\n');
      return frontmatter + `# ${title}\n\n${body}`;
    }

    const shared = split.shared.map(toMd).filter(Boolean).join('\n');
    const sharedSection = shared ? `## Shared history\n\n${shared}\n\n` : '';

    const sections = split.branches.map((branch, i) => {
      const body = branch.messages.map(toMd).filter(Boolean).join('\n');
      const label = branch.isActive ? `## Branch ${i + 1} (active)` : `## Branch ${i + 1}`;
      return `${label}\n\n${body}`;
    });

    return (
      frontmatter +
      `# ${title}\n\n_${split.count} branches preserved (shared history shown once)_\n\n` +
      `${sharedSection}${sections.join('\n\n---\n\n')}`
    );
  }

  const path = getActivePath(conversation);
  const body = path.messages.map(toMd).filter(Boolean).join('\n');
  return frontmatter + `# ${title}\n\n${body}`;
}

/**
 * Chunk a large markdown string into pieces that fit within a token budget.
 * Approximates 1 token ≈ 4 chars. Default 80k tokens ≈ 320k chars per chunk.
 */
export function chunkMarkdown(
  md: string,
  maxCharsPerChunk = 320_000,
): string[] {
  if (md.length <= maxCharsPerChunk) return [md];

  const chunks: string[] = [];
  // Split on message boundaries (lines starting with **You** or **Assistant**)
  const parts = md.split(/(?=\n\*\*(?:You|Assistant)\*\*)/);
  let current = '';

  for (const part of parts) {
    if ((current + part).length > maxCharsPerChunk && current.length > 0) {
      chunks.push(current);
      current = part;
    } else {
      current += part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * ChatGPT prepends "Branch · " to a title every time you "Branch in new chat",
 * so branched chats arrive as "Branch · Branch · SEO for React Apps". That
 * prefix is UI bookkeeping, meaningless to whatever model you paste into —
 * strip the run. Leaves a normal title untouched.
 */
export function cleanChatTitle(title?: string | null): string {
  const raw = (title ?? '').trim();
  if (!raw) return 'Untitled';
  const cleaned = raw.replace(/(?:Branch\s*·\s*)+/gi, '').trim();
  return cleaned || raw;
}

/** Keep the last `budget` chars of `text`, trimmed to a clean line boundary. */
function keepTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  let tail = text.slice(text.length - budget);
  const nl = tail.indexOf('\n');
  if (nl !== -1) tail = tail.slice(nl + 1);
  return tail.trimStart();
}

/**
 * Produce a compact context block suitable for pasting at the top of a new
 * Claude/Gemini/ChatGPT conversation to seed it with history.
 * Strips frontmatter and collapses whitespace.
 *
 * By default only the active branch is included (best for context limits).
 * Pass includeAllBranches: true to preserve every regenerated reply path.
 *
 * chatBranch handles ChatGPT's "Branch in new chat" UI (linear API path with a
 * "Branched from …" divider): splits shared history vs this fork's new turns.
 */
export function toContextBlock(
  conversations: Conversation[],
  opts: {
    maxChars?: number;
    label?: string;
    fileExtMap?: Map<string, string>;
    includeAllBranches?: boolean;
    /** "Branch in new chat" marker from the page UI */
    chatBranch?: { label: string; firstUserText?: string };
  } = {},
): string {
  const {
    maxChars = 60_000,
    label = 'Previous conversation history',
    fileExtMap = new Map(),
    includeAllBranches = false,
    chatBranch,
  } = opts;

  const imageFileIds: string[] = [];
  const imgPattern = /!\[image\]\(\.\.\/files\/([^)]+)\)/g;

  const formatMessages = (messages: ChatGPTMessage[]) =>
    messages
      .map((m) => {
        const role = m.author?.role === 'user' ? 'User' : 'Assistant';
        let text = extractMessageText(m, fileExtMap).trim();
        if (!text) return '';
        let match: RegExpExecArray | null;
        imgPattern.lastIndex = 0;
        while ((match = imgPattern.exec(text)) !== null) {
          imageFileIds.push(match[1]);
        }
        text = text.replace(imgPattern, '[image attached separately]');
        return `${role}: ${text}`;
      })
      .filter(Boolean)
      .join('\n');

  /** Split a linear path at the first user turn matching the branched-from UI */
  const formatChatBranch = (messages: ChatGPTMessage[]) => {
    const needle = (chatBranch?.firstUserText || '').trim();
    let splitAt = -1;
    if (needle) {
      const norm = needle.replace(/\s+/g, ' ').slice(0, 120).toLowerCase();
      splitAt = messages.findIndex((m) => {
        if (m.author?.role !== 'user') return false;
        const text = extractMessageText(m, fileExtMap).replace(/\s+/g, ' ').trim().toLowerCase();
        if (!text) return false;
        // Short first messages ("hey", "ok") are ambiguous — a loose prefix
        // match could land on an earlier turn, so demand an exact match there.
        if (norm.length < 12) return text === norm;
        return text.startsWith(norm) || norm.startsWith(text.slice(0, 80));
      });
    }
    if (splitAt <= 0) {
      return formatMessages(messages);
    }
    const shared = formatMessages(messages.slice(0, splitAt));
    const branched = formatMessages(messages.slice(splitAt));
    return [
      CHAT_BRANCH_SHARED_LABEL,
      shared,
      '',
      CHAT_BRANCH_CONTINUES_LABEL,
      branched,
    ]
      .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
      .join('\n');
  };

  const lines: string[] = [`<${label}>`, ''];
  let remaining = maxChars - label.length - 50;

  for (const conv of conversations) {
    const title = cleanChatTitle(conv.title);
    const header = `### ${title}\n`;
    let body: string;

    if (includeAllBranches) {
      const split = splitBranchesBySharedPrefix(conv);
      if (!split) {
        body = chatBranch
          ? formatChatBranch(getActivePath(conv).messages)
          : formatMessages(getActivePath(conv).messages);
      } else {
        const branchBlocks = split.branches
          .map((branch, i) => {
            const messages = formatMessages(branch.messages);
            if (!messages) return '';
            const blabel = branch.isActive
              ? `#### Branch ${i + 1} (active)`
              : `#### Branch ${i + 1}`;
            return `${blabel}\n${messages}`;
          })
          .filter(Boolean)
          .join('\n\n');
        // The "Branch in new chat" divider lives in the linear shared history,
        // so apply its split there rather than dropping it when regen branches exist.
        let sharedSection = '';
        if (chatBranch) {
          const forked = formatChatBranch(split.shared);
          if (forked) sharedSection = forked;
        } else {
          const sharedBlock = formatMessages(split.shared);
          if (sharedBlock) sharedSection = `#### Shared history\n${sharedBlock}`;
        }
        const parts = [
          `_${split.count} regenerated branches preserved (shared history shown once)_`,
        ];
        if (sharedSection) parts.push(sharedSection);
        parts.push(branchBlocks);
        body = parts.join('\n\n');
      }
    } else if (chatBranch) {
      body = formatChatBranch(getActivePath(conv).messages);
    } else {
      body = formatMessages(getActivePath(conv).messages);
    }

    const entry = header + body + '\n\n';
    if (entry.length > remaining) {
      // Don't drop the whole conversation — keep its most recent turns (the
      // part you're continuing from) with a marker, then stop. Only bother if
      // there's enough room left for a meaningful slice.
      const marker = `_[Older messages truncated to fit the ${maxChars.toLocaleString()}-character limit — export the full chat for the complete history.]_\n\n`;
      const budget = remaining - header.length - marker.length - 4;
      if (budget > 500) {
        lines.push(`${header}${marker}${keepTail(body, budget)}\n\n`);
      }
      break;
    }
    lines.push(entry);
    remaining -= entry.length;
  }

  if (imageFileIds.length > 0) {
    const unique = [...new Set(imageFileIds)];
    lines.push('---');
    lines.push(`Note: This conversation contained ${unique.length} image(s). They are referenced as [image attached separately] above.`);
    lines.push('To include them, upload these files from the exported ZIP\'s "files/" folder:');
    for (const id of unique) {
      lines.push(`  - files/${id}`);
    }
    lines.push('');
  }

  lines.push(`</${label}>`);
  return lines.join('\n');
}

/** Obsidian-ready filename: YYYY-MM-DD title-slug id8.md */
export function obsidianFilename(conv: Conversation): string {
  const date = conv.create_time
    ? new Date(Number(conv.create_time) * 1000).toISOString().slice(0, 10)
    : 'unknown';
  const slug = (conv.title ?? 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
  const id8 = (conv.conversation_id ?? conv.id ?? '').slice(0, 8);
  return `${date} ${slug} ${id8}.md`;
}

/** Folder-safe slug for project names */
export function slugifySegment(name: string): string {
  const slug = (name || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'untitled';
}

export interface MarkdownPathInfo {
  /** Path under the export root, e.g. markdown/projects/foo/2026-01-01 title id.md */
  path: string;
  /** Relative prefix from that markdown file to the files/ folder */
  filesRelPath: string;
  projectName?: string;
  archived?: boolean;
}

/**
 * Decide where a conversation's markdown should live.
 * Project chats → markdown/projects/<slug>/…
 * Archived (non-project) → markdown/archived/…
 * Everything else → markdown/…
 */
export function markdownExportPath(
  conv: Conversation,
  meta: { projectName?: string; archived?: boolean } = {},
): MarkdownPathInfo {
  const fname = obsidianFilename(conv);
  const projectName =
    meta.projectName ??
    (typeof conv._projectName === 'string' ? conv._projectName : undefined);

  if (projectName) {
    return {
      path: `markdown/projects/${slugifySegment(projectName)}/${fname}`,
      filesRelPath: '../../files',
      projectName,
      archived: meta.archived,
    };
  }

  if (meta.archived || conv.is_archived === true) {
    return {
      path: `markdown/archived/${fname}`,
      filesRelPath: '../../files',
      archived: true,
    };
  }

  return {
    path: `markdown/${fname}`,
    filesRelPath: '../files',
    archived: false,
  };
}

export interface ExportIndexEntry {
  title: string;
  id: string;
  path: string;
  createTime?: number | string | null;
  updateTime?: number | string | null;
  projectName?: string;
  archived?: boolean;
}

/** Searchable INDEX.md listing every exported chat with links into the markdown tree */
export function buildExportIndexMarkdown(
  entries: ExportIndexEntry[],
  opts: { exportedAt?: string; conversationCount?: number; projectCount?: number } = {},
): string {
  const sorted = [...entries].sort((a, b) => {
    const at = Number(a.updateTime ?? a.createTime ?? 0);
    const bt = Number(b.updateTime ?? b.createTime ?? 0);
    return bt - at;
  });

  const projects = new Map<string, ExportIndexEntry[]>();
  const archived: ExportIndexEntry[] = [];
  const inbox: ExportIndexEntry[] = [];

  for (const e of sorted) {
    if (e.projectName) {
      const list = projects.get(e.projectName) ?? [];
      list.push(e);
      projects.set(e.projectName, list);
    } else if (e.archived) {
      archived.push(e);
    } else {
      inbox.push(e);
    }
  }

  const lines: string[] = [
    '# ChatLiberate Export Index',
    '',
    `Exported: ${opts.exportedAt ?? new Date().toISOString()}`,
    `Conversations: ${opts.conversationCount ?? entries.length}`,
    `Projects: ${opts.projectCount ?? projects.size}`,
    '',
    'Jump to a chat below. Links open the Markdown file in this ZIP.',
    '',
  ];

  const linkLine = (e: ExportIndexEntry) => {
    const date = e.updateTime || e.createTime
      ? formatDate(e.updateTime ?? e.createTime).slice(0, 10)
      : 'unknown';
    return `- [${e.title || 'Untitled'}](${e.path}) — ${date}`;
  };

  if (projects.size > 0) {
    lines.push('## Projects', '');
    for (const name of [...projects.keys()].sort((a, b) => a.localeCompare(b))) {
      lines.push(`### ${name}`, '');
      for (const e of projects.get(name)!) lines.push(linkLine(e));
      lines.push('');
    }
  }

  if (inbox.length > 0) {
    lines.push('## Chats', '');
    for (const e of inbox) lines.push(linkLine(e));
    lines.push('');
  }

  if (archived.length > 0) {
    lines.push('## Archived', '');
    for (const e of archived) lines.push(linkLine(e));
    lines.push('');
  }

  return lines.join('\n');
}

