import type {
  BranchPath,
  ChatGPTMessage,
  Conversation,
  MessageNode,
} from './types.js';

/**
 * ChatGPT stores the DAG inconsistently:
 * - Live API usually fills `children` arrays
 * - Some forks only appear as multiple nodes sharing the same `parent`
 * - Official exports often leave `children` null and rely on `parent` only
 * Effective children = declared children ∪ nodes that point at this parent.
 */
function buildEffectiveChildren(
  mapping: Record<string, MessageNode>,
): Map<string, string[]> {
  const children = new Map<string, Set<string>>();

  const add = (parentId: string, childId: string) => {
    if (!mapping[parentId] || !mapping[childId]) return;
    let set = children.get(parentId);
    if (!set) {
      set = new Set();
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
    [...children.entries()].map(([id, set]) => [id, [...set]]),
  );
}

function effectiveChildren(
  tree: Map<string, string[]>,
  nodeId: string,
): string[] {
  return tree.get(nodeId) ?? [];
}

/** All leaf nodes in the conversation DAG (regenerated branches). */
export function getLeafNodeIds(mapping: Record<string, MessageNode>): string[] {
  const tree = buildEffectiveChildren(mapping);
  return Object.keys(mapping).filter(
    (id) => effectiveChildren(tree, id).length === 0,
  );
}

/** Walk from node to root, collecting node ids. */
export function pathToRoot(
  mapping: Record<string, MessageNode>,
  leafId: string,
): string[] {
  const path: string[] = [];
  let current: string | null | undefined = leafId;
  const guard = new Set<string>();

  while (current) {
    if (guard.has(current)) break;
    guard.add(current);
    path.push(current);
    const node: MessageNode | undefined = mapping[current];
    if (!node?.parent) break;
    current = node.parent;
  }

  return path.reverse();
}

function pathHasVisibleMessages(
  mapping: Record<string, MessageNode>,
  nodeIds: string[],
): boolean {
  return nodeIds.some((id) => {
    const role = mapping[id]?.message?.author?.role;
    return role === 'user' || role === 'assistant';
  });
}

/** Drop paths that are strict prefixes of a longer path */
function keepMaximalPaths(branches: BranchPath[]): BranchPath[] {
  return branches.filter((branch) => {
    const key = branch.nodeIds.join('>');
    return !branches.some(
      (other) =>
        other !== branch &&
        other.nodeIds.length > branch.nodeIds.length &&
        other.nodeIds.join('>').startsWith(`${key}>`),
    );
  });
}

/** Current visible thread (follows current_node). */
export function getActivePath(conversation: Conversation): BranchPath {
  const mapping = conversation.mapping ?? {};
  const leafId = conversation.current_node ?? findDefaultLeaf(mapping);
  const nodeIds = pathToRoot(mapping, leafId);
  return {
    nodeIds,
    messages: nodeIds
      .map((id) => mapping[id]?.message)
      .filter((m): m is ChatGPTMessage => Boolean(m?.content)),
  };
}

/**
 * Every distinct branch path through the conversation tree.
 * Active path (current_node leaf) is sorted first when present.
 */
export function getAllBranches(conversation: Conversation): BranchPath[] {
  const mapping = conversation.mapping ?? {};
  const leaves = getLeafNodeIds(mapping);
  const seen = new Set<string>();
  const branches: BranchPath[] = [];

  for (const leafId of leaves) {
    const nodeIds = pathToRoot(mapping, leafId);
    if (!pathHasVisibleMessages(mapping, nodeIds)) continue;

    const key = nodeIds.join('>');
    if (seen.has(key)) continue;
    seen.add(key);
    branches.push({
      nodeIds,
      messages: nodeIds
        .map((id) => mapping[id]?.message)
        .filter((m): m is ChatGPTMessage => Boolean(m?.content)),
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

export function countBranches(conversation: Conversation): number {
  return getAllBranches(conversation).length;
}

export function findDefaultLeaf(mapping: Record<string, MessageNode>): string {
  const leaves = getLeafNodeIds(mapping);
  return leaves[0] ?? Object.keys(mapping)[0] ?? '';
}

export function getBranchPoints(
  conversation: Conversation,
): Array<{ parentId: string; childIds: string[]; depth: number }> {
  const mapping = conversation.mapping ?? {};
  const tree = buildEffectiveChildren(mapping);
  const points: Array<{ parentId: string; childIds: string[]; depth: number }> = [];

  for (const [id] of Object.entries(mapping)) {
    const kids = effectiveChildren(tree, id);
    if (kids.length > 1) {
      points.push({
        parentId: id,
        childIds: kids,
        depth: pathToRoot(mapping, kids[0]).length,
      });
    }
  }

  return points;
}
