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
  Throttle,
} from './auth.js';
import type { ChatGPTSession } from './types.js';
import { countBranches } from './branches.js';
import { conversationToMarkdown, extractFileReferences } from './formatter.js';

const CONVERSATIONS_PER_PAGE = 28;

export async function exportAllConversations(
  session: ChatGPTSession,
  options: ExportOptions = {},
): Promise<ExportResult> {
  const {
    includeArchived = true,
    includeProjects = true,
    downloadFiles = true,
    downloadImages = true,
    throttleMs = 1500,
    onProgress,
    signal,
    conversationIds,
  } = options;

  const throttle = new Throttle(throttleMs);
  const emit = (event: ExportProgressEvent) => onProgress?.(event);

  const index: ConversationSummary[] = [];
  const conversations: Conversation[] = [];
  const files = new Map<string, Uint8Array>();
  const fileMeta = new Map<string, { contentType: string; fileName?: string }>();

  emit({ phase: 'indexing', message: 'Indexing conversations…' });

  await indexConversations(session, index, { includeArchived, includeProjects }, throttle, emit, signal);

  let toDownload = index;
  if (conversationIds?.length) {
    const idSet = new Set(conversationIds);
    toDownload = index.filter((c) => idSet.has(c.id));
  }

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

      if (downloadFiles) {
        const refs = extractFileReferences(conv).filter((ref) => {
          if (ref.type === 'image') return downloadImages;
          return true;
        });

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
    } catch (error) {
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
}

async function indexConversations(
  session: ChatGPTSession,
  index: ConversationSummary[],
  opts: { includeArchived: boolean; includeProjects: boolean },
  throttle: Throttle,
  emit: (e: ExportProgressEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const seen = new Set<string>();

  for (const archived of [false, ...(opts.includeArchived ? [true] : [])]) {
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

  if (opts.includeProjects) {
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

/** Produce OpenAI-compatible conversations.json (array format Memory Forge expects). */
export function toOpenAIExportFormat(conversations: Conversation[]): Conversation[] {
  return conversations.map((conv) => ({
    ...conv,
    conversation_id: conv.conversation_id ?? conv.id,
  }));
}

export function toMarkdownBundle(conversations: Conversation[]): Map<string, string> {
  const bundle = new Map<string, string>();
  for (const conv of conversations) {
    const id = conv.conversation_id ?? conv.id ?? 'unknown';
    bundle.set(id, conversationToMarkdown(conv, { includeAllBranches: true }));
  }
  return bundle;
}

export async function exportSingleConversation(
  session: ChatGPTSession,
  conversationId: string,
  options: Pick<ExportOptions, 'downloadFiles' | 'downloadImages' | 'onProgress'> = {},
): Promise<ExportResult> {
  return exportAllConversations(session, {
    ...options,
    conversationIds: [conversationId],
    includeArchived: false,
    includeProjects: false,
  });
}
