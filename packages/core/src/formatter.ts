import type { ChatGPTMessage, Conversation, FileReference } from './types.js';
import { getActivePath, getAllBranches } from './branches.js';

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

export function extractMessageText(message: ChatGPTMessage): string {
  const content = message.content;
  if (!content) return '';

  if (content.content_type === 'text' && Array.isArray(content.parts)) {
    return content.parts
      .filter((p): p is string => typeof p === 'string')
      .join('\n');
  }

  if (content.content_type === 'code' && typeof content.text === 'string') {
    const lang = (content.metadata?.language as string) ?? '';
    return `\`\`\`${lang}\n${content.text}\n\`\`\``;
  }

  if (content.content_type === 'multimodal_text' && Array.isArray(content.parts)) {
    return content.parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          const p = part as Record<string, unknown>;
          if (p.content_type === 'image_asset_pointer' && p.asset_pointer) {
            const id = String(p.asset_pointer).replace(/^(sediment|file-service):\/\//, '');
            return `![image](files/${id})`;
          }
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
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

export function messageToMarkdown(message: ChatGPTMessage): string {
  const role = message.author?.role ?? 'unknown';
  if (role === 'system') return '';
  const text = extractMessageText(message);
  if (!text.trim()) return '';

  const label = role === 'user' ? '**You**' : '**Assistant**';
  const time = message.create_time ? ` _(${formatDate(message.create_time)})_` : '';
  return `${label}${time}:\n\n${text}\n`;
}

export function conversationToMarkdown(
  conversation: Conversation,
  options: { includeAllBranches?: boolean } = {},
): string {
  const title = conversation.title ?? 'Untitled';
  const id = conversation.conversation_id ?? conversation.id ?? '';
  const model = conversation.default_model_slug ?? 'unknown';

  const frontmatter = [
    '---',
    `title: "${escapeYaml(title)}"`,
    `id: ${id}`,
    `create_time: ${formatDate(conversation.create_time)}`,
    `update_time: ${formatDate(conversation.update_time)}`,
    `model: ${model}`,
    conversation.gizmo_id ? `project_id: ${conversation.gizmo_id}` : null,
    '---',
    '',
  ]
    .filter(Boolean)
    .join('\n');

  if (options.includeAllBranches) {
    const branches = getAllBranches(conversation);
    if (branches.length <= 1) {
      const path = getActivePath(conversation);
      const body = path.messages.map(messageToMarkdown).filter(Boolean).join('\n');
      return frontmatter + `# ${title}\n\n${body}`;
    }

    const sections = branches.map((branch, i) => {
      const body = branch.messages.map(messageToMarkdown).filter(Boolean).join('\n');
      return `## Branch ${i + 1}\n\n${body}`;
    });

    return frontmatter + `# ${title}\n\n_${branches.length} branches preserved_\n\n${sections.join('\n\n---\n\n')}`;
  }

  const path = getActivePath(conversation);
  const body = path.messages.map(messageToMarkdown).filter(Boolean).join('\n');
  return frontmatter + `# ${title}\n\n${body}`;
}
