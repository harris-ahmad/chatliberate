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
  function getLeafNodeIds(mapping) {
    return Object.entries(mapping).filter(([, node]) => !node.children || node.children.length === 0).map(([id]) => id);
  }
  function pathToRoot(mapping, leafId) {
    const path = [];
    let current = leafId;
    while (current) {
      path.push(current);
      const node = mapping[current];
      if (!node?.parent) break;
      current = node.parent;
    }
    return path.reverse();
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
      const key = nodeIds.join(">");
      if (seen.has(key)) continue;
      seen.add(key);
      branches.push({
        nodeIds,
        messages: nodeIds.map((id) => mapping[id]?.message).filter((m) => Boolean(m?.content))
      });
    }
    return branches;
  }
  function countBranches(conversation) {
    return getAllBranches(conversation).length;
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
  function extractMessageText(message) {
    const content = message.content;
    if (!content) return "";
    if (content.content_type === "text" && Array.isArray(content.parts)) {
      return content.parts.filter((p) => typeof p === "string").join("\n");
    }
    if (content.content_type === "code" && typeof content.text === "string") {
      const lang = content.metadata?.language ?? "";
      return `\`\`\`${lang}
${content.text}
\`\`\``;
    }
    if (content.content_type === "multimodal_text" && Array.isArray(content.parts)) {
      return content.parts.map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part;
          if (p.content_type === "image_asset_pointer" && p.asset_pointer) {
            const id = String(p.asset_pointer).replace(/^(sediment|file-service):\/\//, "");
            return `![image](files/${id})`;
          }
        }
        return "";
      }).filter(Boolean).join("\n");
    }
    if (content.content_type === "thoughts" && Array.isArray(content.parts)) {
      const thoughts = content.parts.map((p) => typeof p === "object" && p && "summary" in p ? String(p.summary) : "").filter(Boolean).join("\n");
      return thoughts ? `<details><summary>Thinking</summary>

${thoughts}

</details>` : "";
    }
    return "";
  }
  function messageToMarkdown(message) {
    const role = message.author?.role ?? "unknown";
    if (role === "system") return "";
    const text = extractMessageText(message);
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
    const frontmatter = [
      "---",
      `title: "${escapeYaml(title)}"`,
      `id: ${id}`,
      `create_time: ${formatDate(conversation.create_time)}`,
      `update_time: ${formatDate(conversation.update_time)}`,
      `model: ${model}`,
      conversation.gizmo_id ? `project_id: ${conversation.gizmo_id}` : null,
      "---",
      ""
    ].filter(Boolean).join("\n");
    if (options.includeAllBranches) {
      const branches = getAllBranches(conversation);
      if (branches.length <= 1) {
        const path2 = getActivePath(conversation);
        const body2 = path2.messages.map(messageToMarkdown).filter(Boolean).join("\n");
        return frontmatter + `# ${title}

${body2}`;
      }
      const sections = branches.map((branch, i) => {
        const body2 = branch.messages.map(messageToMarkdown).filter(Boolean).join("\n");
        return `## Branch ${i + 1}

${body2}`;
      });
      return frontmatter + `# ${title}

_${branches.length} branches preserved_

${sections.join("\n\n---\n\n")}`;
    }
    const path = getActivePath(conversation);
    const body = path.messages.map(messageToMarkdown).filter(Boolean).join("\n");
    return frontmatter + `# ${title}

${body}`;
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
  function toOpenAIExportFormat(conversations) {
    return conversations.map((conv) => ({
      ...conv,
      conversation_id: conv.conversation_id ?? conv.id
    }));
  }
  function toMarkdownBundle(conversations) {
    const bundle = /* @__PURE__ */ new Map();
    for (const conv of conversations) {
      const id = conv.conversation_id ?? conv.id ?? "unknown";
      bundle.set(id, conversationToMarkdown(conv, { includeAllBranches: true }));
    }
    return bundle;
  }
  async function exportSingleConversation(session, conversationId, options = {}) {
    return exportAllConversations(session, {
      ...options,
      conversationIds: [conversationId],
      includeArchived: false,
      includeProjects: false
    });
  }

  // apps/extension/src/content.js
  function getCurrentConversationId() {
    const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return match?.[1];
  }
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
  async function buildZip(result, options) {
    const files = {};
    const oai = toOpenAIExportFormat(result.conversations);
    files["conversations.json"] = JSON.stringify(oai, null, 2);
    const mdBundle = toMarkdownBundle(result.conversations);
    for (const [id, md] of mdBundle) {
      const conv = result.conversations.find((c) => (c.conversation_id ?? c.id) === id);
      const name = (conv?.title ?? id).replace(/[<>:"/\\|?*]/g, "_").slice(0, 60);
      files[`markdown/${name}_${id.slice(0, 8)}.md`] = md;
    }
    for (const [fileId, data] of result.files) {
      const meta = result.fileMeta.get(fileId);
      const ext = meta?.fileName ? meta.fileName.split(".").pop() : "bin";
      files[`files/${fileId}.${ext}`] = data;
    }
    files["export-stats.json"] = JSON.stringify(
      {
        exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
        ...result.stats,
        tool: "chatliberate",
        version: "0.1.0",
        accountType: document.cookie.includes("_account=") ? "teams/business" : "personal"
      },
      null,
      2
    );
    return createZip(files);
  }
  function createZip(fileMap) {
    const encoder = new TextEncoder();
    const entries = [];
    let offset = 0;
    const chunks = [];
    function crc32(data) {
      let crc = 4294967295;
      for (let i = 0; i < data.length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
          crc = crc >>> 1 ^ (crc & 1 ? 3988292384 : 0);
        }
      }
      return (crc ^ 4294967295) >>> 0;
    }
    for (const [name, content] of Object.entries(fileMap)) {
      const nameBytes = encoder.encode(name);
      const data = typeof content === "string" ? encoder.encode(content) : content;
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBytes.length);
      const view = new DataView(local.buffer);
      view.setUint32(0, 67324752, true);
      view.setUint16(4, 20, true);
      view.setUint16(26, nameBytes.length, true);
      view.setUint32(18, crc, true);
      view.setUint32(22, data.length, true);
      view.setUint32(26, data.length, true);
      local.set(nameBytes, 30);
      const localOffset = offset;
      chunks.push(local, data);
      offset += local.length + data.length;
      entries.push({ name, nameBytes, crc, size: data.length, offset: localOffset });
    }
    const centralStart = offset;
    for (const entry of entries) {
      const central = new Uint8Array(46 + entry.nameBytes.length);
      const view = new DataView(central.buffer);
      view.setUint32(0, 33639248, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(28, entry.nameBytes.length, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.size, true);
      view.setUint32(24, entry.size, true);
      view.setUint32(42, entry.offset, true);
      central.set(entry.nameBytes, 46);
      chunks.push(central);
      offset += central.length;
    }
    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 101010256, true);
    endView.setUint16(8, entries.length, true);
    endView.setUint16(10, entries.length, true);
    endView.setUint32(12, offset - centralStart, true);
    endView.setUint32(16, centralStart, true);
    chunks.push(end);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const chunk of chunks) {
      out.set(chunk, pos);
      pos += chunk.length;
    }
    return new Blob([out], { type: "application/zip" });
  }
  async function runExport(mode, options) {
    const session = await fetchSessionFromPage();
    const progress = (event) => {
      chrome.runtime.sendMessage({
        type: "CHATLIBERATE_PROGRESS",
        message: event.message,
        current: event.current,
        total: event.total
      });
    };
    let result;
    if (mode === "current") {
      const id = getCurrentConversationId();
      if (!id) throw new Error("Open a conversation first (URL should contain /c/)");
      result = await exportSingleConversation(session, id, {
        downloadFiles: options.downloadImages,
        downloadImages: options.downloadImages,
        onProgress: progress
      });
    } else {
      result = await exportAllConversations(session, {
        includeArchived: options.includeArchived,
        includeProjects: options.includeProjects,
        downloadFiles: options.downloadImages,
        downloadImages: options.downloadImages,
        throttleMs: 1200,
        onProgress: progress
      });
    }
    const zip = await buildZip(result, options);
    const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    downloadBlob(`chatliberate-export-${date}.zip`, zip);
    return { ok: true, stats: result.stats };
  }
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== "CHATLIBERATE_EXPORT") return;
    runExport(msg.mode, msg.options).then((result) => sendResponse(result)).catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  });
})();
