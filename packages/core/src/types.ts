export interface ChatGPTSession {
  accessToken: string;
  accountId?: string;
  userId?: string;
  email?: string;
}

export interface ConversationSummary {
  id: string;
  title?: string;
  create_time?: number;
  update_time?: number;
  gizmo_id?: string;
  _archived?: boolean;
  _projectName?: string;
  _projectId?: string;
}

export interface MessageNode {
  id?: string;
  message?: ChatGPTMessage | null;
  parent?: string | null;
  children?: string[];
}

export interface ChatGPTMessage {
  id?: string;
  author?: { role?: string; name?: string | null; metadata?: Record<string, unknown> };
  create_time?: number;
  update_time?: number | null;
  content?: MessageContent;
  status?: string;
  metadata?: Record<string, unknown>;
}

export interface MessageContent {
  content_type?: string;
  parts?: unknown[];
  text?: string;
  asset_pointer?: string;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  title?: string;
  create_time?: number;
  update_time?: number;
  mapping?: Record<string, MessageNode>;
  current_node?: string;
  conversation_id?: string;
  id?: string;
  default_model_slug?: string;
  gizmo_id?: string;
  [key: string]: unknown;
}

export interface ProjectInfo {
  id: string;
  name: string;
}

export interface FileReference {
  fileId: string;
  conversationId: string;
  type: 'image' | 'canvas' | 'attachment';
  metadata?: Record<string, unknown>;
  sizeBytes?: number;
}

export interface DownloadedConversation {
  conversation: Conversation;
  files: Map<string, Uint8Array>;
  fileMeta: Map<string, { contentType: string; fileName?: string }>;
}

export interface ExportOptions {
  includeArchived?: boolean;
  includeProjects?: boolean;
  /** Export only project conversations, skipping the regular list. */
  projectsOnly?: boolean;
  downloadFiles?: boolean;
  downloadImages?: boolean;
  /** Download canvas/textdoc assets (default true when downloadFiles). */
  downloadCanvas?: boolean;
  /** Download non-image file attachments (default true when downloadFiles). */
  downloadAttachments?: boolean;
  throttleMs?: number;
  onProgress?: (event: ExportProgressEvent) => void;
  signal?: AbortSignal;
  conversationIds?: string[];
  /** Restrict to these project (gizmo) ids. */
  projectIds?: string[];
  /** Cap the number of conversations downloaded this run. */
  maxConversations?: number;
  /**
   * Incremental update: id → last-seen update_time. Conversations whose current
   * update_time is unchanged are skipped (reuse the prior export's copy).
   */
  knownUpdateTimes?: Record<string, number>;
  /** Conversation ids already saved from a previous run — skip re-downloading. */
  skipIds?: Iterable<string>;
  /**
   * Called after each conversation (and its files) finishes downloading, so a
   * caller can persist it for resume. Runs once per newly downloaded chat.
   */
  onConversationDownloaded?: (downloaded: DownloadedConversation) => void | Promise<void>;
}

export interface ExportProgressEvent {
  phase: 'indexing' | 'downloading' | 'files' | 'complete' | 'error' | 'rate-limited';
  message: string;
  current?: number;
  total?: number;
  conversationId?: string;
}

export interface ExportResult {
  conversations: Conversation[];
  files: Map<string, Uint8Array>;
  fileMeta: Map<string, { contentType: string; fileName?: string }>;
  index: ConversationSummary[];
  stats: {
    conversationCount: number;
    fileCount: number;
    branchCount: number;
    archivedCount: number;
    projectCount: number;
  };
}

export interface BranchPath {
  nodeIds: string[];
  messages: ChatGPTMessage[];
}
