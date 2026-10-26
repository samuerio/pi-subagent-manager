import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ThreadManager } from "./manager.ts";
import { listAgentSpecs, spawnToolName } from "../agents/specs.ts";
import type { AgentSpec, ThreadView } from "../types.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderSpawnCall, renderSpawnResult } from "../ui/spawn-render.ts";

const path = Type.String({ description: "Absolute agent path, or name relative to the caller" });
const text = Type.String({ minLength: 1 });
function compact(thread: ThreadView): ThreadView & { outputTruncated?: boolean } {
  if (thread.output && thread.output.length > 16000)
    return { ...thread, output: thread.output.slice(0, 16000), outputTruncated: true };
  return thread;
}
function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: value,
  };
}

/**
 * Spawn parameters shared by every spawn verb. There is no `type` field: the tool
 * name IS the agent, so the model cannot pick a spec that its own allowlist
 * excluded.
 */
const SpawnParams = Type.Object({
  path: Type.String({
    description:
      "Task-based kebab-case path (e.g. /root/controller-security-research), or a task name relative to the caller",
  }),
  description: Type.String({
    description: "A very short description of the task that can be displayed to the user.",
  }),
  task: text,
  wait: Type.Optional(Type.Boolean()),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 30000,
      maximum: 300000,
      description:
        "Optional report-only timeout, 30000–300000 ms (30s–5min). If the child is still running after this many ms, a status event is sent to you; the child keeps running.",
    }),
  ),
});

/**
 * The spawn description is the spec's own description plus the shared mechanics,
 * because there is no agent_types tool to discover capabilities at runtime.
 */
function spawnDescription(spec: AgentSpec, toolName: string): string {
  return `${spec.description}

Spawns a \`${spec.name}\` child. The lexical parent, NOT the caller, supplies a context snapshot: /root is the main thread, and an independent root (/task) has no inherited context. Foreground waits by default; wait:false runs detached, and when it completes, fails or is stopped you receive a message event that wakes you, so do not poll. Optional timeoutMs (30000–300000): if the child is still running after that many ms you receive an event with its status, elapsed, tokens and recent output; the child is NOT stopped. For parallel work, spawn every independent sibling with wait:false before calling agent_wait. Existing paths are retained; resume them with agent_steer rather than ${toolName}.`;
}

/**
 * All threads see the same verbs, with caller identity bound by closure, never
 * model input. Spawn verbs are generated from the spec table so adding an agent
 * never touches this file.
 */
export function agentTools(getManager: () => ThreadManager, caller: string): ToolDefinition[] {
  const threads = () => getManager().scope(caller);
  const make = (
    name: string,
    description: string,
    parameters: any,
    execute: (params: any, signal?: AbortSignal) => Promise<any> | any,
  ): ToolDefinition => ({
    name,
    label: name,
    description,
    parameters,
    execute: async (_id, params, signal) => execute(params, signal),
  });
  const spawnTools = listAgentSpecs().map((spec) => {
    const toolName = spawnToolName(spec.name);
    return {
      ...make(toolName, spawnDescription(spec, toolName), SpawnParams, async (params, signal) =>
        result(compact(await threads().spawn({ ...params, type: spec.name }, signal))),
      ),
      renderCall: (args: unknown, theme: Theme) => renderSpawnCall(args, theme, toolName),
      renderResult: renderSpawnResult,
    };
  });
  return [
    ...spawnTools,
    make(
      "agent_wait",
      "Wait for a descendant to complete, fail, stop or pause. Paused means no final answer handback. Cancellation/timeouts do not stop the child; poll status or wait again.",
      Type.Object({
        path,
        timeoutMs: Type.Optional(Type.Integer({ minimum: 0, maximum: 3600000 })),
      }),
      async (params, signal) =>
        result(compact(await threads().wait(params.path, params.timeoutMs, signal))),
    ),
    make(
      "agent_steer",
      'Send input to a descendant and/or re-arm its report-only timeout. With message: working threads receive queued steering; completed, stopped and paused threads resume the SAME session with its previous context. With timeoutMs (30000–300000): the timeout fires that many ms from now, replacing any pending timer. To extend a running background agent\'s reporting timer without sending input, call agent_steer({path: "/root/task", timeoutMs: 120000}) and omit message entirely. This resets the timer to 120000 ms from now, not an addition to the old deadline. timeoutMs WITHOUT message only re-arms the timeout of a running child (error if not running) and does not steer, interrupt or resume it; with both, steer and re-arm. At least one is required. Returns immediately; use agent_wait for the result.',
      Type.Object({
        path,
        message: Type.Optional(
          Type.String({
            minLength: 1,
            description: "Input to send or resume with. Omit entirely for a timer-only re-arm.",
          }),
        ),
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: 30000,
            maximum: 300000,
            description:
              "Reset the report-only timer to this many ms from now, replacing any pending timer. With no message, only re-arms a running agent; does not send input, interrupt or resume it.",
          }),
        ),
      }),
      async (params) =>
        result(compact(await threads().steer(params.path, params.message, params.timeoutMs))),
    ),
    make(
      "agent_status",
      "Read a thread's status, including bounded child extension diagnostics, or list visible descendants. Root can inspect all trees. Completion retains the session; pause retains it without final answer handback.",
      Type.Object({ path: Type.Optional(path) }),
      (params) =>
        result(params.path ? compact(threads().get(params.path)) : threads().list().map(compact)),
    ),
    make(
      "agent_update",
      "Child-only: send progress to the parent without ending this task. Delivery is recorded and displayed but does not interrupt or automatically restart the parent model.",
      Type.Object({ message: Type.String({ minLength: 1, maxLength: 8000 }) }),
      (params) => result(compact(threads().update(params.message))),
    ),
    make(
      "agent_pause",
      "Child-only: stop at this turn boundary WITHOUT returning a final answer. Keep the SAME session for user/parent input via agent_steer. To finish and hand back an answer instead, simply return your final assistant answer. Both states can be resumed.",
      Type.Object({ reason: text }),
      (params) => ({
        ...result({
          path: caller,
          pauseRequested: true,
          status: threads().pause(params.reason).status,
        }),
        terminate: true,
      }),
    ),
    make(
      "agent_stop",
      "Stop a descendant and its working children. Session history is retained; resume with agent_steer. This is cooperative cancellation, not sandbox process termination.",
      Type.Object({ path }),
      async (params) => result(compact(await threads().stop(params.path))),
    ),
    make(
      "agent_output",
      "Read completed thread output in character pages. Paused threads deliberately have no final answer handback. All sessions can be viewed by the user with /agents tree; select a thread and press Enter to inspect it.",
      Type.Object({
        path,
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 16000 })),
      }),
      (params) => {
        const output = threads().output(params.path),
          offset = params.offset ?? 0,
          limit = params.limit ?? 8000;
        return result({
          path: threads().get(params.path).path,
          text: output.slice(offset, offset + limit),
          totalCharacters: output.length,
          nextOffset: offset + limit < output.length ? offset + limit : null,
        });
      },
    ),
  ];
}
