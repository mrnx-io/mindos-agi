// =============================================================================
// Causal Graph Analysis
// =============================================================================

import type {
  CausalGraph,
  CausalNode,
  CausalEdge,
} from "./types.js"

// -----------------------------------------------------------------------------
// Causal Graph Builder
// -----------------------------------------------------------------------------

export interface CausalGraphBuilder {
  addNode(node: Omit<CausalNode, "node_id">): string
  addEdge(edge: Omit<CausalEdge, "source_id" | "target_id"> & { source: string; target: string }): void
  build(): CausalGraph
  findRootCauses(nodeId: string): CausalNode[]
  findEffects(nodeId: string): CausalNode[]
  calculateCausalStrength(fromId: string, toId: string): number
  detectCycles(): string[][]
  pruneWeakEdges(threshold: number): void
}

export function createCausalGraphBuilder(): CausalGraphBuilder {
  const nodes = new Map<string, CausalNode>()
  const edges: CausalEdge[] = []

  function addNode(node: Omit<CausalNode, "node_id">): string {
    const nodeId = crypto.randomUUID()
    nodes.set(nodeId, { ...node, node_id: nodeId })
    return nodeId
  }

  function addEdge(edge: {
    source: string
    target: string
    causal_strength: number
    time_lag_ms?: number
    conditions?: string[]
  }): void {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) {
      throw new Error("Source or target node not found")
    }

    edges.push({
      source_id: edge.source,
      target_id: edge.target,
      causal_strength: edge.causal_strength,
      time_lag_ms: edge.time_lag_ms,
      conditions: edge.conditions,
    })
  }

  function build(): CausalGraph {
    // Find root causes (nodes with no incoming edges)
    const targetsSet = new Set(edges.map((e) => e.target_id))
    const rootCauses = Array.from(nodes.keys()).filter((id) => !targetsSet.has(id))

    // Find terminal effects (nodes with no outgoing edges)
    const sourcesSet = new Set(edges.map((e) => e.source_id))
    const terminalEffects = Array.from(nodes.keys()).filter((id) => !sourcesSet.has(id))

    return {
      graph_id: crypto.randomUUID(),
      nodes: Array.from(nodes.values()),
      edges: [...edges],
      root_causes: rootCauses,
      terminal_effects: terminalEffects,
      created_at: new Date().toISOString(),
    }
  }

  function findRootCauses(nodeId: string): CausalNode[] {
    const visited = new Set<string>()
    const roots: CausalNode[] = []

    function traverse(currentId: string): void {
      if (visited.has(currentId)) return
      visited.add(currentId)

      const incomingEdges = edges.filter((e) => e.target_id === currentId)

      if (incomingEdges.length === 0) {
        const node = nodes.get(currentId)
        if (node) roots.push(node)
      } else {
        for (const edge of incomingEdges) {
          traverse(edge.source_id)
        }
      }
    }

    traverse(nodeId)
    return roots
  }

  function findEffects(nodeId: string): CausalNode[] {
    const visited = new Set<string>()
    const effects: CausalNode[] = []

    function traverse(currentId: string): void {
      if (visited.has(currentId)) return
      visited.add(currentId)

      const outgoingEdges = edges.filter((e) => e.source_id === currentId)

      for (const edge of outgoingEdges) {
        const node = nodes.get(edge.target_id)
        if (node) {
          effects.push(node)
          traverse(edge.target_id)
        }
      }
    }

    traverse(nodeId)
    return effects
  }

  function calculateCausalStrength(fromId: string, toId: string): number {
    // Find all paths from source to target
    const paths = findAllPaths(fromId, toId)

    if (paths.length === 0) return 0

    // Calculate combined causal strength across all paths
    let totalStrength = 0

    for (const path of paths) {
      let pathStrength = 1

      for (let i = 0; i < path.length - 1; i++) {
        const edge = edges.find(
          (e) => e.source_id === path[i] && e.target_id === path[i + 1]
        )
        if (edge) {
          pathStrength *= Math.abs(edge.causal_strength)
        }
      }

      totalStrength += pathStrength
    }

    // Normalize to [0, 1]
    return Math.min(totalStrength, 1)
  }

  function findAllPaths(
    fromId: string,
    toId: string,
    visited = new Set<string>()
  ): string[][] {
    if (fromId === toId) return [[toId]]
    if (visited.has(fromId)) return []

    visited.add(fromId)
    const paths: string[][] = []

    const outgoing = edges.filter((e) => e.source_id === fromId)

    for (const edge of outgoing) {
      const subPaths = findAllPaths(edge.target_id, toId, new Set(visited))
      for (const subPath of subPaths) {
        paths.push([fromId, ...subPath])
      }
    }

    return paths
  }

  function detectCycles(): string[][] {
    const cycles: string[][] = []
    const visited = new Set<string>()
    const recursionStack = new Set<string>()
    const path: string[] = []

    function dfs(nodeId: string): void {
      visited.add(nodeId)
      recursionStack.add(nodeId)
      path.push(nodeId)

      const outgoing = edges.filter((e) => e.source_id === nodeId)

      for (const edge of outgoing) {
        if (!visited.has(edge.target_id)) {
          dfs(edge.target_id)
        } else if (recursionStack.has(edge.target_id)) {
          // Found cycle
          const cycleStart = path.indexOf(edge.target_id)
          const cycle = path.slice(cycleStart)
          cycle.push(edge.target_id)
          cycles.push(cycle)
        }
      }

      path.pop()
      recursionStack.delete(nodeId)
    }

    for (const nodeId of nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId)
      }
    }

    return cycles
  }

  function pruneWeakEdges(threshold: number): void {
    const strongEdges = edges.filter((e) => Math.abs(e.causal_strength) >= threshold)
    edges.length = 0
    edges.push(...strongEdges)
  }

  return {
    addNode,
    addEdge,
    build,
    findRootCauses,
    findEffects,
    calculateCausalStrength,
    detectCycles,
    pruneWeakEdges,
  }
}

