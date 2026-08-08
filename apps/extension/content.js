(() => {
  // packages/core/dist/index.js
  var API_BASE = "https://chatgpt.com/backend-api";
  function getApiBase() {
    return API_BASE;
  }
  function createHeaders(session) {
    const headers = {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.accessToken}`,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    };
    if (session.accountId) {
      headers["chatgpt-account-id"] = session.accountId;
    }
    return headers;
  }
  async function fetchSessionFromPage() {
    const response = await fetch("/api/auth/session", { credentials: "include" });
    if (!response.ok) {
      throw new Error("Not logged in to ChatGPT. Open chatgpt.com and sign in first.");
    }
    const data = await response.json();
    if (!data.accessToken) {
      throw new Error("No access token in session. Refresh chatgpt.com and try again.");
    }
    const accountId = getAccountIdFromCookie();
    return {
      accessToken: data.accessToken,
      accountId: accountId ?? data.account?.id,
      userId: data.user?.id,
      email: data.user?.email
    };
  }
  function getAccountIdFromCookie() {
    if (typeof document === "undefined") return void 0;
    const match = document.cookie.match(/(?:^|;\s*)_account=([^;]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : void 0;
  }
  async function fetchWithRetry(url, options, retries = 5) {
    for (let attempt = 0; attempt < retries; attempt++) {
      const response = await fetch(url, options);
      if (response.status === 401 || response.status === 403) {
        const error = new Error(
          `Authentication failed (${response.status}). Refresh ChatGPT and try again.`
        );
        error.authError = true;
        throw error;
      }
      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get("retry-after") || "60", 10);
        const waitMs = (retryAfter > 0 ? retryAfter : 30 + attempt * 15) * 1e3;
        await sleep(waitMs);
        continue;
      }
      if (!response.ok) {
        if (response.status === 404) {
          const error = new Error(`Not found: ${url}`);
          error.noRetry = true;
          throw error;
        }
        if (attempt === retries - 1) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        await sleep(2e3 * (attempt + 1));
        continue;
      }
      return response;
    }
    throw new Error("Request failed after maximum retries");
  }
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  var Throttle = class {
    constructor(ms) {
      this.ms = ms;
    }
    ms;
    lastRequest = 0;
    async wait() {
      if (this.ms <= 0) return;
      const elapsed = Date.now() - this.lastRequest;
      const remaining = this.ms - elapsed;
      if (remaining > 0) await sleep(remaining);
      this.lastRequest = Date.now();
    }
    onRateLimit() {
      this.ms = Math.min(this.ms + 2e3, 12e4);
    }
  };
  function buildEffectiveChildren(mapping) {
    const children = /* @__PURE__ */ new Map();
    const add = (parentId, childId) => {
      if (!mapping[parentId] || !mapping[childId]) return;
      let set = children.get(parentId);
      if (!set) {
        set = /* @__PURE__ */ new Set();
        children.set(parentId, set);
      }
      set.add(childId);
    };
    for (const [id, node] of Object.entries(mapping)) {
      for (const childId of node.children ?? []) {
        add(id, childId);
      }
      if (node.parent) {
        add(node.parent, id);
      }
    }
    return new Map(
      [...children.entries()].map(([id, set]) => [id, [...set]])
    );
  }
  function effectiveChildren(tree, nodeId) {
    return tree.get(nodeId) ?? [];
  }
  function getLeafNodeIds(mapping) {
    const tree = buildEffectiveChildren(mapping);
    return Object.keys(mapping).filter(
      (id) => effectiveChildren(tree, id).length === 0
    );
  }
  function pathToRoot(mapping, leafId) {
    const path = [];
    let current = leafId;
    const guard = /* @__PURE__ */ new Set();
    while (current) {
      if (guard.has(current)) break;
      guard.add(current);
      path.push(current);
      const node = mapping[current];
      if (!node?.parent) break;
      current = node.parent;
    }
    return path.reverse();
  }
  function pathHasVisibleMessages(mapping, nodeIds) {
    return nodeIds.some((id) => {
      const role = mapping[id]?.message?.author?.role;
      return role === "user" || role === "assistant";
    });
  }
  function keepMaximalPaths(branches) {
    return branches.filter((branch) => {
      const key = branch.nodeIds.join(">");
      return !branches.some(
        (other) => other !== branch && other.nodeIds.length > branch.nodeIds.length && other.nodeIds.join(">").startsWith(`${key}>`)
      );
    });
  }
  function getActivePath(conversation) {
    const mapping = conversation.mapping ?? {};
    const leafId = conversation.current_node ?? findDefaultLeaf(mapping);
    const nodeIds = pathToRoot(mapping, leafId);
    return {
      nodeIds,
      messages: nodeIds.map((id) => mapping[id]?.message).filter((m) => Boolean(m?.content))
    };
  }
  function getAllBranches(conversation) {
    const mapping = conversation.mapping ?? {};
    const leaves = getLeafNodeIds(mapping);
    const seen = /* @__PURE__ */ new Set();
    const branches = [];
    for (const leafId of leaves) {
      const nodeIds = pathToRoot(mapping, leafId);
      if (!pathHasVisibleMessages(mapping, nodeIds)) continue;
      const key = nodeIds.join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      branches.push({
        nodeIds,
        messages: nodeIds.map((id) => mapping[id]?.message).filter((m) => Boolean(m?.content))
      });
    }
    const maximal = keepMaximalPaths(branches);
    const activeLeaf = conversation.current_node;
    if (activeLeaf) {
      maximal.sort((a, b) => {
        const aIsLeaf = a.nodeIds[a.nodeIds.length - 1] === activeLeaf ? 0 : 1;
        const bIsLeaf = b.nodeIds[b.nodeIds.length - 1] === activeLeaf ? 0 : 1;
        return aIsLeaf - bIsLeaf;
      });
    }
    return maximal;
  }
  function countBranches(conversation) {
    return getAllBranches(conversation).length;
  }
  function splitBranchesBySharedPrefix(conversation) {
    const branches = getAllBranches(conversation);
    if (branches.length <= 1) return null;
    const mapping = conversation.mapping ?? {};
    const idLists = branches.map((b) => b.nodeIds);
    const minLen = Math.min(...idLists.map((l) => l.length));
    let prefixLen = 0;
    while (prefixLen < minLen && idLists.every((l) => l[prefixLen] === idLists[0][prefixLen])) {
      prefixLen++;
    }
    if (prefixLen >= minLen) prefixLen = minLen - 1;
    const toMessages = (ids) => ids.map((id) => mapping[id]?.message).filter((m) => Boolean(m?.content));
    const activeLeaf = conversation.current_node;
    return {
      shared: toMessages(idLists[0].slice(0, prefixLen)),
      branches: branches.map((b) => ({
        nodeIds: b.nodeIds,
        messages: toMessages(b.nodeIds.slice(prefixLen)),
        isActive: Boolean(
          activeLeaf && b.nodeIds[b.nodeIds.length - 1] === activeLeaf
        )
      })),
      count: branches.length
    };
  }
  function findDefaultLeaf(mapping) {
    const leaves = getLeafNodeIds(mapping);
    return leaves[0] ?? Object.keys(mapping)[0] ?? "";
  }
  function formatDate(timestamp) {
    if (!timestamp) return "unknown";
    try {
      const date = typeof timestamp === "string" ? new Date(timestamp) : new Date(Number(timestamp) * 1e3);
      if (Number.isNaN(date.getTime())) return "unknown";
      return date.toISOString();
    } catch {
      return "unknown";
    }
  }
  function escapeYaml(str) {
    return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
  }
  function extractFileReferences(conversation) {
    const files = [];
    const mapping = conversation.mapping;
    if (!mapping) return files;
    const conversationId = conversation.conversation_id ?? conversation.id ?? "";
    for (const node of Object.values(mapping)) {
      if (!node.message?.content) continue;
      const content = node.message.content;
      if (content.content_type === "multimodal_text" && Array.isArray(content.parts)) {
        for (const part of content.parts) {
          if (!part || typeof part !== "object") continue;
          const p = part;
          if (!p.asset_pointer || typeof p.asset_pointer !== "string") continue;
          const fileId = p.asset_pointer.replace(/^(sediment|file-service):\/\//, "");
          if (!fileId) continue;
          let type = "attachment";
          if (p.content_type === "image_asset_pointer") type = "image";
          else if (p.content_type === "canvas_asset_pointer" || p.content_type === "canvas") type = "canvas";
          files.push({
            fileId,
            conversationId,
            type,
            metadata: p.metadata ?? {},
            sizeBytes: typeof p.size_bytes === "number" ? p.size_bytes : void 0
          });
        }
      }
      if ((content.content_type === "canvas" || content.content_type === "canvas_asset_pointer") && content.asset_pointer) {
        const fileId = content.asset_pointer.replace(/^(sediment|file-service):\/\//, "");
        if (fileId) {
          files.push({
            fileId,
            conversationId,
            type: "canvas",
            metadata: content.metadata ?? {}
          });
        }
      }
    }
    return files;
  }
  var DIRECTIVE_OPEN = /^:::+[a-zA-Z][\w-]*(\{[^}]*\})?\s*$/;
  var DIRECTIVE_CLOSE = /^:::+\s*$/;
  var CODE_FENCE = /^(```|~~~)/;
  function stripDirectiveMarkup(text) {
    if (!text.includes(":::")) return text;
    let inCodeFence = false;
    const kept = text.split("\n").filter((line) => {
      const trimmed = line.trim();
      if (CODE_FENCE.test(trimmed)) {
        inCodeFence = !inCodeFence;
        return true;
      }
      if (inCodeFence) return true;
      return !DIRECTIVE_OPEN.test(trimmed) && !DIRECTIVE_CLOSE.test(trimmed);
    });
    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function dedupeParts(parts) {
    const seen = /* @__PURE__ */ new Set();
    return parts.filter((part) => {
      const key = part.trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  function extractPartText(p) {
    if (typeof p.text === "string" && p.text.trim()) return p.text.trim();
    if (typeof p.tether_id === "string") return "";
    if (typeof p.summary === "string" && p.summary.trim()) return p.summary.trim();
    return "";
  }
  function extractMessageText(message, fileExtMap = /* @__PURE__ */ new Map(), filesRelPath = "../files") {
    const content = message.content;
    if (!content) return "";
    const role = message.author?.role ?? "";
    if (role === "tool" || role === "system") return "";
    if (content.content_type === "text" && Array.isArray(content.parts)) {
      const parts = content.parts.map((p) => typeof p === "string" ? p : extractPartText(p)).map(stripDirectiveMarkup).filter(Boolean);
      return dedupeParts(parts).join("\n");
    }
    if (content.content_type === "code" && typeof content.text === "string") {
      const trimmed = content.text.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          JSON.parse(trimmed);
          return "";
        } catch {
        }
      }
      const lang = content.metadata?.language ?? "";
      return `\`\`\`${lang}
${content.text}
\`\`\``;
    }
    if (content.content_type === "multimodal_text" && Array.isArray(content.parts)) {
      const parts = content.parts.map((part) => {
        if (typeof part === "string") return stripDirectiveMarkup(part);
        if (part && typeof part === "object") {
          const p = part;
          if (p.content_type === "image_asset_pointer" && p.asset_pointer) {
            const rawId = String(p.asset_pointer).replace(/^(sediment|file-service):\/\//, "");
            const ext = fileExtMap.get(rawId) ?? "";
            return `![image](${filesRelPath}/${rawId}${ext})`;
          }
          return stripDirectiveMarkup(extractPartText(p));
        }
        return "";
      }).filter(Boolean);
      return dedupeParts(parts).join("\n");
    }
    if (content.content_type === "thoughts" && Array.isArray(content.parts)) {
      const thoughts = content.parts.map((p) => typeof p === "object" && p && "summary" in p ? String(p.summary) : "").filter(Boolean).join("\n");
      return thoughts ? `<details><summary>Thinking</summary>

${thoughts}

</details>` : "";
    }
    return "";
  }
  function messageToMarkdown(message, fileExtMap = /* @__PURE__ */ new Map(), filesRelPath = "../files") {
    const role = message.author?.role ?? "unknown";
    if (role === "system" || role === "tool") return "";
    const text = extractMessageText(message, fileExtMap, filesRelPath);
    if (!text.trim()) return "";
    const label = role === "user" ? "**You**" : "**Assistant**";
    const time = message.create_time ? ` _(${formatDate(message.create_time)})_` : "";
    return `${label}${time}:

${text}
`;
  }
  function conversationToMarkdown(conversation, options = {}) {
    const title = conversation.title ?? "Untitled";
    const id = conversation.conversation_id ?? conversation.id ?? "";
    const model = conversation.default_model_slug ?? "unknown";
    const projectName = options.projectName ?? (typeof conversation._projectName === "string" ? conversation._projectName : void 0);
    const frontmatterLines = [
      "---",
      `title: "${escapeYaml(title)}"`,
      `id: ${id}`,
      `create_time: ${formatDate(conversation.create_time)}`,
      `update_time: ${formatDate(conversation.update_time)}`,
      `model: ${model}`,
      ...conversation.gizmo_id ? [`project_id: ${conversation.gizmo_id}`] : [],
      ...projectName ? [`project: "${escapeYaml(projectName)}"`] : [],
      "---"
    ];
    const frontmatter = frontmatterLines.join("\n") + "\n\n";
    const fmap = options.fileExtMap ?? /* @__PURE__ */ new Map();
    const filesRel = options.filesRelPath ?? "../files";
    const toMd = (m) => messageToMarkdown(m, fmap, filesRel);
    if (options.includeAllBranches) {
      const split = splitBranchesBySharedPrefix(conversation);
      if (!split) {
        const path2 = getActivePath(conversation);
        const body2 = path2.messages.map(toMd).filter(Boolean).join("\n");
        return frontmatter + `# ${title}

${body2}`;
      }
      const shared = split.shared.map(toMd).filter(Boolean).join("\n");
      const sharedSection = shared ? `## Shared history

${shared}

` : "";
      const sections = split.branches.map((branch, i) => {
        const body2 = branch.messages.map(toMd).filter(Boolean).join("\n");
        const label = branch.isActive ? `## Branch ${i + 1} (active)` : `## Branch ${i + 1}`;
        return `${label}

${body2}`;
      });
      return frontmatter + `# ${title}

_${split.count} branches preserved (shared history shown once)_

${sharedSection}${sections.join("\n\n---\n\n")}`;
    }
    const path = getActivePath(conversation);
    const body = path.messages.map(toMd).filter(Boolean).join("\n");
    return frontmatter + `# ${title}

${body}`;
  }
  function chunkMarkdown(md, maxCharsPerChunk = 32e4) {
    if (md.length <= maxCharsPerChunk) return [md];
    const chunks = [];
    const parts = md.split(/(?=\n\*\*(?:You|Assistant)\*\*)/);
    let current = "";
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
  function toContextBlock(conversations, opts = {}) {
    const {
      maxChars = 6e4,
      label = "Previous conversation history",
      fileExtMap = /* @__PURE__ */ new Map(),
      includeAllBranches = false,
      chatBranch
    } = opts;
    const imageFileIds = [];
    const imgPattern = /!\[image\]\(\.\.\/files\/([^)]+)\)/g;
    const formatMessages = (messages) => messages.map((m) => {
      const role = m.author?.role === "user" ? "User" : "Assistant";
      let text = extractMessageText(m, fileExtMap).trim();
      if (!text) return "";
      let match;
      imgPattern.lastIndex = 0;
      while ((match = imgPattern.exec(text)) !== null) {
        imageFileIds.push(match[1]);
      }
      text = text.replace(imgPattern, "[image attached separately]");
      return `${role}: ${text}`;
    }).filter(Boolean).join("\n");
    const formatChatBranch = (messages) => {
      const needle = (chatBranch?.firstUserText || "").trim();
      let splitAt = -1;
      if (needle) {
        const norm = needle.replace(/\s+/g, " ").slice(0, 120).toLowerCase();
        splitAt = messages.findIndex((m) => {
          if (m.author?.role !== "user") return false;
          const text = extractMessageText(m, fileExtMap).replace(/\s+/g, " ").trim().toLowerCase();
          return text.startsWith(norm) || norm.startsWith(text.slice(0, 80));
        });
      }
      if (splitAt <= 0) {
        return formatMessages(messages);
      }
      const shared = formatMessages(messages.slice(0, splitAt));
      const branched = formatMessages(messages.slice(splitAt));
      const from = chatBranch?.label || "Branched chat";
      return [
        "#### Shared history (before branch)",
        shared,
        "",
        `#### ${from}`,
        branched
      ].filter((line, i, arr) => !(line === "" && arr[i - 1] === "")).join("\n");
    };
    const lines = [`<${label}>`, ""];
    let remaining = maxChars - label.length - 50;
    for (const conv of conversations) {
      const title = conv.title ?? "Untitled";
      const header = `### ${title}
`;
      let body;
      if (includeAllBranches) {
        const split = splitBranchesBySharedPrefix(conv);
        if (!split) {
          body = chatBranch ? formatChatBranch(getActivePath(conv).messages) : formatMessages(getActivePath(conv).messages);
        } else {
          const branchBlocks = split.branches.map((branch, i) => {
            const messages = formatMessages(branch.messages);
            if (!messages) return "";
            const blabel = branch.isActive ? `#### Branch ${i + 1} (active)` : `#### Branch ${i + 1}`;
            return `${blabel}
${messages}`;
          }).filter(Boolean).join("\n\n");
          const sharedBlock = formatMessages(split.shared);
          const parts = [
            `_${split.count} regenerated branches preserved (shared history shown once)_`
          ];
          if (sharedBlock) parts.push(`#### Shared history
${sharedBlock}`);
          parts.push(branchBlocks);
          body = parts.join("\n\n");
        }
      } else if (chatBranch) {
        body = formatChatBranch(getActivePath(conv).messages);
      } else {
        body = formatMessages(getActivePath(conv).messages);
      }
      const entry = header + body + "\n\n";
      if (entry.length > remaining) break;
      lines.push(entry);
      remaining -= entry.length;
    }
    if (imageFileIds.length > 0) {
      const unique = [...new Set(imageFileIds)];
      lines.push("---");
      lines.push(`Note: This conversation contained ${unique.length} image(s). They are referenced as [image attached separately] above.`);
      lines.push(`To include them, upload these files from the exported ZIP's "files/" folder:`);
      for (const id of unique) {
        lines.push(`  - files/${id}`);
      }
      lines.push("");
    }
    lines.push(`</${label}>`);
    return lines.join("\n");
  }
  function obsidianFilename(conv) {
    const date = conv.create_time ? new Date(Number(conv.create_time) * 1e3).toISOString().slice(0, 10) : "unknown";
    const slug = (conv.title ?? "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50);
    const id8 = (conv.conversation_id ?? conv.id ?? "").slice(0, 8);
    return `${date} ${slug} ${id8}.md`;
  }
  function slugifySegment(name) {
    const slug = (name || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
    return slug || "untitled";
  }
  function markdownExportPath(conv, meta = {}) {
    const fname = obsidianFilename(conv);
    const projectName = meta.projectName ?? (typeof conv._projectName === "string" ? conv._projectName : void 0);
    if (projectName) {
      return {
        path: `markdown/projects/${slugifySegment(projectName)}/${fname}`,
        filesRelPath: "../../files",
        projectName,
        archived: meta.archived
      };
    }
    if (meta.archived || conv.is_archived === true) {
      return {
        path: `markdown/archived/${fname}`,
        filesRelPath: "../../files",
        archived: true
      };
    }
    return {
      path: `markdown/${fname}`,
      filesRelPath: "../files",
      archived: false
    };
  }
  function buildExportIndexMarkdown(entries, opts = {}) {
    const sorted = [...entries].sort((a, b) => {
      const at = Number(a.updateTime ?? a.createTime ?? 0);
      const bt = Number(b.updateTime ?? b.createTime ?? 0);
      return bt - at;
    });
    const projects = /* @__PURE__ */ new Map();
    const archived = [];
    const inbox = [];
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
    const lines = [
      "# ChatLiberate Export Index",
      "",
      `Exported: ${opts.exportedAt ?? (/* @__PURE__ */ new Date()).toISOString()}`,
      `Conversations: ${opts.conversationCount ?? entries.length}`,
      `Projects: ${opts.projectCount ?? projects.size}`,
      "",
      "Jump to a chat below. Links open the Markdown file in this ZIP.",
      ""
    ];
    const linkLine = (e) => {
      const date = e.updateTime || e.createTime ? formatDate(e.updateTime ?? e.createTime).slice(0, 10) : "unknown";
      return `- [${e.title || "Untitled"}](${e.path}) \u2014 ${date}`;
    };
    if (projects.size > 0) {
      lines.push("## Projects", "");
      for (const name of [...projects.keys()].sort((a, b) => a.localeCompare(b))) {
        lines.push(`### ${name}`, "");
        for (const e of projects.get(name)) lines.push(linkLine(e));
        lines.push("");
      }
    }
    if (inbox.length > 0) {
      lines.push("## Chats", "");
      for (const e of inbox) lines.push(linkLine(e));
      lines.push("");
    }
    if (archived.length > 0) {
      lines.push("## Archived", "");
      for (const e of archived) lines.push(linkLine(e));
      lines.push("");
    }
    return lines.join("\n");
  }
  var CONVERSATIONS_PER_PAGE = 28;
  async function exportAllConversations(session, options = {}) {
    const {
      includeArchived = true,
      includeProjects = true,
      downloadFiles = true,
      downloadImages = true,
      throttleMs = 1500,
      onProgress,
      signal,
      conversationIds
    } = options;
    const throttle = new Throttle(throttleMs);
    const emit = (event) => onProgress?.(event);
    const index = [];
    const conversations = [];
    const files = /* @__PURE__ */ new Map();
    const fileMeta = /* @__PURE__ */ new Map();
    emit({ phase: "indexing", message: "Indexing conversations\u2026" });
    await indexConversations(session, index, { includeArchived, includeProjects }, throttle, emit, signal);
    let toDownload = index;
    if (conversationIds?.length) {
      const idSet = new Set(conversationIds);
      toDownload = index.filter((c) => idSet.has(c.id));
    }
    emit({
      phase: "downloading",
      message: `Downloading ${toDownload.length} conversations\u2026`,
      total: toDownload.length,
      current: 0
    });
    let branchCount = 0;
    let archivedCount = 0;
    let projectCount = 0;
    for (let i = 0; i < toDownload.length; i++) {
      if (signal?.aborted) throw new Error("Export cancelled");
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
          phase: "downloading",
          message: `Downloaded: ${summary.title ?? summary.id}`,
          current: i + 1,
          total: toDownload.length,
          conversationId: summary.id
        });
        if (downloadFiles) {
          const refs = extractFileReferences(conv).filter((ref) => {
            if (ref.type === "image") return downloadImages;
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
                  fileName: downloaded.fileName
                });
              }
            } catch {
            }
          }
        }
      } catch (error) {
        emit({
          phase: "error",
          message: `Failed: ${summary.title ?? summary.id} \u2014 ${error.message}`,
          conversationId: summary.id
        });
      }
    }
    emit({ phase: "complete", message: "Export complete", current: conversations.length, total: toDownload.length });
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
        projectCount
      }
    };
  }
  async function indexConversations(session, index, opts, throttle, emit, signal) {
    const seen = /* @__PURE__ */ new Set();
    for (const archived of [false, ...opts.includeArchived ? [true] : []]) {
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        if (signal?.aborted) throw new Error("Export cancelled");
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
          phase: "indexing",
          message: `Found ${index.length} conversations\u2026`,
          current: index.length
        });
        offset += items.length;
        hasMore = items.length === CONVERSATIONS_PER_PAGE;
      }
    }
    if (opts.includeProjects) {
      await throttle.wait();
      const projects = await fetchProjects(session);
      for (const project of projects) {
        if (signal?.aborted) throw new Error("Export cancelled");
        let cursor = null;
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
                _projectId: project.id
              });
            }
          }
          cursor = nextCursor;
          hasMore = Boolean(nextCursor && items.length > 0);
        }
      }
    }
  }
  async function fetchConversation(session, conversationId) {
    const url = `${getApiBase()}/conversation/${conversationId}`;
    const response = await fetchWithRetry(url, { headers: createHeaders(session) });
    return response.json();
  }
  async function fetchProjects(session) {
    const url = `${getApiBase()}/gizmos/snorlax/sidebar`;
    const response = await fetchWithRetry(url, { headers: createHeaders(session) });
    const data = await response.json();
    const projects = [];
    for (const item of data.items ?? []) {
      const gizmo = item.gizmo ?? item;
      if (gizmo?.id && gizmo?.display?.name) {
        projects.push({ id: gizmo.id, name: gizmo.display.name });
      }
    }
    return projects;
  }
  async function fetchProjectConversations(session, projectId, cursor) {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const url = `${getApiBase()}/gizmos/${projectId}/conversations?${params}`;
    const response = await fetchWithRetry(url, { headers: createHeaders(session) });
    const data = await response.json();
    return {
      items: (data.items ?? []).map((item) => ({
        id: item.id,
        title: item.title,
        create_time: item.create_time,
        update_time: item.update_time
      })),
      nextCursor: data.cursor ?? null
    };
  }
  async function downloadFile(session, ref) {
    const metaUrl = `${getApiBase()}/files/download/${ref.fileId}?conversation_id=${ref.conversationId}&inline=false`;
    const metaResponse = await fetchWithRetry(metaUrl, { headers: createHeaders(session) });
    const meta = await metaResponse.json();
    if (meta.status !== "success" || !meta.download_url) return null;
    const fileResponse = await fetchWithRetry(meta.download_url, {
      headers: createHeaders(session)
    });
    const buffer = new Uint8Array(await fileResponse.arrayBuffer());
    return {
      data: buffer,
      contentType: fileResponse.headers.get("content-type") || "application/octet-stream",
      fileName: meta.file_name
    };
  }
  async function fetchMemories(session) {
    const url = `${getApiBase()}/memories`;
    const response = await fetchWithRetry(url, { headers: createHeaders(session) });
    const data = await response.json();
    return data.memories ?? data ?? [];
  }
  async function fetchCustomInstructions(session) {
    const url = `${getApiBase()}/user_system_messages`;
    const response = await fetchWithRetry(url, { headers: createHeaders(session) });
    return response.json();
  }
  function memoriesToMarkdown(memories) {
    if (!memories.length) return "# ChatGPT Memories\n\n_No memories found._\n";
    const lines = memories.filter((m) => m.content).map((m) => {
      const status = m.enabled === false ? " _(disabled)_" : "";
      return `- ${m.content}${status}`;
    });
    return `# ChatGPT Memories

${lines.join("\n")}
`;
  }
  function customInstructionsToMarkdown(ci) {
    const sections = ["# Custom Instructions\n"];
    if (ci.about_user) sections.push(`## About You

${ci.about_user}
`);
    if (ci.about_model) sections.push(`## How You Want ChatGPT to Respond

${ci.about_model}
`);
    if (!ci.about_user && !ci.about_model) sections.push("_No custom instructions set._\n");
    return sections.join("\n");
  }
  function toOpenAIExportFormat(conversations) {
    return conversations.map((conv) => ({
      ...conv,
      conversation_id: conv.conversation_id ?? conv.id
    }));
  }
  function toMarkdownExportLayout(conversations, opts = {}) {
    const { fileMeta, index = [], exportedAt } = opts;
    const fileExtMap = /* @__PURE__ */ new Map();
    if (fileMeta) {
      for (const [fileId, meta] of fileMeta) {
        let ext = "";
        if (meta.fileName) {
          const dot = meta.fileName.lastIndexOf(".");
          if (dot !== -1) ext = meta.fileName.slice(dot);
        } else if (meta.contentType) {
          const mime = {
            "image/jpeg": ".jpeg",
            "image/jpg": ".jpeg",
            "image/png": ".png",
            "image/gif": ".gif",
            "image/webp": ".webp"
          };
          ext = mime[meta.contentType.split(";")[0].trim()] ?? "";
        }
        if (ext) fileExtMap.set(fileId, ext);
      }
    }
    const summaryById = new Map(index.map((s) => [s.id, s]));
    const files = /* @__PURE__ */ new Map();
    const entries = [];
    const projectNames = /* @__PURE__ */ new Set();
    for (const conv of conversations) {
      const id = conv.conversation_id ?? conv.id ?? "unknown";
      const summary = summaryById.get(id);
      const projectName = (typeof conv._projectName === "string" ? conv._projectName : void 0) ?? summary?._projectName;
      const archived = Boolean(conv.is_archived ?? summary?._archived);
      const pathInfo = markdownExportPath(conv, { projectName, archived });
      const md = conversationToMarkdown(conv, {
        includeAllBranches: true,
        fileExtMap,
        filesRelPath: pathInfo.filesRelPath,
        projectName: pathInfo.projectName
      });
      files.set(pathInfo.path, md);
      if (pathInfo.projectName) projectNames.add(pathInfo.projectName);
      entries.push({
        title: conv.title ?? "Untitled",
        id,
        path: pathInfo.path,
        createTime: conv.create_time,
        updateTime: conv.update_time,
        projectName: pathInfo.projectName,
        archived: pathInfo.archived
      });
    }
    const indexMarkdown = buildExportIndexMarkdown(entries, {
      exportedAt: exportedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
      conversationCount: entries.length,
      projectCount: projectNames.size
    });
    return { files, indexMarkdown, entries };
  }
  async function exportSingleConversation(session, conversationId, options = {}) {
    const { downloadFiles = true, downloadImages = true, onProgress } = options;
    const emit = (event) => onProgress?.(event);
    emit({ phase: "downloading", message: "Downloading conversation\u2026", total: 1, current: 0 });
    const conv = await fetchConversation(session, conversationId);
    const files = /* @__PURE__ */ new Map();
    const fileMeta = /* @__PURE__ */ new Map();
    if (downloadFiles) {
      const throttle = new Throttle(800);
      const refs = extractFileReferences(conv).filter(
        (ref) => ref.type === "image" ? downloadImages : true
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
              fileName: downloaded.fileName
            });
          }
        } catch {
        }
      }
    }
    emit({ phase: "complete", message: "Export complete", current: 1, total: 1, conversationId });
    const id = conv.conversation_id ?? conv.id ?? conversationId;
    const index = [
      {
        id,
        title: conv.title,
        create_time: conv.create_time,
        update_time: conv.update_time,
        gizmo_id: conv.gizmo_id,
        _archived: conv.is_archived === true ? true : void 0
      }
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
        projectCount: conv.gizmo_id ? 1 : 0
      }
    };
  }

  // node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
      b[i] = start += 1 << eb[i - 1];
    }
    var r = new i32(b[30]);
    for (var i = 1; i < 30; ++i) {
      for (var j = b[i]; j < b[i + 1]; ++j) {
        r[j] = j - b[i] << 5 | i;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = (function(cd, mb, r) {
    var s = cd.length;
    var i = 0;
    var l = new u16(mb);
    for (; i < s; ++i) {
      if (cd[i])
        ++l[cd[i] - 1];
    }
    var le = new u16(mb);
    for (i = 1; i < mb; ++i) {
      le[i] = le[i - 1] + l[i - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          var sv = i << 4 | cd[i];
          var r_1 = mb - cd[i];
          var v = le[cd[i] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
        }
      }
    }
    return co;
  });
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flm = /* @__PURE__ */ hMap(flt, 9, 0);
  var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    // determined by compression function
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var wbits = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };
  var wbits16 = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };
  var hTree = function(d, mb) {
    var t = [];
    for (var i = 0; i < d.length; ++i) {
      if (d[i])
        t.push({ s: i, f: d[i] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
      return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function(a, b) {
      return a.f - b.f;
    });
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    while (i1 != s - 1) {
      l = t[t[i0].f < t[i2].f ? i0++ : i2++];
      r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
      t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }
    var maxSym = t2[0].s;
    for (var i = 1; i < s; ++i) {
      if (t2[i].s > maxSym)
        maxSym = t2[i].s;
    }
    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
      var i = 0, dt = 0;
      var lft = mbt - mb, cst = 1 << lft;
      t2.sort(function(a, b) {
        return tr[b.s] - tr[a.s] || a.f - b.f;
      });
      for (; i < s; ++i) {
        var i2_1 = t2[i].s;
        if (tr[i2_1] > mb) {
          dt += cst - (1 << mbt - tr[i2_1]);
          tr[i2_1] = mb;
        } else
          break;
      }
      dt >>= lft;
      while (dt > 0) {
        var i2_2 = t2[i].s;
        if (tr[i2_2] < mb)
          dt -= 1 << mb - tr[i2_2]++ - 1;
        else
          ++i;
      }
      for (; i >= 0 && dt; --i) {
        var i2_3 = t2[i].s;
        if (tr[i2_3] == mb) {
          --tr[i2_3];
          ++dt;
        }
      }
      mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
  };
  var ln = function(n, l, d) {
    return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
  };
  var lc = function(c) {
    var s = c.length;
    while (s && !c[--s])
      ;
    var cl = new u16(++s);
    var cli = 0, cln = c[0], cls = 1;
    var w = function(v) {
      cl[cli++] = v;
    };
    for (var i = 1; i <= s; ++i) {
      if (c[i] == cln && i != s)
        ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138)
            w(32754);
          if (cls > 2) {
            w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln), --cls;
          for (; cls > 6; cls -= 6)
            w(8304);
          if (cls > 2)
            w(cls - 3 << 5 | 8208), cls = 0;
        }
        while (cls--)
          w(cln);
        cls = 1;
        cln = c[i];
      }
    }
    return { c: cl.subarray(0, cli), n: s };
  };
  var clen = function(cf, cl) {
    var l = 0;
    for (var i = 0; i < cl.length; ++i)
      l += cf[i] * cl[i];
    return l;
  };
  var wfblk = function(out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i = 0; i < s; ++i)
      out[o + i + 4] = dat[i];
    return (o + 4 + s) * 8;
  };
  var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
    var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i = 0; i < lclt.length; ++i)
      ++lcfreq[lclt[i] & 31];
    for (var i = 0; i < lcdt.length; ++i)
      ++lcfreq[lcdt[i] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
      ;
    var flen = bl + 5 << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var i = 0; i < nlcc; ++i)
        wbits(out, p + 3 * i, lct[clim[i]]);
      p += 3 * nlcc;
      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var i = 0; i < clct.length; ++i) {
          var len = clct[i] & 31;
          wbits(out, p, llm[len]), p += lct[len];
          if (len > 15)
            wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
        }
      }
    } else {
      lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i = 0; i < li; ++i) {
      var sym = syms[i];
      if (sym > 255) {
        var len = sym >> 18 & 31;
        wbits16(out, p, lm[len + 257]), p += ll[len + 257];
        if (len > 7)
          wbits(out, p, sym >> 23 & 31), p += fleb[len];
        var dst = sym & 31;
        wbits16(out, p, dm[dst]), p += dl[dst];
        if (dst > 3)
          wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
      } else {
        wbits16(out, p, lm[sym]), p += ll[sym];
      }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
  };
  var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
  var et = /* @__PURE__ */ new u8(0);
  var dflt = function(dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
      if (pos)
        w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13, c = opt & 8191;
      var msk_1 = (1 << plvl) - 1;
      var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
      var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
      var hsh = function(i2) {
        return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
      };
      var syms = new i32(25e3);
      var lf = new u16(288), df = new u16(32);
      var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
      for (; i + 2 < s; ++i) {
        var hv = hsh(i);
        var imod = i & 32767, pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i) {
          var rem = s - i;
          if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
            li = lc_1 = eb = 0, bs = i;
            for (var j = 0; j < 286; ++j)
              lf[j] = 0;
            for (var j = 0; j < 30; ++j)
              df[j] = 0;
          }
          var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
          if (rem > 2 && hv == hsh(i - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch_1 && imod != pimod) {
              if (dat[i + l] == dat[i + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                  ;
                if (nl > l) {
                  l = nl, d = dif;
                  if (nl > maxn)
                    break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var j = 0; j < mmd; ++j) {
                    var ti = i - dif + j & 32767;
                    var pti = prev[ti];
                    var cd = ti - pti & 32767;
                    if (cd > md)
                      md = cd, pimod = ti;
                  }
                }
              }
              imod = pimod, pimod = prev[imod];
              dif += imod - pimod & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
            var lin = revfl[l] & 31, din = revfd[d] & 31;
            eb += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i + l;
            ++lc_1;
          } else {
            syms[li++] = dat[i];
            ++lf[dat[i]];
          }
        }
      }
      for (i = Math.max(i, wi); i < s; ++i) {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
      if (!lst) {
        st.r = pos & 7 | w[pos / 8 | 0] << 3;
        pos -= 7;
        st.h = head, st.p = prev, st.i = i, st.w = wi;
      }
    } else {
      for (var i = st.w || 0; i < s + lst; i += 65535) {
        var e = i + 65535;
        if (e >= s) {
          w[pos / 8 | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(i, e));
      }
      st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
  };
  var crct = /* @__PURE__ */ (function() {
    var t = new Int32Array(256);
    for (var i = 0; i < 256; ++i) {
      var c = i, k = 9;
      while (--k)
        c = (c & 1 && -306674912) ^ c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  var crc = function() {
    var c = -1;
    return {
      p: function(d) {
        var cr = c;
        for (var i = 0; i < d.length; ++i)
          cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
        c = cr;
      },
      d: function() {
        return ~c;
      }
    };
  };
  var dopt = function(dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
  };
  var mrg = function(a, b) {
    var o = {};
    for (var k in a)
      o[k] = a[k];
    for (var k in b)
      o[k] = b[k];
    return o;
  };
  var wbytes = function(d, b, v) {
    for (; v; ++b)
      d[b] = v, v >>>= 8;
  };
  function deflateSync(data, opts) {
    return dopt(data, opts || {}, 0, 0);
  }
  var fltn = function(d, p, t, o) {
    for (var k in d) {
      var val = d[k], n = p + k, op = o;
      if (Array.isArray(val))
        op = mrg(o, val[1]), val = val[0];
      if (ArrayBuffer.isView(val))
        t[n] = [val, op];
      else {
        t[n += "/"] = [new u8(0), op];
        fltn(val, n, t, o);
      }
    }
  };
  var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }
  function strToU8(str, latin1) {
    if (latin1) {
      var ar_1 = new u8(str.length);
      for (var i = 0; i < str.length; ++i)
        ar_1[i] = str.charCodeAt(i);
      return ar_1;
    }
    if (te)
      return te.encode(str);
    var l = str.length;
    var ar = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w = function(v) {
      ar[ai++] = v;
    };
    for (var i = 0; i < l; ++i) {
      if (ai + 5 > ar.length) {
        var n = new u8(ai + 8 + (l - i << 1));
        n.set(ar);
        ar = n;
      }
      var c = str.charCodeAt(i);
      if (c < 128 || latin1)
        w(c);
      else if (c < 2048)
        w(192 | c >> 6), w(128 | c & 63);
      else if (c > 55295 && c < 57344)
        c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
      else
        w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
    }
    return slc(ar, 0, ai);
  }
  var exfl = function(ex) {
    var le = 0;
    if (ex) {
      for (var k in ex) {
        var l = ex[k].length;
        if (l > 65535)
          err(9);
        le += l + 4;
      }
    }
    return le;
  };
  var wzh = function(d, b, f, fn, u, c, ce, co) {
    var fl2 = fn.length, ex = f.extra, col = co && co.length;
    var exl = exfl(ex);
    wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
    if (ce != null)
      d[b++] = 20, d[b++] = f.os;
    d[b] = 20, b += 2;
    d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
    d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
    var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
    if (y < 0 || y > 119)
      err(10);
    wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
    if (c != -1) {
      wbytes(d, b, f.crc);
      wbytes(d, b + 4, c < 0 ? -c - 2 : c);
      wbytes(d, b + 8, f.size);
    }
    wbytes(d, b + 12, fl2);
    wbytes(d, b + 14, exl), b += 16;
    if (ce != null) {
      wbytes(d, b, col);
      wbytes(d, b + 6, f.attrs);
      wbytes(d, b + 10, ce), b += 14;
    }
    d.set(fn, b);
    b += fl2;
    if (exl) {
      for (var k in ex) {
        var exf = ex[k], l = exf.length;
        wbytes(d, b, +k);
        wbytes(d, b + 2, l);
        d.set(exf, b + 4), b += 4 + l;
      }
    }
    if (col)
      d.set(co, b), b += col;
    return b;
  };
  var wzf = function(o, b, c, d, e) {
    wbytes(o, b, 101010256);
    wbytes(o, b + 8, c);
    wbytes(o, b + 10, c);
    wbytes(o, b + 12, d);
    wbytes(o, b + 16, e);
  };
  function zipSync(data, opts) {
    if (!opts)
      opts = {};
    var r = {};
    var files = [];
    fltn(data, "", r, opts);
    var o = 0;
    var tot = 0;
    for (var fn in r) {
      var _a2 = r[fn], file = _a2[0], p = _a2[1];
      var compression = p.level == 0 ? 0 : 8;
      var f = strToU8(fn), s = f.length;
      var com = p.comment, m = com && strToU8(com), ms = m && m.length;
      var exl = exfl(p.extra);
      if (s > 65535)
        err(11);
      var d = compression ? deflateSync(file, p) : file, l = d.length;
      var c = crc();
      c.p(file);
      files.push(mrg(p, {
        size: file.length,
        crc: c.d(),
        c: d,
        f,
        m,
        u: s != fn.length || m && com.length != ms,
        o,
        compression
      }));
      o += 30 + s + exl + l;
      tot += 76 + 2 * (s + exl) + (ms || 0) + l;
    }
    var out = new u8(tot + 22), oe = o, cdl = tot - o;
    for (var i = 0; i < files.length; ++i) {
      var f = files[i];
      wzh(out, f.o, f, f.f, f.u, f.c.length);
      var badd = 30 + f.f.length + exfl(f.extra);
      out.set(f.c, f.o + badd);
      wzh(out, o, f, f.f, f.u, f.c.length, f.o, f.m), o += 16 + badd + (f.m ? f.m.length : 0);
    }
    wzf(out, o, files.length, cdl, oe);
    return out;
  }

  // apps/extension/src/content.js
  function getCurrentConversationId() {
    const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return match?.[1];
  }
  function detectChatBranchFromDom() {
    const candidates = Array.from(document.querySelectorAll("a, button, span, div"));
    const divider = candidates.find((el) => {
      const text = (el.textContent || "").replace(/\s+/g, " ").trim();
      return /^Branched from\b/i.test(text) && text.length < 160;
    });
    if (!divider) return null;
    const label = (divider.textContent || "").replace(/\s+/g, " ").trim();
    const all = Array.from(document.querySelectorAll("div[data-message-author-role], [data-message-author-role]"));
    let passedDivider = false;
    let firstUserText = "";
    for (const el of all) {
      if (divider === el || divider.contains(el) || el.contains(divider)) {
        passedDivider = true;
        continue;
      }
      const pos = divider.compareDocumentPosition(el);
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
        passedDivider = true;
      }
      if (!passedDivider && !(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const role = el.getAttribute("data-message-author-role");
      if (role === "user") {
        firstUserText = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (firstUserText) break;
      }
    }
    if (!firstUserText) {
      let node = divider.parentElement;
      for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
        let sib = node.nextElementSibling;
        while (sib) {
          const user = sib.querySelector?.('[data-message-author-role="user"]') || (sib.getAttribute?.("data-message-author-role") === "user" ? sib : null);
          if (user) {
            firstUserText = (user.innerText || user.textContent || "").replace(/\s+/g, " ").trim();
            if (firstUserText) break;
          }
          sib = sib.nextElementSibling;
        }
        if (firstUserText) break;
      }
    }
    return { label, firstUserText: firstUserText || void 0 };
  }
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function buildZip(result, extras = {}) {
    const files = {};
    const oai = toOpenAIExportFormat(result.conversations);
    files["conversations.json"] = JSON.stringify(oai, null, 2);
    const layout = toMarkdownExportLayout(result.conversations, {
      fileMeta: result.fileMeta,
      index: result.index
    });
    files["INDEX.md"] = layout.indexMarkdown;
    for (const [path, md] of layout.files) {
      files[path] = md;
      const chunks = chunkMarkdown(md, 32e4);
      if (chunks.length > 1) {
        chunks.forEach((chunk, i) => {
          files[path.replace(/\.md$/, `-part${i + 1}.md`)] = chunk;
        });
      }
    }
    for (const [fileId, data] of result.files) {
      const meta = result.fileMeta.get(fileId);
      const ext = meta?.fileName ? meta.fileName.split(".").pop() : "bin";
      files[`files/${fileId}.${ext}`] = data;
    }
    if (extras.memories?.length) {
      files["memory.json"] = JSON.stringify(extras.memories, null, 2);
      files["memory.md"] = memoriesToMarkdown(extras.memories);
    }
    if (extras.customInstructions) {
      files["custom-instructions.json"] = JSON.stringify(extras.customInstructions, null, 2);
      files["custom-instructions.md"] = customInstructionsToMarkdown(extras.customInstructions);
    }
    const fileExtMap = /* @__PURE__ */ new Map();
    for (const [fileId, meta] of result.fileMeta) {
      let ext = "";
      if (meta.fileName) {
        const dot = meta.fileName.lastIndexOf(".");
        if (dot !== -1) ext = meta.fileName.slice(dot);
      } else if (meta.contentType) {
        const mime = { "image/jpeg": ".jpeg", "image/jpg": ".jpeg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
        ext = mime[meta.contentType.split(";")[0].trim()] ?? "";
      }
      if (ext) fileExtMap.set(fileId, ext);
    }
    const contextBlock = toContextBlock(result.conversations, {
      maxChars: 6e4,
      fileExtMap,
      includeAllBranches: Boolean(extras.includeBranches)
    });
    files["import-context-for-claude-gemini.md"] = contextBlock;
    const projectNames = new Set(
      layout.entries.filter((e) => e.projectName).map((e) => e.projectName)
    );
    files["export-stats.json"] = JSON.stringify(
      {
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        ...result.stats,
        tool: "chatliberate",
        version: "0.1.2",
        accountType: document.cookie.includes("_account=") ? "teams/business" : "personal",
        memoriesCount: extras.memories?.length ?? 0,
        hasCustomInstructions: Boolean(extras.customInstructions?.about_user || extras.customInstructions?.about_model),
        projectNames: [...projectNames],
        indexEntries: layout.entries.length
      },
      null,
      2
    );
    const zipInput = {};
    for (const [name, content] of Object.entries(files)) {
      zipInput[name] = typeof content === "string" ? strToU8(content) : content;
    }
    const zipped = zipSync(zipInput, { level: 0 });
    return new Blob([zipped], { type: "application/zip" });
  }
  function sendProgress(event) {
    chrome.runtime.sendMessage({
      type: "CHATLIBERATE_PROGRESS",
      message: event.message,
      current: event.current,
      total: event.total
    });
  }
  async function runExport(mode, options) {
    const session = await fetchSessionFromPage();
    const [memories, customInstructions] = await Promise.all([
      fetchMemories(session).catch(() => []),
      fetchCustomInstructions(session).catch(() => null)
    ]);
    let result;
    if (mode === "current") {
      const id = getCurrentConversationId();
      if (!id) throw new Error("Open a conversation first (URL should contain /c/)");
      result = await exportSingleConversation(session, id, {
        downloadFiles: options.downloadImages,
        downloadImages: options.downloadImages,
        onProgress: sendProgress
      });
    } else {
      const stored = await chrome.storage.local.get("exportProgress");
      const prevProgress = stored.exportProgress ?? {};
      const skipIds = new Set(prevProgress.downloadedIds ?? []);
      const abortController = new AbortController();
      result = await exportAllConversations(session, {
        includeArchived: options.includeArchived,
        includeProjects: options.includeProjects,
        downloadFiles: options.downloadImages,
        downloadImages: options.downloadImages,
        throttleMs: 1200,
        signal: abortController.signal,
        onProgress: (event) => {
          sendProgress(event);
          if (event.phase === "downloading" && event.conversationId) {
            const ids = [...prevProgress.downloadedIds ?? [], event.conversationId];
            chrome.storage.local.set({ exportProgress: { downloadedIds: ids, lastExport: Date.now() } });
          }
          if (event.phase === "complete") {
            chrome.storage.local.remove("exportProgress");
          }
        }
      });
    }
    const zip = await buildZip(result, {
      memories,
      customInstructions,
      includeBranches: options.includeBranches
    });
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    downloadBlob(`chatliberate-export-${date}.zip`, zip);
    return { ok: true, stats: { ...result.stats, memoriesCount: memories.length } };
  }
  async function copyContextForCurrent(options) {
    const id = getCurrentConversationId();
    if (!id) throw new Error("Open a conversation first");
    const session = await fetchSessionFromPage();
    const result = await exportSingleConversation(session, id, {
      downloadFiles: false,
      downloadImages: false
    });
    const fileExtMap = /* @__PURE__ */ new Map();
    for (const [fileId, meta] of result.fileMeta) {
      const mime = { "image/jpeg": ".jpeg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp" };
      const ext = (meta.fileName ? meta.fileName.slice(meta.fileName.lastIndexOf(".")) : mime[meta.contentType?.split(";")[0].trim()]) ?? "";
      if (ext) fileExtMap.set(fileId, ext);
    }
    const chatBranch = detectChatBranchFromDom();
    const context = toContextBlock(result.conversations, {
      maxChars: 12e4,
      fileExtMap,
      includeAllBranches: Boolean(options?.includeBranches),
      chatBranch: chatBranch || void 0
    });
    const imgPattern = /\[image attached separately\]/g;
    const imageCount = (context.match(imgPattern) || []).length;
    const branchCount = result.conversations.reduce(
      (n, c) => n + (options?.includeBranches ? countBranches(c) : 1),
      0
    );
    const dagBranches = options?.includeBranches && context.includes("regenerated branches preserved");
    const chatFork = Boolean(chatBranch) && context.includes("Shared history (before branch)");
    return {
      ok: true,
      context,
      imageCount,
      includeAllBranches: Boolean(options?.includeBranches),
      branchNote: dagBranches || chatFork,
      branchCount: dagBranches ? branchCount : chatFork ? 2 : branchCount,
      chatFork,
      chatBranchLabel: chatBranch?.label
    };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "CHATLIBERATE_EXPORT") {
      runExport(msg.mode, msg.options).then((result) => sendResponse(result)).catch((err2) => sendResponse({ ok: false, error: err2.message }));
      return true;
    }
    if (msg.type === "CHATLIBERATE_COPY_CONTEXT") {
      copyContextForCurrent(msg.options).then((result) => sendResponse(result)).catch((err2) => {
        console.error("[ChatLiberate] copyContext error:", err2);
        sendResponse({ ok: false, error: err2?.message ?? String(err2) });
      });
      return true;
    }
    if (msg.type === "CHATLIBERATE_PRINT") {
      const id = getCurrentConversationId();
      if (id) {
        const expandSelectors = [
          'button[data-testid="show-more-button"]',
          "button.show-more",
          'button[aria-label="Show more"]'
          // ChatGPT renders truncated messages inside a max-h container with a gradient overlay;
          // the expand button sits right after the truncated content div
        ];
        for (const sel of expandSelectors) {
          document.querySelectorAll(sel).forEach((btn) => btn.click());
        }
        document.querySelectorAll("button").forEach((btn) => {
          if (btn.textContent.trim().toLowerCase() === "show more") btn.click();
        });
        document.querySelectorAll('[class*="max-h-"]').forEach((el) => {
          if (el.scrollHeight > el.clientHeight + 4) {
            el.style.setProperty("max-height", "none", "important");
            el.style.setProperty("overflow", "visible", "important");
          }
        });
        const style = document.createElement("style");
        style.id = "chatliberate-print-style";
        style.textContent = `
        @media print {
          nav, aside, header,
          [data-testid="conversation-header"],
          [data-testid="composer"],
          /* hide all buttons except inside message content */
          body > * button,
          .group\\/conversation-turn > div:last-child { display: none !important; }
          body { background: white !important; color: black !important; }
          main { max-width: 100% !important; padding: 0 !important; }
          /* ensure nothing is clipped in print */
          * { max-height: none !important; overflow: visible !important; }
        }
      `;
        document.head.appendChild(style);
        setTimeout(() => {
          window.print();
          setTimeout(() => {
            style.remove();
            document.querySelectorAll("[data-cl-expanded]").forEach((el) => {
              el.style.removeProperty("max-height");
              el.style.removeProperty("overflow");
              el.removeAttribute("data-cl-expanded");
            });
          }, 3e3);
        }, 300);
      }
      sendResponse({ ok: true });
      return true;
    }
  });
})();
