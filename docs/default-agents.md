# Built-in agents

Four agents ship with the extension. They are code, not files: each one is an entry in
[`src/agents/specs.ts`](../src/agents/specs.ts) with a name, tool description, system prompt, tool
allowlist, skills, color, icon, and model role. Adding an agent means adding an entry there; the
spawn tool, prompt guidance, `/agents` completion, and the widget badge all derive from that table.

Retained threads keep the definition they were saved with, so changing a spec never rewrites an
existing agent's history.

## The four agents

| Agent       | Spawn tool        | Role        | Tool allowlist                                                               |
| ----------- | ----------------- | ----------- | ---------------------------------------------------------------------------- |
| `task`      | `task_spawn`      | `subagents` | read, write, edit, bash, grep, find, ls, progress/pause, delegation, control |
| `finder`    | `finder_spawn`    | `subagents` | read, bash, grep, find, ls, progress/pause                                   |
| `oracle`    | `oracle_spawn`    | `oracle`    | read, bash, grep, find, ls, progress/pause                                   |
| `librarian` | `librarian_spawn` | `subagents` | read, bash, grep, find, ls, progress/pause, plus its `librarian` skill       |

- **`task`** does the work: implementation, refactoring, debugging, and any bounded job. It is the only
  agent that can delegate, because only its allowlist contains the spawn verbs and the control tools.
- **`finder`** searches. It returns file paths with line ranges instead of essays, and is designed for
  many parallel calls and a handful of turns.
- **`oracle`** advises. Reviews, plans, architecture calls, and hard reasoning questions. It does not
  edit files and does not search on its own (spawn a `finder` for that).
- **`librarian`** understands repositories outside the workspace, locally or by cloning through its
  skill's `checkout.sh`.

`agent_update` and `agent_pause` are in every allowlist. They let a child report progress without
ending its task, or stop at a turn boundary while keeping its session for a later `agent_steer`.

## Model routing

An agent never carries a model. Each spec names a role, and the active mode in `modes.json` pins that
role's provider, model, and thinking level:

| Role        | Serves                                          |
| ----------- | ----------------------------------------------- |
| `oracle`    | `oracle_spawn`                                  |
| `subagents` | `task_spawn`, `finder_spawn`, `librarian_spawn` |

A missing pin is a hard error that names the file and the missing field. See
[settings](settings.md#model-routing-roles-in-modesjson) for the shape, path precedence, and behavior
when a mode changes while agents are running.

## Customizing

Edit the spec. There is no forked prompt file and no settings overlay, deliberately: a single table is
easier to review than a cascade of `.md` and `.yml` layers. Practical changes:

- **Different prompt or tools:** edit that spec's `systemPrompt` and `tools` arrays.
- **Fewer/more delegation rights:** add or remove `*_spawn` and `agent_*` entries from `tools`.
  Names are matched exactly; an unavailable name is ignored rather than fatal.
- **New agent:** add an entry, pick a `role`, and it registers as `<name>_spawn` at load time. Keep
  `src/types.ts` `AGENT_SPEC_NAMES` in sync if you want `/agents` completion and prompt guidance to
  advertise it.
- **Different model per agent:** put the agent in its own role in `modes.json` instead of reusing
  `subagents`.

## Nerd Font icons

The optional **[labs] Nerd Font icons** [setting](settings.md#labs-nerd-font-icons-nerdfonticons) is off
by default and requires a Nerd Font in your terminal. Each spec carries a literal glyph:

| Agent       | Nerd Fonts identifier | Codepoint |
| ----------- | --------------------- | --------- |
| `task`      | `nf-fa-code`          | `U+F121`  |
| `finder`    | `nf-fa-search`        | `U+F002`  |
| `oracle`    | `nf-md-floor_plan`    | `U+F0821` |
| `librarian` | `nf-fa-pencil`        | `U+F040`  |

Codepoints were checked against the
[official Nerd Fonts glyph mapping](https://raw.githubusercontent.com/ryanoasis/nerd-fonts/master/glyphnames.json).
Roles may share a glyph if you edit the table; the shipped four are distinct.

## Why these agents

The roster is deliberately small: one worker, one searcher, one advisor, one reader of foreign
repositories. `task` covers the implementation work that used to be split across several roles, and
`oracle` is the only agent on the advisor role, so a strong reasoning model can be budgeted for it
alone.

The 2026 model shortlist research in `docs/` predates the switch to `modes.json` pinning and is kept
as history, not as configuration guidance.
