// =============================================================================
// Merkle Tree Implementation for Evidence Verification
// =============================================================================

import { sha256 } from "./hasher.js"
import type { MerkleNode, MerkleProof } from "./types.js"

// -----------------------------------------------------------------------------
// Merkle Tree Construction
// -----------------------------------------------------------------------------

/**
 * Builds a Merkle tree from a list of content hashes.
 * Returns array of nodes organized by level (leaves at index 0).
 */
export function buildMerkleTree(hashes: string[]): MerkleNode[][] {
  if (hashes.length === 0) {
    throw new Error("Cannot build Merkle tree from empty list")
  }

  // Create leaf nodes
  const leaves: MerkleNode[] = hashes.map((hash) => ({
    hash,
    left: null,
    right: null,
    data: hash,
    level: 0,
  }))

  // If odd number of leaves, duplicate the last one
  if (leaves.length % 2 === 1) {
    const lastLeaf = leaves[leaves.length - 1]
    if (lastLeaf) {
      leaves.push({ ...lastLeaf })
    }
  }

  const levels: MerkleNode[][] = [leaves]
  let currentLevel = leaves

  // Build tree bottom-up
  while (currentLevel.length > 1) {
    const nextLevel: MerkleNode[] = []
    const levelNum = levels.length

    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i]
      if (!left) continue
      const right = currentLevel[i + 1] ?? left

      const combinedHash = sha256(left.hash + right.hash)

      nextLevel.push({
        hash: combinedHash,
        left: left.hash,
        right: right.hash,
        data: null,
        level: levelNum,
      })
    }

    levels.push(nextLevel)
    currentLevel = nextLevel
  }

  return levels
}

/**
 * Gets the root hash of a Merkle tree.
 */
export function getMerkleRoot(tree: MerkleNode[][]): string {
  if (tree.length === 0) {
    throw new Error("Empty Merkle tree")
  }

  const topLevel = tree[tree.length - 1]
  if (!topLevel || !topLevel[0]) {
    throw new Error("Invalid Merkle tree structure")
  }
  return topLevel[0].hash
}

// -----------------------------------------------------------------------------
// Merkle Proof Generation
// -----------------------------------------------------------------------------

/**
 * Generates a Merkle proof for a specific leaf hash.
 * The proof can be used to verify the leaf is part of the tree.
 */
export function generateMerkleProof(tree: MerkleNode[][], leafHash: string): MerkleProof | null {
  if (tree.length === 0) return null

  const leaves = tree[0]
  if (!leaves) return null
  let leafIndex = leaves.findIndex((node) => node.hash === leafHash)

  if (leafIndex === -1) return null

  const path: MerkleProof["path"] = []

  for (let level = 0; level < tree.length - 1; level++) {
    const currentLevel = tree[level]
    if (!currentLevel) continue
    const isRightNode = leafIndex % 2 === 1
    const siblingIndex = isRightNode ? leafIndex - 1 : leafIndex + 1

    const siblingNode = currentLevel[siblingIndex]
    if (siblingIndex < currentLevel.length && siblingNode) {
      path.push({
        hash: siblingNode.hash,
        position: isRightNode ? "left" : "right",
      })
    }

    leafIndex = Math.floor(leafIndex / 2)
  }

  return {
    root: getMerkleRoot(tree),
    leaf: leafHash,
    path,
  }
}

// -----------------------------------------------------------------------------
// Merkle Proof Verification
// -----------------------------------------------------------------------------

/**
 * Verifies a Merkle proof.
 * Returns true if the proof is valid (leaf is part of tree with given root).
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  let currentHash = proof.leaf

  for (const step of proof.path) {
    if (step.position === "left") {
      currentHash = sha256(step.hash + currentHash)
    } else {
      currentHash = sha256(currentHash + step.hash)
    }
  }

  return currentHash === proof.root
}

// -----------------------------------------------------------------------------
// Tree Utilities
// -----------------------------------------------------------------------------

/**
 * Finds a node in the tree by its hash.
 */
export function findNode(tree: MerkleNode[][], hash: string): MerkleNode | null {
  for (const level of tree) {
    for (const node of level) {
      if (node.hash === hash) {
        return node
      }
    }
  }
  return null
}

/**
 * Gets all leaf hashes from a tree.
 */
export function getLeafHashes(tree: MerkleNode[][]): string[] {
  if (tree.length === 0) return []
  const leaves = tree[0]
  if (!leaves) return []
  return leaves.map((node) => node.hash)
}

/**
 * Computes the depth of a Merkle tree.
 */
export function getTreeDepth(tree: MerkleNode[][]): number {
  return tree.length
}

/**
 * Validates tree structure (all levels properly connected).
 */
export function validateTreeStructure(tree: MerkleNode[][]): boolean {
  for (let level = 1; level < tree.length; level++) {
    const currentLevel = tree[level]
    const previousLevel = tree[level - 1]
    if (!currentLevel || !previousLevel) continue

    for (const node of currentLevel) {
      if (node.left === null || node.right === null) continue

      const leftExists = previousLevel.some((n) => n.hash === node.left)
      const rightExists = previousLevel.some((n) => n.hash === node.right)

      if (!leftExists || !rightExists) {
        return false
      }

      // Verify hash computation
      const expectedHash = sha256(node.left + node.right)
      if (node.hash !== expectedHash) {
        return false
      }
    }
  }

  return true
}
