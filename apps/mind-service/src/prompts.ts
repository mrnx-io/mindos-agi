// =============================================================================
// MindOS - Prompt Templates
// =============================================================================

import type { CoreSelf, PolicyProfile, Tool, ExecutionContext, TaskStep } from "./types.js"

// -----------------------------------------------------------------------------
// System Prompt
// -----------------------------------------------------------------------------

export function buildSystemPrompt(
  coreSelf: CoreSelf,
  policy: PolicyProfile,
  availableTools: Tool[]
): string {
  const values = coreSelf.values.map((v) => `- ${v.name}: ${v.description}`).join("\n")
  const goals = coreSelf.goals.map((g) => `- ${g.name} (priority ${g.priority}): ${g.description}`).join("\n")
  const constraints = coreSelf.constraints.map((c) => `- [${c.type}] ${c.name}: ${c.description}`).join("\n")
  const tools = availableTools.map((t) => `- ${t.name}: ${t.description}`).join("\n")

  return `You are an autonomous AI agent operating within the MindOS framework.

## Core Identity

### Values
${values || "No explicit values defined."}

### Active Goals
${goals || "No explicit goals defined."}

### Constraints
${constraints || "No explicit constraints defined."}

## Available Tools
${tools || "No tools currently available."}

## Operating Principles

1. **Evidence-Based Reasoning**: Every claim must be traceable to evidence. When uncertain, explicitly state confidence levels.

2. **Risk-Aware Execution**: Before taking any action, assess potential risks and reversibility. Actions with risk > ${policy.approval_threshold ?? 0.7} require human approval.

3. **Iterative Planning**: Break complex goals into steps. After each step, reflect on progress and adjust if needed.

4. **Memory Utilization**: Draw on episodic memory for context, semantic memory for knowledge, and procedural memory for skills.

5. **Metacognitive Awareness**: Monitor your own reasoning. If you detect confusion, low confidence, or potential errors, pause and reassess.

6. **Transparent Communication**: Explain your reasoning process. Users should understand why you're taking specific actions.

## Response Format

When planning or executing tasks, structure your thinking as:

1. **Understanding**: What is being asked? What context is relevant?
2. **Planning**: What steps are needed? What tools will I use?
3. **Risk Assessment**: What could go wrong? Is this reversible?
4. **Execution**: Carry out the planned steps
5. **Reflection**: Did it work? What did I learn?

## Safety Guardrails

- Never execute destructive operations without explicit confirmation
- Do not expose credentials, API keys, or sensitive data
- Respect rate limits and resource constraints
- If in doubt, ask for clarification rather than proceeding

Remember: You have persistent memory and identity across sessions. Your actions affect your future self and the humans who rely on you.`
}

// -----------------------------------------------------------------------------
// Planner Prompt
// -----------------------------------------------------------------------------

export function buildPlannerPrompt(
  goal: string,
  context: ExecutionContext,
  availableTools: Tool[]
): string {
  const toolList = availableTools.map((t) => `- ${t.name}: ${t.description}`).join("\n")

  return `## Task: Create an Execution Plan

### Goal
${goal}

### Context
${context.background ? `Background: ${context.background}` : ""}
${context.constraints ? `Constraints: ${context.constraints.join(", ")}` : ""}
${context.resources ? `Available resources: ${context.resources.join(", ")}` : ""}

### Available Tools
${toolList}

### Instructions

Create a detailed execution plan with the following structure:

1. **Analysis**: Break down the goal into sub-goals
2. **Steps**: For each sub-goal, specify:
   - Description of what needs to be done
   - Which tool(s) to use
   - Expected inputs and outputs
   - Potential failure modes
   - Fallback options if step fails
3. **Success Criteria**: How we'll know the goal is achieved
4. **Risk Assessment**: Overall risk level and specific concerns
5. **Rollback Strategy**: How to undo changes if something goes wrong

Respond with a JSON object matching this schema:
{
  "goal": "string",
  "steps": [
    {
      "description": "string",
      "tool": "string (optional)",
      "parameters": {},
      "expected_outcome": "string",
      "risk_factors": ["string"],
      "alternatives": ["string"]
    }
  ],
  "success_criteria": ["string"],
  "rollback_strategy": "string",
  "estimated_risk": 0.0-1.0
}`
}

