import type {
  ChatGPTMessage,
  Conversation,
  ConversationSummary,
  ExportOptions,
  ExportProgressEvent,
  ExportResult,
  FileReference,
  ProjectInfo,
} from './types.js';
import {
  createHeaders,
  fetchWithRetry,
  getApiBase,
  isRateLimitError,
  setRateLimitNotifier,
  Throttle,
} from './auth.js';
import type { ChatGPTSession } from './types.js';
import { countBranches } from './branches.js';
import {
  buildExportIndexMarkdown,
  conversationToMarkdown,
  extractFileReferences,
  markdownExportPath,
} from './formatter.js';

const CONVERSATIONS_PER_PAGE = 28;

/**
 * Decide which indexed conversations to actually download. Filters, in order:
 * restrict to `conversationIds` / `projectIds`; drop already-saved `skipIds`
 * (resume); drop unchanged ones by `knownUpdateTimes` (incremental --update);
 * finally cap at `maxConversations`. Pure — unit-testable.
 */
export function selectConversationsToDownload(
  index: ConversationSummary[],
  opts: {
    conversationIds?: string[];
    projectIds?: string[];
    skipIds?: Iterable<string>;
    knownUpdateTimes?: Record<string, number>;
    maxConversations?: number;
  } = {},
): ConversationSummary[] {
  let selected = index;

  if (opts.conversationIds?.length) {
    const idSet = new Set(opts.conversationIds);
    selected = selected.filter((c) => idSet.has(c.id));
  }

  if (opts.projectIds?.length) {
    const projSet = new Set(opts.projectIds);
    selected = selected.filter((c) => c._projectId && projSet.has(c._projectId));
  }

  const skip = new Set(opts.skipIds ?? []);
  if (skip.size) {
    selected = selected.filter((c) => !skip.has(c.id));
  }

  if (opts.knownUpdateTimes) {
    const known = opts.knownUpdateTimes;
    selected = selected.filter((c) => {
      const prev = known[c.id];
      // Keep if new, or if the server's copy is newer than what we have.
      return prev === undefined || Number(c.update_time ?? 0) > Number(prev);
    });
  }

  if (opts.maxConversations && opts.maxConversations > 0) {
    selected = selected.slice(0, opts.maxConversations);
  }

  return selected;
}