// -----------------------------------------------------------------------------
// Causal Inference
// -----------------------------------------------------------------------------

export interface CausalInferenceResult {
  intervention_node: string
  predicted_effects: Array<{
    node_id: string
    expected_change: number
    confidence: number
  }>
  confounders: string[]
  mediators: string[]
}

export function inferCausalEffects(
  graph: CausalGraph,
  interventionNodeId: string,
  interventionMagnitude: number
): CausalInferenceResult {
  const node = graph.nodes.find((n) => n.node_id === interventionNodeId)
  if (!node) {
    throw new Error(`Node ${interventionNodeId} not found`)
  }

  // Find all downstream effects
  const effects: CausalInferenceResult["predicted_effects"] = []
  const visited = new Set<string>()

  function propagate(currentId: string, currentMagnitude: number, depth: number): void {
    if (visited.has(currentId) || depth > 10) return
    visited.add(currentId)

    const outgoing = graph.edges.filter((e) => e.source_id === currentId)

    for (const edge of outgoing) {
      const effectMagnitude = currentMagnitude * edge.causal_strength
      const confidence = Math.pow(0.9, depth) // Confidence decreases with depth

      effects.push({
        node_id: edge.target_id,
        expected_change: effectMagnitude,
        confidence,
      })

      propagate(edge.target_id, effectMagnitude, depth + 1)
    }
  }

  propagate(interventionNodeId, interventionMagnitude, 0)

  // Find confounders (common causes)
  const confounders: string[] = []
  const directEffects = new Set(effects.map((e) => e.node_id))

  for (const nodeId of directEffects) {
    const incoming = graph.edges.filter((e) => e.target_id === nodeId)
    for (const edge of incoming) {
      if (edge.source_id !== interventionNodeId && !directEffects.has(edge.source_id)) {
        confounders.push(edge.source_id)
      }
    }
  }

  // Find mediators (nodes on causal path)
  const mediators = effects
    .filter((e) => {
      const hasOutgoing = graph.edges.some((edge) => edge.source_id === e.node_id)
      return hasOutgoing && e.confidence > 0.5
    })
    .map((e) => e.node_id)

  return {
    intervention_node: interventionNodeId,
    predicted_effects: effects,
    confounders: [...new Set(confounders)],
    mediators,
  }
}

// -----------------------------------------------------------------------------
// Counterfactual Reasoning
// -----------------------------------------------------------------------------

export interface CounterfactualQuery {
  factual_state: Record<string, unknown>
  intervention: { node_id: string; new_value: unknown }
  query_node: string
}

export interface CounterfactualAnswer {
  query: CounterfactualQuery
  factual_value: unknown
  counterfactual_value: unknown
  causal_explanation: string
}

export function answerCounterfactual(
  graph: CausalGraph,
  query: CounterfactualQuery
): CounterfactualAnswer {
  const interventionNode = graph.nodes.find((n) => n.node_id === query.intervention.node_id)
  const queryNode = graph.nodes.find((n) => n.node_id === query.query_node)

  if (!interventionNode || !queryNode) {
    throw new Error("Invalid node IDs in counterfactual query")
  }

  // Get factual value
  const factualValue = query.factual_state[query.query_node]

  // Calculate counterfactual using causal inference
  const inference = inferCausalEffects(graph, query.intervention.node_id, 1)
  const effectOnQuery = inference.predicted_effects.find((e) => e.node_id === query.query_node)

  let counterfactualValue: unknown
  let explanation: string

  if (effectOnQuery) {
    // Query node is causally downstream of intervention
    counterfactualValue = typeof factualValue === "number"
      ? factualValue + effectOnQuery.expected_change
      : query.intervention.new_value

    explanation = `Intervening on ${interventionNode.label} would propagate through the causal graph to affect ${queryNode.label} with strength ${effectOnQuery.expected_change.toFixed(2)} (confidence: ${(effectOnQuery.confidence * 100).toFixed(0)}%)`
  } else {
    // No causal path exists
    counterfactualValue = factualValue
    explanation = `No causal path exists from ${interventionNode.label} to ${queryNode.label}, so the intervention would have no effect`
  }

  return {
    query,
    factual_value: factualValue,
    counterfactual_value: counterfactualValue,
    causal_explanation: explanation,
  }
}
