import type { AgentSpec } from "../../src/types.ts";

/**
 * Minimal AgentSpec for manager and driver tests. The built-in roster lives in
 * src/agents/specs.ts; tests only need a spec-shaped value so the manager
 * contract stays independent of the shipped agents.
 */
export function testSpec(name = "worker", overrides: Partial<AgentSpec> = {}): AgentSpec {
  return {
    name,
    description: `${name} test agent`,
    systemPrompt: "child prompt",
    tools: [],
    skills: [],
    role: "subagents",
    ...overrides,
  };
}
