---
name: environment-awareness
description: "Questions about your own runtime, model, tools, skills, tasks, context, or version; testing a change. Answer from live commands."
metadata:
  {
    "openclaw":
      {
        "emoji": "🧭",
      },
  }
---

# Knowing what you are running on

When the user asks "what model are you on / what can you do / what's running", answer from a **live
command**, never from what you remember about your own configuration. Your memory of your own
config can be stale because configuration may change while the runtime is active.

## The instruments

| question | command |
|---|---|
| model, runtime, session, budget | `/status` |
| full system-prompt breakdown, token counts | `/context json` (also `/context`, `/context list`, `/context detail`, `/context map`) |
| which tools are in this turn's catalog | `/tools` |
| what background work is running | `/tasks`, or `openclaw tasks list --runtime subagent --json` |
| runtime harness state | Use the runtime's supported status command |
| model + auth health | `openclaw models status` |
| plugins loaded | `openclaw plugins list` |
| skills present and whether their requirements are met | `openclaw skills list`, `openclaw skills check`, `openclaw skills info <name>` |
| durable task/audit history | `openclaw tasks show <id>`, `openclaw audit` |
| what this runtime can actually do | `$OPENCLAW_WORKSPACE/state/capability-map.md` |

Regenerate the capability map with the documented generator for this runtime.

Soul and kernel versions:

```bash
git -C "$OPENCLAW_WORKSPACE" log -1 -- SOUL.md AGENTS.md
```

## Reporting rule: never paste credential fragments

Runtime status commands can display masked or partial credential material. Report only whether authentication is present, missing, or associated with a provider; do not copy fragments into messages, files, logs, or commits. Do not inspect credential-store files or print environment-variable values. To check whether a variable is set, use the presence-only form ${VAR:+SET}.

## Answering the question well

The user does not read configuration. Keep the answer to six plain-English lines and answer first:

> Running on the configured model through the configured runtime. [Tool count] tools and [skill count] skills are available. [Background task count] tasks are running. [Health summary].

Not a config dump. If something is wrong, lead with the wrong thing.

## Testing a change

**Never test in the user's Telegram DM.** That session is production, it carries sticky overrides, and
a test turn there is a message the user has to read. Use a fresh session key:

```bash
openclaw agent --session-key <fresh-test-session-key> -m "<the probe>"
```

Deliberately **without** `--deliver`, so nothing is sent to a channel. Read the reply from the
command's own output.

For a config-level change, set PROBE_CONFIG to a temporary config path and prove the change without editing the live file:

```bash
OPENCLAW_CONFIG_PATH="$PROBE_CONFIG" openclaw <subcommand> ...
```

That runs OpenClaw's real code paths against a throwaway config. It is the difference between "the
snippet looks right" and "I ran it and saw the output."

## What is not yours to run

Restarting, reconfiguring, or rolling back a gateway belongs to the assigned runtime-operations owner. Do not run recovery tooling or change service-manager launch settings. If a restart is required, hand off the exact artifact and reason to that owner. A restart can interrupt pending task notifications; afterward, check task status for work whose completion notice may not have arrived. Separate runtime profiles can use different schemas, so do not copy configuration between profiles.
