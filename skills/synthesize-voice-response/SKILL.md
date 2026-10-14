---
name: synthesize-voice-response
description: "Reply should be spoken (the user asked for voice, sent a voice note, is driving) or an audio file must go out as a Telegram voice note."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔊",
      },
  }
---

# Replying with voice

## When to speak

Speak when:

- the user **asks** for voice ("say it", "voice me", "read that out").
- The user **sent a voice note** and the conversation is running in voice — match the medium they chose.
- There is a **standing preference** for voice in this chat (`/tts chat on`, or auto-TTS set to
  `inbound`).
- The user is plainly hands-busy — driving, walking, or asks to "just tell me".

Do **not** speak when:

- The answer is a **list, a table, code, a path, a URL, or numbers the user needs to copy.** Voice
  destroys all of those. Send text; offer voice on top if it helps.
- The reply is one word, or under ~10 characters — auto-TTS skips it anyway.
- It is a **long** explanation. Voice is for short answers. If it needs 400 words, send text.
- You are already attaching structured media — the payload will not carry audio too.

Default is text. Voice is a deliberate choice, not a flourish.

## How to speak — the `tts` tool

```
tts { text: "<what to say>" }
```

That is the whole thing. The audio is **auto-delivered** to the current channel as a voice note.

**Do not also send the same text as a message.** The tool already returns the spoken content to the
conversation as `(spoken) …`; sending it again gives the user the same answer twice. Optional params:
`channel` (to target a different one) and `timeoutMs`.

Use the configured text-to-speech provider and voice. Check the runtime output metadata to confirm whether the result is compatible with the channel's native voice-note format; use the configured fallback provider if the primary route fails.

## Writing text that sounds right spoken

- **Keep it under ~1500 characters.** Above the local `maxLength` OpenClaw summarises it with the
  summary model before speaking — an extra model call and a paraphrase you did not write. Write short
  and keep control of the words.
- **Strip markdown.** No `**`, no backticks, no bullet characters, no headings. They get read aloud
  or mangled.
- **One idea per sentence.** Short sentences. Spoken commas, not nested clauses.
- **Expand abbreviations or symbols that may sound awkward aloud.** Say "nine a.m." rather than "9am" and
  "dollars" rather than "$". Read URLs and long IDs only if the user asks; otherwise send them as text.
- No emoji. They are either silent or read out literally.

## Sending an audio file you already have

For a pre-made file (a converted recording or generated clip), use the message tool rather than tts. Set WORK_DIR to a temporary or media directory that contains the output file. For example:

```bash
WORK_DIR="${TMPDIR:-/tmp}/voice-work"
mkdir -p "$WORK_DIR"
```

Then use the message tool:

```
message { action: "send", media: "$WORK_DIR/reply.ogg", asVoice: true }
```

`asVoice` (aliases `audioAsVoice`, `as_voice`) only produces a real voice note if the audio passes
Telegram's compatibility check: MIME in `audio/ogg`, `audio/opus`, `audio/mpeg`, `audio/mp3`,
`audio/mp4`, `audio/x-m4a`, `audio/m4a`, **or** extension in `.oga .ogg .opus .mp3 .m4a`.

The file must live under a runtime-configured allowed root, such as the designated temporary or media workspace directory.

## If it downgrades to a file attachment

The tell is a log line: *"Telegram voice requested but media is `<mime>` (`<file>`); sending as audio
file instead."* The output format did not meet the channel's voice-note requirements; use a supported audio format.

Fix it, don't ship it:

```bash
ffmpeg -y -i <in> -c:a libopus -b:a 32k -ar 48000 -ac 1 -f ogg "$WORK_DIR/reply.ogg"
```

then re-send with `asVoice: true`. Verify with `ffprobe -v error -show_format <out>` that the
container is `ogg` and the codec is `opus` before sending.

If the configured primary path fails, use the configured fallback provider rather than dropping to silence — and say in text that you switched voices so a different-sounding reply is not a surprise.

## Session controls worth knowing

`/tts on|off|status`, `/tts chat on|off|default` (this chat only), `/tts latest` (re-speak the last
reply once), `/tts provider <id>`, `/tts limit <100-4096>`, `/tts audio <text>`.

**Trap:** A bare `/tts on` may write a host-level preference that overrides configuration for every agent and channel. Prefer `/tts chat on` for a
conversation-scoped change, and leave the durable default to config.