// -----------------------------------------------------------------------------
// Decision Prompt
// -----------------------------------------------------------------------------

export function buildDecisionPrompt(
  currentStep: TaskStep,
  history: TaskStep[],
  goal: string
): string {
  const historyStr = history
    .map((s, i) => `${i + 1}. ${s.action.kind}: ${s.result?.success ? "✓" : "✗"} - ${s.summary || "No summary"}`)
    .join("\n")

  return `## Decision Point

### Original Goal
${goal}

### Current Step
${currentStep.description}

### Execution History
${historyStr || "No previous steps."}

### Instructions

Based on the current state and history, decide what to do next:

1. If the goal is complete, set done=true and provide a final_report
2. If more work is needed, specify the next action
3. If you're uncertain, list your assumptions and concerns

Respond with a JSON object:
{
  "done": boolean,
  "summary": "string - brief description of current state",
  "assumptions": ["string - any assumptions being made"],
  "next": {
    "kind": "tool_call" | "delegate" | "ask_human" | "wait",
    "tool": "string (if tool_call)",
    "parameters": {},
    "reason": "string"
  } | null,
  "final_report": "string (if done=true)",
  "metacognitive_notes": "string - any concerns about reasoning"
}`
}

// -----------------------------------------------------------------------------
// Reflection Prompt
// -----------------------------------------------------------------------------

export function buildReflectionPrompt(
  goal: string,
  steps: TaskStep[],
  outcome: { success: boolean; result: unknown }
): string {
  const stepSummary = steps
    .map((s, i) => {
      const duration = s.completed_at && s.started_at
        ? new Date(s.completed_at).getTime() - new Date(s.started_at).getTime()
        : 0
      return `${i + 1}. ${s.description}
   - Tool: ${s.action.tool || "none"}
   - Success: ${s.result?.success ? "Yes" : "No"}
   - Duration: ${duration}ms
   - Output: ${JSON.stringify(s.result?.output).slice(0, 200)}...`
    })
    .join("\n\n")

  return `## Task Reflection

### Goal
${goal}

### Outcome
Success: ${outcome.success}
Result: ${JSON.stringify(outcome.result).slice(0, 500)}

### Execution Steps
${stepSummary}

### Reflection Questions

Analyze this task execution and provide:

1. **What worked well?** Identify successful patterns and decisions.

2. **What could be improved?** Point out inefficiencies or mistakes.

3. **What was learned?** Extract generalizable knowledge.

4. **Skill candidates**: Should any action sequences be saved as reusable skills?

5. **Memory updates**: What facts should be stored for future reference?

6. **Self-assessment**: Rate your performance (0-1) and explain.

Respond with JSON:
{
  "successes": ["string"],
  "improvements": ["string"],
  "learnings": ["string"],
  "skill_candidates": [
    {
      "name": "string",
      "description": "string",
      "trigger_patterns": ["string"],
      "tool_sequence": []
    }
  ],
  "memory_updates": [
    {
      "content": "string",
      "metadata": {}
    }
  ],
  "self_assessment": {
    "score": 0.0-1.0,
    "rationale": "string"
  }
}`
}

// -----------------------------------------------------------------------------
// Metacognitive Prompt
// -----------------------------------------------------------------------------

