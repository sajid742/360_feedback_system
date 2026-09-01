/**
 * Walks the proposed parent/manager chain upward; returns true if it reaches the
 * node being reassigned (a cycle) or exceeds maxDepth. Reused across department
 * parent, designation promotion-path, and employee line-manager reassignment.
 */
export async function wouldCreateCycle(
  fetchParentId: (id: string) => Promise<string | null>,
  proposedParentId: string,
  nodeId: string,
  maxDepth = 100,
): Promise<boolean> {
  let current: string | null = proposedParentId;
  let depth = 0;
  while (current) {
    if (current === nodeId) return true;
    if (depth >= maxDepth) return true;
    depth += 1;
    current = await fetchParentId(current);
  }
  return false;
}
