# Threads and lifecycle

## Paths

`/root` is the main pi conversation. Every subagent gets a path under a root.

```text
/root
  /root/coding-researcher
  /root/change-file-names
    /root/change-file-names/review
/k                           # independent root: no /root history
  /k/l                       # inherits /k, never /root/...
```

- Relative names resolve under the calling agent.
- A nested parent must already exist.
- `/root` can address every tree. Children can spawn immediate children and address only their descendants.
- Dot segments, URL escapes and ambiguous slash spellings are rejected.
- Name paths after the **task** (`fix-auth`), not the agent name.

## Context

A child starts from a snapshot of its **lexical parent** (the path one level up).

- **Included:** conversation messages, custom messages, shell output.
- **Excluded:** the parent's system prompt, unmatched tool calls/results.
- **Frozen:** later parent turns don't change the child's context.
- **Model/thinking:** pinned by the `modes.json` role of the agent, never inherited from the parent.
- **Independent roots** (`/k`) use the main session's model defaults but **none of its history**.

## States

| Child action           | State       | Parent receives              |
| ---------------------- | ----------- | ---------------------------- |
| Returns a final answer | `completed` | The final answer only        |
| Calls `agent_pause`    | `paused`    | Status and reason, no answer |
| Is stopped             | `stopped`   | —                            |
| Errors                 | `failed`    | The error                    |

Every state keeps the session. Any of them can be resumed with `agent_steer`.

- `agent_update` reports progress without ending the task.
- Pause takes effect at the turn boundary. Call it alone, not alongside other tools.
- `agent_stop` cancels a thread and its working descendants. Resume a stopped ancestor before its descendants.
- Wait timeouts don't kill children.
- Progress and completion notices don't force a parent turn; the parent sees them on its next turn.

## Persistence

**Transcripts.** Each child is a normal pi JSONL session in the main session directory (normally `<pi-agent-dir>/sessions/<encoded-cwd>/`), named like `worker /root/task`, with a `parentSession` link.

- In `pi --resume` / `/resume` with **Threaded** sorting and empty search, children nest under parents.
- Recent/Fuzzy sorting and search show flat rows. Named-only filtering can hide an unnamed parent.

**Registry.** The parent saves its thread tree, pending steering and progress mailboxes in its own session.

- `/reload` or reopening the parent restores retained threads.
- Interrupted work comes back **paused**, never auto-restarted.
- Older transcripts under `<pi-agent-dir>/subagents/<parent-session-id>/` still reopen through the registry.

**Resuming.**

- Resume the **main session** to keep the managed tree and tool policies.
- Opening a child directly gives a normal, unmanaged session. Don't do this while the parent is running it.
- `pi --continue` may pick a recently active child. Use `pi --resume` to choose the main session.

**Branching.**

- A forked main session gets a fresh registry, so two parents never write the same child transcript.
- Tree navigation in the parent restores that branch's registry and each child's transcript leaf.
- Resuming from an older checkpoint branches the child file; newer branches stay intact.
- In-memory main sessions don't survive process exit.