export function buildMetacognitivePrompt(
  currentState: {
    goal: string
    step: number
    recentDecisions: string[]
    concerns: string[]
  }
): string {
  return `## Metacognitive Check

You are pausing to reflect on your current reasoning process.

### Current State
- Goal: ${currentState.goal}
- Step: ${currentState.step}
- Recent decisions: ${currentState.recentDecisions.join("; ")}
- Flagged concerns: ${currentState.concerns.join("; ")}

### Self-Examination Questions

1. **Confidence Check**: How confident am I in my current approach? (0-1)
   - What evidence supports this confidence level?
   - What could I be missing?

2. **Assumption Audit**: What assumptions am I making?
   - Which are well-founded?
   - Which need verification?

3. **Alternative Paths**: What other approaches could work?
   - Why did I choose this path over alternatives?
   - Should I reconsider?

4. **Uncertainty Sources**: Where is my uncertainty highest?
   - Is it reducible (more information would help)?
   - Or irreducible (inherent randomness)?

5. **Bias Check**: Am I falling into any cognitive traps?
   - Anchoring on early information?
   - Confirmation bias?
   - Sunk cost fallacy?

Respond with JSON:
{
  "confidence": {
    "score": 0.0-1.0,
    "supporting_evidence": ["string"],
    "potential_blind_spots": ["string"]
  },
  "assumptions": [
    {
      "assumption": "string",
      "well_founded": boolean,
      "needs_verification": boolean
    }
  ],
  "alternatives": [
    {
      "approach": "string",
      "pros": ["string"],
      "cons": ["string"]
    }
  ],
  "uncertainties": [
    {
      "source": "string",
      "type": "epistemic" | "aleatoric",
      "reducible": boolean,
      "reduction_strategy": "string"
    }
  ],
  "bias_risks": ["string"],
  "recommended_action": "continue" | "pause" | "reconsider" | "ask_human",
  "rationale": "string"
}`
}

// -----------------------------------------------------------------------------
// Tool Selection Prompt
// -----------------------------------------------------------------------------

export function buildToolSelectionPrompt(
  intent: string,
  availableTools: Tool[]
): string {
  const toolDescriptions = availableTools
    .map((t) => `### ${t.name}
- Description: ${t.description}
- Parameters: ${JSON.stringify(t.parameters)}
- Risk level: ${t.risk_level || "unknown"}`)
    .join("\n\n")

  return `## Tool Selection

### Intent
${intent}

### Available Tools
${toolDescriptions}

### Instructions

Select the most appropriate tool for this intent and explain why.

Consider:
1. Does the tool's capability match the intent?
2. What's the risk level? Is it acceptable?
3. Are there safer alternatives that would also work?

Respond with JSON:
{
  "selected_tool": "string",
  "confidence": 0.0-1.0,
  "rationale": "string",
  "parameters": {},
  "alternatives": [
    {
      "tool": "string",
      "why_not_selected": "string"
    }
  ],
  "risk_assessment": {
    "level": "low" | "medium" | "high",
    "concerns": ["string"],
    "mitigations": ["string"]
  }
}`
}

// -----------------------------------------------------------------------------
// Grounding Verification Prompt
// -----------------------------------------------------------------------------

export function buildGroundingPrompt(
  claim: string,
  evidence: Array<{ source: string; content: string }>
): string {
  const evidenceStr = evidence
    .map((e, i) => `[${i + 1}] Source: ${e.source}\n${e.content}`)
    .join("\n\n")

  return `## Fact Verification

### Claim to Verify
"${claim}"

### Available Evidence
${evidenceStr || "No evidence provided."}

### Instructions

Assess whether the claim is supported by the evidence:

1. **Evidence Analysis**: What does each source say about the claim?
2. **Consistency Check**: Do sources agree or contradict?
3. **Confidence Assessment**: How strongly does evidence support/refute the claim?
4. **Gap Analysis**: What additional evidence would be helpful?

Respond with JSON:
{
  "verdict": "supported" | "contradicted" | "uncertain" | "no_evidence",
  "confidence": 0.0-1.0,
  "analysis": [
    {
      "source_index": number,
      "relevance": 0.0-1.0,
      "supports_claim": boolean,
      "key_points": ["string"]
    }
  ],
  "contradictions": ["string"],
  "gaps": ["string"],
  "summary": "string"
}`
}
