import type {
  BranchPath,
  ChatGPTMessage,
  Conversation,
  MessageNode,
} from './types.js';

/** All leaf nodes in the conversation DAG (regenerated branches). */
export function getLeafNodeIds(mapping: Record<string, MessageNode>): string[] {
  return Object.entries(mapping)
    .filter(([, node]) => !node.children || node.children.length === 0)
    .map(([id]) => id);
}

/** Walk from node to root, collecting messages. */
export function pathToRoot(
  mapping: Record<string, MessageNode>,
  leafId: string,
): string[] {
  const path: string[] = [];
  let current: string | null | undefined = leafId;

  while (current) {
    path.push(current);
    const node: MessageNode | undefined = mapping[current];
    if (!node?.parent) break;
    current = node.parent;
  }

  return path.reverse();
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

/** Every branch path through the conversation tree. */
export function getAllBranches(conversation: Conversation): BranchPath[] {
  const mapping = conversation.mapping ?? {};
  const leaves = getLeafNodeIds(mapping);
  const seen = new Set<string>();
  const branches: BranchPath[] = [];

  for (const leafId of leaves) {
    const nodeIds = pathToRoot(mapping, leafId);
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

  return branches;
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
  const points: Array<{ parentId: string; childIds: string[]; depth: number }> = [];

  for (const [id, node] of Object.entries(mapping)) {
    if (node.children && node.children.length > 1) {
      points.push({
        parentId: id,
        childIds: node.children,
        depth: pathToRoot(mapping, node.children[0]).length,
      });
    }
  }

  return points;
}
