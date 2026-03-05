# SillyTavern — WebSocket TTS Real-Time Streaming

A SillyTavern extension that **registers as a proper TTS provider** — giving you the Narrate button, per-character voice map, and voice preview — with a bonus real-time streaming mode that speaks each sentence **as the LLM generates it**, instead of waiting for the full reply.

Works with **any TTS server** that implements the simple WebSocket interface described in [SERVER.md](SERVER.md). The reference server implementation is [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts), but you can use any model (XTTS, Piper, Kokoro, Orpheus, custom, …).

---

## How it works

```
LLM token stream → WebSocket /ws/tts → TTS server generates per sentence → WAV audio in browser
```

**Real-time streaming mode:**
1. When ST starts an LLM reply, the extension opens a WebSocket to your TTS server.
2. Each token is forwarded incrementally.
3. The server buffers tokens, detects sentence boundaries, and generates audio per sentence.
4. Each WAV is scheduled and played immediately via the Web Audio API.
5. `[END]` is sent when the LLM finishes to flush any remaining text.

**Result:** The first sentence starts playing ~1–3 s after the LLM begins typing.

**Narrate / message replay:**  
The extension also handles the Narrate button and per-message audio replay by collecting the full audio over the same WebSocket and returning it to ST's audio system — same endpoint, no extra server work needed.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| A TTS server implementing `GET /speakers` + `WS /ws/tts` | See [SERVER.md](SERVER.md) for the interface spec. Reference: [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts) |
| SillyTavern (recent release) | Tested on release branch |
| GPU recommended | For real-time generation speed; CPU works but adds latency |

---

## Installation

Copy the extension folder into ST's `third-party` extensions directory:

```
<SillyTavern>/public/scripts/extensions/third-party/SillyTavern-TTS-Real-Time-Streaming/
```

**Docker (volume-mounted):** if ST uses a volume mount for `third-party`, drop the folder there and hard-refresh.

Hard-refresh the browser (`Ctrl+Shift+R`). The extension loads automatically.

---

## Configuration

1. Open **Extensions** panel → **TTS** (the headphone icon).
2. In the **Provider** dropdown, select **"WS TTS (Streaming)"**.
3. The provider settings panel appears:

| Setting | Description | Example |
|---|---|---|
| **Provider Endpoint** | WebSocket URL of your server's `/ws/tts` route | `ws://192.168.1.100:7860/ws/tts` |
| **Language** | Language for synthesis | `English`, `Japanese`, … |
| **Volume** | Playback volume (0.0 – 2.0) | `1.0` |
| **Real-time Streaming** | Speak while typing (vs. wait for Narrate) | ✅ |

4. Click **↻ Refresh** in the TTS panel to load available voices from the server.
5. Assign voices to characters in the **Voice Map** section (ST-managed, per character).
6. Click the **🔊 preview** icon next to any voice to test it.

### Real-time Streaming + Auto-read aloud

If **Real-time Streaming** is enabled:
- The extension plays audio during generation.
- When generation ends, ST's **Auto-read aloud** would play it a second time.
- To avoid double-playback: go to **TTS → Settings → uncheck "Auto-read aloud"**, OR rely only on the Narrate button for past messages (the extension auto-suppresses double-play for the most recent message).

---

## Comparison with other TTS extensions

| | XTTSv2 (built-in) | tts-webui | **This extension** |
|---|---|---|---|
| When TTS starts | After LLM finishes | After LLM finishes | **As LLM types (per sentence)** |
| Latency to first word | Full generation time | Full generation time | **~1–3 s after LLM starts** |
| Protocol | HTTP GET streaming | HTTP POST | **WebSocket** |
| Narrate button | ✅ | ✅ | ✅ |
| Per-character voice map | ✅ | ✅ | ✅ |
| Voice preview | ✅ | ✅ | ✅ |
| HTTPS required | No | Yes (AudioWorklet) | **No** |

---

## Troubleshooting

**Provider doesn't appear in the TTS dropdown**
- Hard-refresh (`Ctrl+Shift+R`) — the JS module must fully load before the provider registers.
- Check browser console for errors (`F12`).

**"Refresh" shows no voices**
- Confirm the server is reachable: `curl http://192.168.1.100:7860/speakers`
- Ensure the URL in Provider Endpoint is correct (the `/ws/tts` path; the extension strips it to reach `/speakers`).

**Double audio**
- Disable **Auto-read aloud** in TTS settings, or rely on the 8-second dedup window.

**First sentence is slow / cut off**
- The server needs a sentence-ending character before it flushes. Very short openers are normal.
- If using Qwen3-TTS, try the lighter `Qwen3-TTS-12Hz-0.6B-Base` model for lower latency.

**Narrate button plays silence**
- If you clicked Narrate within 8 s of a streamed reply, the dedup window suppressed it. Wait 8 s and try again.

---

## Server API

See **[SERVER.md](SERVER.md)** for full endpoint documentation, request/response formats, and timing requirements.

---

## Files

```
SillyTavern-TTS-Real-Time-Streaming/
├── manifest.json   Extension metadata (v1.4.0)
├── index.js        Provider class + real-time streaming logic
├── README.md       This file
└── SERVER.md       Server interface specification
```

