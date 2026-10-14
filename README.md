# rook-reflex

An experimental OpenClaw plugin that classifies incoming turns into four routing hints and records lifecycle metadata, timing, and undelivered-run information. It adds prompt context and writes local state files; it does not start background tasks or change the selected model.

## Requirements

The plugin package metadata declares the OpenClaw plugin API and minimum gateway compatibility at >=2026.7.1. It uses Node.js ESM and has no declared runtime package dependencies. The included test runner also requires Python 3. This snapshot has not been checked against a running OpenClaw installation; installation and compatibility remain unverified.

## Configure

Load the plugin/rook-reflex directory with OpenClaw's plugin loader, allow the rook-reflex plugin ID, and enable its entry. The existing source configuration uses allowConversationAccess: true and allowPromptInjection: true for the relevant hooks. Confirm those settings against your installed OpenClaw version.

Set stateDir to a writable private directory. The default is ~/.openclaw/state/rook-reflex. The plugin creates receipt JSON files plus telemetry.jsonl, undelivered.jsonl, and an error log there.

Example placeholders:

```json5
{
  plugins: {
    load: { paths: ["<PLUGIN_DIR>"] },
    allow: ["rook-reflex"],
    entries: {
      "rook-reflex": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
          allowPromptInjection: true
        },
        config: { stateDir: "<PRIVATE_STATE_DIR>" }
      }
    }
  }
}
```

## State and privacy

The plugin records routing results, runtime and session identifiers, delivery destination, timestamps, provider/model metadata, counts, a request excerpt limited to 120 characters, and bounded error text. The excerpt and error text redact only recognized secret-shaped formats. Ordinary private, contact, or customer text can remain in local state, so keep the state directory private. The plugin does not persist tool arguments or assistant message text.

## Included skills and utilities

The snapshot includes these portable skills:

- detached-reflex
- environment-awareness
- inspect-unknown-media
- synthesize-voice-response
- transcribe-anything

The tools directory includes:

- tools/reflex_report.py, which summarizes telemetry and supports --state-dir. Its default state directory matches the plugin default.
- tools/build_plugin_patch.py, which prints a plugin configuration patch. Its --apply option mutates the user's local OpenClaw configuration.
- tools/rook_skills_sync.sh, which copies the included skills into the local OpenClaw workspace and can overwrite files with the same names.

## Existing checks

From the repository root, tests/run_all.sh runs the Node.js hook/router tests and Python truth-table wrapper. The checks are included but were not run for this sanitation snapshot. An existing assertion in tests/test_router.mjs:130 refers to a hint phrase absent from the sanitized hint text; it remains unverified and was not repaired.

## Limitations

This is an experimental as-is snapshot. Bugs, outdated assumptions, and unfinished integrations may remain. Runtime behavior, current OpenClaw compatibility, and install steps are unverified. Route labels are advisory; connect them to the background and durable-work workflows used by your installation before relying on them.
