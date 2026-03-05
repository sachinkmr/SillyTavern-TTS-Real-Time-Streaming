# SillyTavern — Qwen3 TTS Real-Time Streaming

A SillyTavern extension that **registers as a proper TTS provider** — giving you the Narrate button, per-character voice map, and voice preview — with a bonus real-time streaming mode that speaks each sentence **as the LLM generates it**, instead of waiting for the full reply.

Powered by the [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts) local server via a WebSocket pipeline.

---

## How it works

```
LLM token stream → WebSocket /ws/tts → Qwen3-TTS generates per sentence → WAV audio in browser
```

**Real-time streaming mode:**
1. When ST starts an LLM reply, the extension opens a WebSocket to your Qwen3-TTS server.
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
| [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts) server | Needs `GET /speakers` and `WS /ws/tts` — see [SERVER.md](SERVER.md) |
| SillyTavern (recent release) | Tested on release branch |
| CUDA GPU recommended | For real-time generation speed; CPU works but adds latency |

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
2. In the **Provider** dropdown, select **"Qwen3 TTS (Streaming)"**.
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
- Try the lighter model `Qwen3-TTS-12Hz-0.6B-Base` for lower latency.

**Narrate button plays silence**
- If you clicked Narrate within 8 s of a streamed reply, the dedup window suppressed it. Wait 8 s and try again.

---

## Server API

See **[SERVER.md](SERVER.md)** for full endpoint documentation, request/response formats, and timing requirements.

---

## Files

```
SillyTavern-TTS-Real-Time-Streaming/
├── manifest.json   Extension metadata (v1.3.0)
├── index.js        Provider class + real-time streaming logic
├── README.md       This file
└── SERVER.md       Server endpoint API reference
```


A SillyTavern extension that speaks each sentence **as the LLM generates it**, instead of waiting for the full reply to finish.

Powered by the [qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts) local server via a WebSocket pipeline.

---

## How it works

```
LLM token stream  →  WebSocket /ws/tts  →  Qwen3-TTS generates sentence  →  WAV audio scheduled in browser
```

1. When ST starts streaming an LLM reply, this extension opens a WebSocket to your local Qwen3-TTS server.
2. Each token is forwarded as it arrives.
3. The server buffers tokens, detects sentence boundaries (`.`, `!`, `?`, …), and generates audio for each complete sentence.
4. Each finished sentence is sent back as a WAV binary message and played immediately via the Web Audio API.
5. When the LLM finishes, `[END]` is sent to flush any remaining text.

**Result:** The first sentence starts playing roughly 1–3 seconds after the LLM begins typing — no waiting for the full response.

---

## Prerequisites

| Requirement | Notes |
|---|---|
| [faster-qwen3-tts](https://github.com/andimarafioti/faster-qwen3-tts) server running | Needs the modified `demo/server.py` with the `/ws/tts` WebSocket endpoint |
| SillyTavern (any recent release) | Tested on release branch |
| CUDA GPU | For real-time generation speed |

---

## Installation

### 1. Copy the extension into SillyTavern

The extension folder must be placed inside ST's `third-party` extensions directory.

**If ST is running in Docker on a remote server:**

From Windows (PowerShell):
```powershell
# Copy the folder to the remote server first
scp -r "S:\Workspace\Projects\SillyTavern-TTS-Real-Time-Streaming" user@192.168.1.x:~/qwen-tts-streaming

# Then copy into the Docker container
ssh user@192.168.1.x "docker cp ~/qwen-tts-streaming <container_name>:/app/public/scripts/extensions/third-party/qwen-tts-streaming"
```

**If ST is running locally:**
```
copy S:\Workspace\Projects\SillyTavern-TTS-Real-Time-Streaming
  → <SillyTavern>/public/scripts/extensions/third-party/qwen-tts-streaming
```

### 2. Reload SillyTavern

Hard-refresh the browser (`Ctrl+Shift+R`). The extension will appear in the **Extensions** panel.

---

## Configuration

Open the **Extensions** panel in ST and find **"Qwen TTS — Real-Time Streaming"**.

| Setting | Description | Example |
|---|---|---|
| **Enable** | Master on/off switch | ✅ |
| **WebSocket Endpoint** | URL of the `/ws/tts` route on your TTS server | `ws://192.168.1.100:7860/ws/tts` |
| **Speaker / Voice ID** | Name or ID of the voice preset to use | `Clone 1`, `custom_Alice`, or blank for default |
| **Language** | Two-letter language code | `en`, `ja`, `zh` |
| **Volume** | Playback volume (0.0 – 2.0) | `1.0` |

Click **▶ Test Voice** to verify the connection and hear the selected voice before chatting.

---

## Disabling other TTS providers

This extension handles audio playback directly. If another TTS provider (e.g. **tts-webui**) is also active, you will get **double audio** — once from this extension (real-time) and once from tts-webui (after generation finishes).

**Disable tts-webui** (or any other TTS provider) while using this extension:
- In the Extensions panel → **TTS** → uncheck **Enabled**, or select **"None"** as the provider.

---

## Comparison with tts-webui extension

| | tts-webui | This extension |
|---|---|---|
| When TTS starts | After LLM finishes | As LLM types (per sentence) |
| Latency to first word | Full generation time | ~1–3 s after LLM starts |
| Protocol | HTTP POST `/v1/audio/speech` | WebSocket `/ws/tts` |
| Audio playback | AudioWorklet (requires HTTPS) | `AudioContext.decodeAudioData` (works over HTTP) |
| HTTPS required | Yes (AudioWorklet) | No |
| Streaming format | WAV header + raw PCM16 chunks | Complete WAV per sentence |

---

## Troubleshooting

**"Connection failed" in the Test button**
- Confirm the TTS server is running: `netstat -ano | findstr :7860`
- Check the WebSocket URL — must start with `ws://` (or `wss://` if behind HTTPS)
- If ST is on a different machine, ensure port 7860 is accessible on the TTS server host

**Audio plays but voice is wrong / no voice**
- Enter a valid voice name in **Speaker / Voice ID** — must match a label in `/speakers` on the server
- Leave blank to use the server's default voice design mode

**First sentence is cut off**
- The server needs a sentence-ending character (`.`, `!`, `?`) before it flushes
- Very short first sentences may be buffered with the second — this is normal

**Double audio playing**
- Another TTS provider is active — disable it as described above

**Audio sounds choppy**
- The GPU may not be fast enough for real-time generation
- Try a smaller model: `Qwen/Qwen3-TTS-12Hz-0.6B-Base` instead of `1.7B-Base`

---

## Server-side setup (quick reference)

Start the Qwen3-TTS server with LAN access:
```powershell
python demo/server.py --model Qwen/Qwen3-TTS-12Hz-1.7B-Base --host 0.0.0.0 --port 7860
```

The `/ws/tts` endpoint accepts:
- Query params: `?speaker_wav=Clone+1&language=en`
- Text chunks as plain string WebSocket messages
- `[END]` to flush and close
- Returns binary WAV messages per sentence, then `[DONE]`

---

## Files

```
qwen-tts-streaming/
├── manifest.json   Extension metadata
├── index.js        Main extension logic
├── style.css       Settings panel styles
└── README.md       This file
```
