---
name: detached-reflex
description: "Work that may take >15 s (research, media, builds, tests, multi-step): spawn it with sessions_spawn and reply now."
metadata:
  {
    "openclaw":
      {
        "emoji": "🌀",
      },
  }
---

# Detached Reflex — how Rook stays responsive

Keep direct conversations responsive. Long work can run in a background task while the conversation remains available. Treat this as the default for slow, multi-step work.

## When to detach

Detach if **any** of these is true:

- The work will plausibly take more than **10–15 seconds**.
- It needs more than **one slow call** (a model turn, a network fetch, a big file read).
- It is **research** — reading many files, searching the web, reconciling sources.
- It is **media processing** — transcribing anything long, converting video, generating audio.
- It is a **build, a test run, or a deploy**.
- It decomposes into **several subtasks** you would otherwise do in sequence.

Do **not** detach a question you can answer from what you already know, or a single fast tool call.
Detaching a two-second lookup is its own kind of rude.

## How to detach

One primitive: the **`sessions_spawn`** tool.

```
sessions_spawn {
  task: "<the task packet, below>",
  taskName: "transcribe-audio-task",     // ^[a-z][a-z0-9_-]{0,63}$
  label: "Transcribe the audio",    // human-readable, shows in /subagents
  context: "isolated",                     // default; use "fork" only to inherit this thread
  cleanup: "keep",
  mode: "run"
}
```

It returns `{status:'accepted', runId, childSessionKey}` **immediately**. It does not block.

### Hard rules

- **Do not bind a direct-message conversation to a child task.** That routes follow-up messages away from the main conversation. Keep the conversation responsive while background work runs.
- **Use the configured session-task API for conversational background work.** A sessionless worker does not inherit the runtime session, is not visible in the runtime task list, and may not deliver a completion notice.
- **Never pass `runMode`, `run`, `timeoutSeconds`, `runTimeoutSeconds`, `announce`, `announceTo`,
  `target`, `transport`, `channel`, `to`, `threadId`, or `replyTo`.** They are not in the schema and
  they throw. The announce is automatic.

### The task packet

The child gets an isolated context. Everything it needs must be inside `task`:

```
OUTCOME: <one sentence — what must be true when this is done>

ARTIFACT: <exact path>          # under the configured workspace deliverables directory or a temporary work directory
                                # use an allowed local directory for a file sent through the configured channel

ACCEPTANCE: <how the artifact is checked — file exists, non-empty, N rows, opens in X>

FACTS: <needed paths, IDs, prior findings, and configured resource references — never secret values>

ALLOWED TOOLS: <the ones this actually needs>

FORBIDDEN: send no messages; move no money; post nothing public; edit no config

BUDGET: <soft wall-clock expectation, e.g. "aim for under 10 minutes">

REPORT BACK, exactly:
  line 1: RESULT: ok | partial | failed
  then:   at most 8 lines of summary, plain English
  then:   the artifact path(s), one per line
```

Children should not have channel-send or runtime-control access unless the task requires it. State "no external messages" explicitly so the child does not waste time checking.

## Immediately after spawning

Reply to the user in **≤ 2 sentences**, in your own voice:

> On it — running that in the background. I'm here if you need anything else.

Then **stay available**. Never call `sessions_yield` in a direct chat (it is blocked there): a yield
ends your turn with nothing visible and the user sees silence. End the turn with the acknowledgement
above as your final text; the completion announce wakes this session by itself. If the user asked three
things and one is long, answer the two short ones now and detach the third.

Research, reading, and writing a brief are not engineering. Only code, repository, or production changes use the installation's approved engineering workflow. Do not route research tasks through a special engineering process.

## Route C — code, repos, production

Engineering work does not go through the conversation-session spawn mechanism. Use the installation's approved engineering workflow with its assigned owner, isolated workspace, review, and integration evidence. Research and brief writing can stay outside that workflow; code, repository, or production changes use it.
