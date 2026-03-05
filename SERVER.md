# WebSocket TTS Server — Extension Interface Spec

This document describes the server interface the SillyTavern extension expects.
Any TTS backend that implements these two endpoints will work — the model is your choice.

Reference implementation: [`andimarafioti/faster-qwen3-tts`](https://github.com/andimarafioti/faster-qwen3-tts) (`demo/server.py`).  
Other options: XTTS, Piper, Kokoro, Orpheus, any custom server.

---

## Quick Start

Example using faster-qwen3-tts:

```bash
python demo/server.py \
  --model Qwen/Qwen3-TTS-12Hz-1.7B-Base \
  --host 0.0.0.0 \
  --port 7860
```

For lighter hardware:

```bash
python demo/server.py \
  --model Qwen/Qwen3-TTS-12Hz-0.6B-Base \
  --host 0.0.0.0 \
  --port 7860
```

The extension connects via **HTTP** (for `/speakers`) and **WebSocket** (for TTS generation).  
No HTTPS is required — the Web Audio API `decodeAudioData` path used by this extension works over plain `ws://`.  
Any server that speaks this protocol is compatible, regardless of the underlying TTS model.

---

## Endpoints

### `GET /speakers`

Returns the list of available voice IDs.  
The extension calls this on load and when the user clicks **"↻ Refresh"** in the TTS panel.

**Response — any of these formats are accepted:**

```json
["Clone 1", "Clone 2", "Alice"]
```

```json
[{"name": "Clone 1"}, {"name": "Alice"}]
```

```json
{"Clone 1": "path/to/ref.wav", "Alice": "path/to/alice.wav"}
```

| Field | Notes |
|---|---|
| Voice identifier must be stable | It is stored in ST's per-character voice map |
| Empty array `[]` is valid | Extension will still work; voices shown as "No voices found" |

---

### `WS /ws/tts` — Real-Time Streaming (main endpoint)

A **persistent WebSocket connection** per generation.  
The extension opens one connection per LLM response and closes it when the server sends `[DONE]`.

**Request URL (query parameters — both optional):**

```
ws://192.168.1.100:7860/ws/tts?speaker_wav=Clone+1&language=en
```

| Param | Type | Default | Description |
|---|---|---|---|
| `speaker_wav` | string | server default | Voice ID (must match a value from `/speakers`) |
| `language` | string | `en` | BCP-47 language code (`en`, `zh`, `ja`, `ko`, `fr`, `de`, `es`, `ru`, `ar`, `hi`, `pt`, `it`) |

**Client → Server messages (after connection is open):**

| Message | Type | Description |
|---|---|---|
| Text chunk | `string` | One or more tokens / characters from the LLM stream. May be partial words. Sent incrementally. |
| `[END]` | `string` (literal) | Signals end of input. Server must flush any buffered text, finish synthesis, then close. |

**Server → Client messages:**

| Message | Type | Description |
|---|---|---|
| WAV binary | `ArrayBuffer` | A **complete**, standalone WAV file for one synthesised sentence. May arrive multiple times — one per sentence boundary detected. |
| `[DONE]` | `string` (literal) | All audio has been sent. Extension closes the connection. |

**Expected server behaviour:**

1. Buffer incoming text tokens.
2. When a sentence boundary is detected (`.` `!` `?` `…` `。` `！` `？` or similar), synthesise that sentence immediately.
3. Send the resulting WAV as a binary WebSocket message.
4. On `[END]`: synthesise any remaining buffered text, send its WAV, then send `[DONE]` and close.
5. Do **not** send `[DONE]` before all WAV messages for a session are sent.

**Example session:**

```
Client → "Hello, how are"
Client → " you doing today?"
Client → " I hope you are well."
Client → "[END]"

Server → <binary WAV: "Hello, how are you doing today?">
Server → <binary WAV: "I hope you are well.">
Server → "[DONE]"
```

---

### `GET /languages` *(optional)*

Returns the list of languages supported by this server/model.  
If this endpoint is absent (returns 404 or connection error), the extension silently falls back to its built-in list of 12 languages.

**Response — any of these formats are accepted:**

```json
["en", "zh", "ja", "ko"]
```

```json
[{"code": "en", "name": "English"}, {"code": "zh", "name": "Chinese"}]
```

```json
{"en": "English", "zh": "Chinese", "ja": "Japanese"}
```

Language codes are passed as the `language` query parameter on `WS /ws/tts` connections.

---

### Narrate / message replay

For non-streaming use (Narrate button, message replay), the extension opens a **separate** dedicated WebSocket connection per request, sends the **full text** at once followed by `[END]`, waits for all WAV chunks plus `[DONE]`, then reassembles them into a single WAV blob for ST's audio system.

This is the same `/ws/tts` endpoint — no separate HTTP TTS endpoint is required.

---

## Server Response Timing Requirements

| Requirement | Why |
|---|---|
| **First WAV within ~3 s of connection** | Perceived latency — delay before the first sentence is spoken |
| **Each WAV ≤ 15 s of audio** | Very long sentences should be split server-side |
| **`[DONE]` sent after last WAV** | Extension waits for `[DONE]` before closing the socket |
| **60 s total timeout** | Extension force-closes if no `[DONE]` in 60 s (safety net) |

---

## Authentication

No authentication is implemented.  
The server is expected to run on a local/LAN network.  
If you need auth, proxy the WebSocket behind nginx with `auth_basic` or a token-bearing connect URL.

---

## CORS / Origin

The connection originates from the browser running SillyTavern.  
If the server runs on a different host/port, ensure it does not reject WebSocket upgrades from the ST origin.  
`faster-qwen3-tts` uses Starlette/FastAPI which allows all origins by default when `CORSMiddleware` is added.

---

## Summary of Required Endpoints

| Endpoint | Protocol | Required | Used for |
|---|---|---|---|
| `GET /speakers` | HTTP | ✅ Yes | Populate voice dropdown; called on load and refresh |
| `WS /ws/tts` | WebSocket | ✅ Yes | Real-time streaming TTS + Narrate / replay |
| `GET /languages` | HTTP | ❌ Optional | Populate language dropdown dynamically |

No other endpoints are used.