export async function exportAllConversations(
  session: ChatGPTSession,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const {
    includeArchived = true,
    includeProjects = true,
    projectsOnly = false,
    downloadFiles = true,
    downloadImages = true,
    downloadCanvas = true,
    downloadAttachments = true,
    throttleMs = 1500,
    onProgress,
    signal,
    conversationIds,
    projectIds,
    maxConversations,
    knownUpdateTimes,
    skipIds,
    onConversationDownloaded,
  } = options;

  const throttle = new Throttle(throttleMs);
  const emit = (event: ExportProgressEvent) => onProgress?.(event);

  const index: ConversationSummary[] = [];
  const conversations: Conversation[] = [];
  const files = new Map<string, Uint8Array>();
  const fileMeta = new Map<string, { contentType: string; fileName?: string }>();

  // On each 429: surface the wait to the UI, and permanently slow the pace for
  // the rest of this run so we stop tripping the same limit (adaptive backoff).
  setRateLimitNotifier(({ waitMs }) => {
    throttle.onRateLimit();
    emit({
      phase: 'rate-limited',
      message: `Rate-limited by ChatGPT — waiting ${Math.round(waitMs / 1000)}s, then slowing to ${(
        throttle.intervalMs / 1000
      ).toFixed(1)}s between requests…`,
    });
  });

  try {
  emit({ phase: 'indexing', message: 'Indexing conversations…' });

  await indexConversations(
    session,
    index,
    { includeArchived, includeProjects, projectsOnly },
    throttle,
    emit,
    signal,
  );

  const toDownload = selectConversationsToDownload(index, {
    conversationIds,
    projectIds,
    skipIds,
    knownUpdateTimes,
    maxConversations,
  });

  emit({
    phase: 'downloading',
    message: `Downloading ${toDownload.length} conversations…`,
    total: toDownload.length,
    current: 0,
  });

  let branchCount = 0;
  let archivedCount = 0;
  let projectCount = 0;

  for (let i = 0; i < toDownload.length; i++) {
    if (signal?.aborted) throw new Error('Export cancelled');

    const summary = toDownload[i];
    await throttle.wait();

    try {
      const conv = await fetchConversation(session, summary.id);
      if (summary._projectId || summary._projectName) {
        conv._projectId = summary._projectId;
        conv._projectName = summary._projectName;
        if (!conv.gizmo_id && summary._projectId) conv.gizmo_id = summary._projectId;
      }
      if (summary._archived) conv.is_archived = true;
      conversations.push(conv);
      branchCount += countBranches(conv);
      if (summary._archived) archivedCount++;
      if (summary._projectId) projectCount++;

      emit({
        phase: 'downloading',
        message: `Downloaded: ${summary.title ?? summary.id}`,
        current: i + 1,
        total: toDownload.length,
        conversationId: summary.id,
      });

      const convFiles = new Map<string, Uint8Array>();
      const convFileMeta = new Map<string, { contentType: string; fileName?: string }>();

      if (downloadFiles) {
        const refs = extractFileReferences(conv).filter((ref) => {
          if (ref.type === 'image') return downloadImages;
          if (ref.type === 'canvas') return downloadCanvas;
          if (ref.type === 'attachment') return downloadAttachments;
          return true;
        });

        for (const ref of refs) {
          const cached = files.get(ref.fileId);
          if (cached) {
            // Already downloaded for an earlier conversation — reuse for this
            // conversation's resume payload so it stays self-contained.
            convFiles.set(ref.fileId, cached);
            const meta = fileMeta.get(ref.fileId);
            if (meta) convFileMeta.set(ref.fileId, meta);
            continue;
          }
          await throttle.wait();
          try {
            const downloaded = await downloadFile(session, ref);
            if (downloaded) {
              const meta = { contentType: downloaded.contentType, fileName: downloaded.fileName };
              files.set(ref.fileId, downloaded.data);
              fileMeta.set(ref.fileId, meta);
              convFiles.set(ref.fileId, downloaded.data);
              convFileMeta.set(ref.fileId, meta);
            }
          } catch {
            // Skip individual file failures
          }
        }
      }

      if (onConversationDownloaded) {
        await onConversationDownloaded({ conversation: conv, files: convFiles, fileMeta: convFileMeta });
      }
    } catch (error) {
      // fetchWithRetry already backed off several times; if it's still 429,
      // stop hammering. Resume has saved everything downloaded so far.
      if (isRateLimitError(error)) {
        throw new Error(
          'Export paused — ChatGPT is rate-limiting (HTTP 429). Your progress is saved; wait a few minutes and run Export again to resume.',
        );
      }
      emit({
        phase: 'error',
        message: `Failed: ${summary.title ?? summary.id} — ${(error as Error).message}`,
        conversationId: summary.id,
      });
    }
  }

  emit({ phase: 'complete', message: 'Export complete', current: conversations.length, total: toDownload.length });

  return {
    conversations,
    files,
    fileMeta,
    index: toDownload,
    stats: {
      conversationCount: conversations.length,
      fileCount: files.size,
      branchCount,
      archivedCount,
      projectCount,
    },
  };
  } finally {
    setRateLimitNotifier(null);
  }
}

