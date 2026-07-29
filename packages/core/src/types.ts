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

export interface ExportOptions {
  includeArchived?: boolean;
  includeProjects?: boolean;
  downloadFiles?: boolean;
  downloadImages?: boolean;
  throttleMs?: number;
  onProgress?: (event: ExportProgressEvent) => void;
  signal?: AbortSignal;
  conversationIds?: string[];
}

export interface ExportProgressEvent {
  phase: 'indexing' | 'downloading' | 'files' | 'complete' | 'error';
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