async function indexConversations(
  session: ChatGPTSession,
  index: ConversationSummary[],
  opts: { includeArchived: boolean; includeProjects: boolean; projectsOnly?: boolean },
  throttle: Throttle,
  emit: (e: ExportProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const seen = new Set<string>();

  // projectsOnly: skip the regular (and archived) conversation lists entirely.
  const listPasses = opts.projectsOnly
    ? []
    : [false, ...(opts.includeArchived ? [true] : [])];

  for (const archived of listPasses) {
    let offset = 0;
    let hasMore = true;

    while (hasMore) {
      if (signal?.aborted) throw new Error('Export cancelled');
      await throttle.wait();

      const url = `${getApiBase()}/conversations?offset=${offset}&limit=${CONVERSATIONS_PER_PAGE}&order=updated&is_archived=${archived}`;
      const response = await fetchWithRetry(url, { headers: createHeaders(session) });
      const data = await response.json();

      const items = data.items ?? [];
      for (const item of items) {
        if (!seen.has(item.id)) {
          seen.add(item.id);
          index.push({ ...item, _archived: archived });
        }
      }

      emit({
        phase: 'indexing',
        message: `Found ${index.length} conversations…`,
        current: index.length,
      });

      offset += items.length;
      hasMore = items.length === CONVERSATIONS_PER_PAGE;
    }
  }

  if (opts.includeProjects || opts.projectsOnly) {
    await throttle.wait();
    const projects = await fetchProjects(session);

    for (const project of projects) {
      if (signal?.aborted) throw new Error('Export cancelled');

      let cursor: string | null = null;
      let hasMore = true;

      while (hasMore) {
        await throttle.wait();
        const { items, nextCursor } = await fetchProjectConversations(session, project.id, cursor);

        for (const item of items) {
          if (!seen.has(item.id)) {
            seen.add(item.id);
            index.push({
              ...item,
              _projectName: project.name,
              _projectId: project.id,
            });
          }
        }

        cursor = nextCursor;
        hasMore = Boolean(nextCursor && items.length > 0);
      }
    }
  }
}

export async function fetchConversation(
  session: ChatGPTSession,
  conversationId: string,
): Promise<Conversation> {
  const url = `${getApiBase()}/conversation/${conversationId}`;
  const response = await fetchWithRetry(url, { headers: createHeaders(session) });
  return response.json();
}

export async function fetchProjects(session: ChatGPTSession): Promise<ProjectInfo[]> {
  const url = `${getApiBase()}/gizmos/snorlax/sidebar`;
  const response = await fetchWithRetry(url, { headers: createHeaders(session) });
  const data = await response.json();
  const projects: ProjectInfo[] = [];

  for (const item of data.items ?? []) {
    const gizmo = item.gizmo ?? item;
    if (gizmo?.id && gizmo?.display?.name) {
      projects.push({ id: gizmo.id, name: gizmo.display.name });
    }
  }

  return projects;
}

async function fetchProjectConversations(
  session: ChatGPTSession,
  projectId: string,
  cursor: string | null,
): Promise<{ items: ConversationSummary[]; nextCursor: string | null }> {
  const params = new URLSearchParams({ limit: '50' });
  if (cursor) params.set('cursor', cursor);

  const url = `${getApiBase()}/gizmos/${projectId}/conversations?${params}`;
  const response = await fetchWithRetry(url, { headers: createHeaders(session) });
  const data = await response.json();

  return {
    items: (data.items ?? []).map((item: ConversationSummary) => ({
      id: item.id,
      title: item.title,
      create_time: item.create_time,
      update_time: item.update_time,
    })),
    nextCursor: data.cursor ?? null,
  };
}

async function downloadFile(
  session: ChatGPTSession,
  ref: FileReference,
): Promise<{ data: Uint8Array; contentType: string; fileName?: string } | null> {
  const metaUrl = `${getApiBase()}/files/download/${ref.fileId}?conversation_id=${ref.conversationId}&inline=false`;
  const metaResponse = await fetchWithRetry(metaUrl, { headers: createHeaders(session) });
  const meta = await metaResponse.json();

  if (meta.status !== 'success' || !meta.download_url) return null;

  const fileResponse = await fetchWithRetry(meta.download_url, {
    headers: createHeaders(session),
  });

  const buffer = new Uint8Array(await fileResponse.arrayBuffer());
  return {
    data: buffer,
    contentType: fileResponse.headers.get('content-type') || 'application/octet-stream',
    fileName: meta.file_name,
  };
}

export interface MemoryItem {
  id?: string;
  content?: string;
  enabled?: boolean;
  created_at?: number;
  updated_at?: number;
}

export interface CustomInstructions {
  about_user?: string;
  about_model?: string;
  enabled_for_chat?: boolean;
}

export async function fetchMemories(session: ChatGPTSession): Promise<MemoryItem[]> {
  const url = `${getApiBase()}/memories`;
  const response = await fetchWithRetry(url, { headers: createHeaders(session) });
  const data = await response.json();
  // API returns { memories: [...] } or a direct array
  return data.memories ?? data ?? [];
}

export async function fetchCustomInstructions(session: ChatGPTSession): Promise<CustomInstructions> {
  const url = `${getApiBase()}/user_system_messages`;
  const response = await fetchWithRetry(url, { headers: createHeaders(session) });
  return response.json();
}

export function memoriesToMarkdown(memories: MemoryItem[]): string {
  if (!memories.length) return '# ChatGPT Memories\n\n_No memories found._\n';
  const lines = memories
    .filter((m) => m.content)
    .map((m) => {
      const status = m.enabled === false ? ' _(disabled)_' : '';
      return `- ${m.content}${status}`;
    });
  return `# ChatGPT Memories\n\n${lines.join('\n')}\n`;
}

export function customInstructionsToMarkdown(ci: CustomInstructions): string {
  const sections: string[] = ['# Custom Instructions\n'];
  if (ci.about_user) sections.push(`## About You\n\n${ci.about_user}\n`);
  if (ci.about_model) sections.push(`## How You Want ChatGPT to Respond\n\n${ci.about_model}\n`);
  if (!ci.about_user && !ci.about_model) sections.push('_No custom instructions set._\n');
  return sections.join('\n');
}

/** Produce OpenAI-compatible conversations.json (array format Memory Forge expects). */
export function toOpenAIExportFormat(conversations: Conversation[]): Conversation[] {
  return conversations.map((conv) => ({
    ...conv,
    conversation_id: conv.conversation_id ?? conv.id,
  }));
}

export function toMarkdownBundle(
  conversations: Conversation[],
  fileMeta?: Map<string, { contentType: string; fileName?: string }>,
): Map<string, string> {
  // Build fileId -> extension map from downloaded file metadata
  const fileExtMap = new Map<string, string>();
  if (fileMeta) {
    for (const [fileId, meta] of fileMeta) {
      let ext = '';
      if (meta.fileName) {
        const dot = meta.fileName.lastIndexOf('.');
        if (dot !== -1) ext = meta.fileName.slice(dot);
      } else if (meta.contentType) {
        const mime: Record<string, string> = {
          'image/jpeg': '.jpeg', 'image/jpg': '.jpeg', 'image/png': '.png',
          'image/gif': '.gif', 'image/webp': '.webp',
        };
        ext = mime[meta.contentType.split(';')[0].trim()] ?? '';
      }
      if (ext) fileExtMap.set(fileId, ext);
    }
  }

  const bundle = new Map<string, string>();
  for (const conv of conversations) {
    const id = conv.conversation_id ?? conv.id ?? 'unknown';
    bundle.set(id, conversationToMarkdown(conv, { includeAllBranches: true, fileExtMap }));
  }
  return bundle;
}

export interface MarkdownExportLayout {
  /** Full export-relative paths → markdown content */
  files: Map<string, string>;
  indexMarkdown: string;
  entries: import('./formatter.js').ExportIndexEntry[];
}

/** Markdown tree with project/archived folders + searchable INDEX.md */
export function toMarkdownExportLayout(
  conversations: Conversation[],
  opts: {
    fileMeta?: Map<string, { contentType: string; fileName?: string }>;
    index?: ConversationSummary[];
    exportedAt?: string;
  } = {},
): MarkdownExportLayout {
  const { fileMeta, index = [], exportedAt } = opts;

  const fileExtMap = new Map<string, string>();
  if (fileMeta) {
    for (const [fileId, meta] of fileMeta) {
      let ext = '';
      if (meta.fileName) {
        const dot = meta.fileName.lastIndexOf('.');
        if (dot !== -1) ext = meta.fileName.slice(dot);
      } else if (meta.contentType) {
        const mime: Record<string, string> = {
          'image/jpeg': '.jpeg', 'image/jpg': '.jpeg', 'image/png': '.png',
          'image/gif': '.gif', 'image/webp': '.webp',
        };
        ext = mime[meta.contentType.split(';')[0].trim()] ?? '';
      }
      if (ext) fileExtMap.set(fileId, ext);
    }
  }

  const summaryById = new Map(index.map((s) => [s.id, s]));
  const files = new Map<string, string>();
  const entries: import('./formatter.js').ExportIndexEntry[] = [];
  const projectNames = new Set<string>();

  for (const conv of conversations) {
    const id = conv.conversation_id ?? conv.id ?? 'unknown';
    const summary = summaryById.get(id);
    const projectName =
      (typeof conv._projectName === 'string' ? conv._projectName : undefined) ??
      summary?._projectName;
    const archived = Boolean(conv.is_archived ?? summary?._archived);

    const pathInfo = markdownExportPath(conv, { projectName, archived });
    const md = conversationToMarkdown(conv, {
      includeAllBranches: true,
      fileExtMap,
      filesRelPath: pathInfo.filesRelPath,
      projectName: pathInfo.projectName,
    });
    files.set(pathInfo.path, md);

    if (pathInfo.projectName) projectNames.add(pathInfo.projectName);

    entries.push({
      title: conv.title ?? 'Untitled',
      id,
      path: pathInfo.path,
      createTime: conv.create_time,
      updateTime: conv.update_time,
      projectName: pathInfo.projectName,
      archived: pathInfo.archived,
    });
  }

  const indexMarkdown = buildExportIndexMarkdown(entries, {
    exportedAt: exportedAt ?? new Date().toISOString(),
    conversationCount: entries.length,
    projectCount: projectNames.size,
  });

  return { files, indexMarkdown, entries };
}

export async function exportSingleConversation(
  session: ChatGPTSession,
  conversationId: string,
  options: Pick<ExportOptions, 'downloadFiles' | 'downloadImages' | 'onProgress'> = {},
): Promise<ExportResult> {
  const { downloadFiles = true, downloadImages = true, onProgress } = options;
  const emit = (event: ExportProgressEvent) => onProgress?.(event);

  // Fetch the one conversation directly — no need to index the whole account,
  // and /conversation/{id} works for archived and Project chats too.
  emit({ phase: 'downloading', message: 'Downloading conversation…', total: 1, current: 0 });

  const conv = await fetchConversation(session, conversationId);

  const files = new Map<string, Uint8Array>();
  const fileMeta = new Map<string, { contentType: string; fileName?: string }>();

  if (downloadFiles) {
    const throttle = new Throttle(800);
    const refs = extractFileReferences(conv).filter((ref) =>
      ref.type === 'image' ? downloadImages : true,
    );

    for (const ref of refs) {
      if (files.has(ref.fileId)) continue;
      await throttle.wait();
      try {
        const downloaded = await downloadFile(session, ref);
        if (downloaded) {
          files.set(ref.fileId, downloaded.data);
          fileMeta.set(ref.fileId, {
            contentType: downloaded.contentType,
            fileName: downloaded.fileName,
          });
        }
      } catch {
        // Skip individual file failures
      }
    }
  }

  emit({ phase: 'complete', message: 'Export complete', current: 1, total: 1, conversationId });

  const id = conv.conversation_id ?? conv.id ?? conversationId;
  const index: ConversationSummary[] = [
    {
      id,
      title: conv.title,
      create_time: conv.create_time,
      update_time: conv.update_time,
      gizmo_id: conv.gizmo_id,
      _archived: conv.is_archived === true ? true : undefined,
    },
  ];

  return {
    conversations: [conv],
    files,
    fileMeta,
    index,
    stats: {
      conversationCount: 1,
      fileCount: files.size,
      branchCount: countBranches(conv),
      archivedCount: conv.is_archived === true ? 1 : 0,
      projectCount: conv.gizmo_id ? 1 : 0,
    },
  };
}
