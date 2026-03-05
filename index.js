/**
 * WebSocket TTS — Real-Time Streaming  (v1.5.1)
 * SillyTavern Extension
 *
 * Registers as a proper ST TTS provider — gives the Narrate button,
 * per-character voice map, enable/disable toggle, and voice preview
 * automatically (same as XTTSv2 / tts-webui).
 *
 * Works with any TTS server that exposes GET /speakers and WS /ws/tts.
 * See SERVER.md for the required server interface.
 *
 * BONUS: Real-time streaming mode speaks each sentence the moment it is
 * generated, without waiting for the full reply to finish.
 *
 * Install: copy folder to SillyTavern/public/scripts/extensions/third-party/
 *          Enable in Extensions, then select "WS TTS (Streaming)" in TTS panel.
 * Note: If Real-time Streaming is ON, disable "Auto-read aloud" in TTS settings
 *       to avoid double-playback after generation completes.
 */

// ── Module-level streaming state ──────────────────────────────────────────────

const EXT_NAME = 'WS TTS (Streaming)';

let ws               = null;
let audioCtx         = null;
let gainNode         = null;
let nextStartTime    = 0;
let lastSentLength   = 0;
let isGenerating     = false;
let streamPlayedAt   = 0;   // timestamp of last streaming session end (for dedup)
let currentProvider  = null;

// Populated after dynamic import of ST's TTS index
let _saveTtsProviderSettings = () => {};
let _getPreviewString        = () => 'Hello, this is a test of the text to speech voice.';

// ── Audio helpers ─────────────────────────────────────────────────────────────

function ensureAudioContext() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx     = new (window.AudioContext || window.webkitAudioContext)();
        gainNode     = audioCtx.createGain();
        gainNode.gain.value = currentProvider?.settings?.volume ?? 1.0;
        gainNode.connect(audioCtx.destination);
        nextStartTime = audioCtx.currentTime;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function scheduleAudioChunk(arrayBuffer) {
    ensureAudioContext();
    const ctx  = audioCtx;
    const gain = gainNode;
    ctx.decodeAudioData(
        arrayBuffer.slice(0),
        (decoded) => {
            if (ctx.state === 'closed') return;
            const src = ctx.createBufferSource();
            src.buffer  = decoded;
            src.connect(gain);
            const startAt   = Math.max(ctx.currentTime + 0.02, nextStartTime);
            src.start(startAt);
            nextStartTime   = startAt + decoded.duration;
        },
        (err) => console.warn(`[${EXT_NAME}] Decode error:`, err),
    );
}

function stopAudio() {
    if (audioCtx && audioCtx.state !== 'closed') { audioCtx.close(); }
    audioCtx  = null;
    gainNode  = null;
    nextStartTime = 0;
}

// ── Streaming WebSocket ───────────────────────────────────────────────────────

function openStreamWs(voiceId = null) {
    if (!currentProvider) return;
    if (ws && ws.readyState === WebSocket.OPEN) return;
    closeStreamWs();

    const url = currentProvider.buildWsUrl(voiceId);
    console.info(`[${EXT_NAME}] Streaming → ${url}`);

    ws              = new WebSocket(url);
    ws.binaryType   = 'arraybuffer';
    ws.onopen   = () => console.info(`[${EXT_NAME}] WS connected`);
    ws.onmessage = (ev) => {
        if (ev.data instanceof ArrayBuffer) scheduleAudioChunk(ev.data);
        else if (ev.data === '[DONE]') closeStreamWs();
    };
    ws.onerror  = (err) => console.error(`[${EXT_NAME}] WS error:`, err);
    ws.onclose  = (ev) => { console.info(`[${EXT_NAME}] WS closed (${ev.code})`); ws = null; };
}

function closeStreamWs(sendEnd = false) {
    if (!ws) return;
    const socket = ws;
    ws = null;
    if (sendEnd && socket.readyState === WebSocket.OPEN) {
        socket.send('[END]');
        setTimeout(() => { if (socket.readyState !== WebSocket.CLOSED) socket.close(); }, 10_000);
    } else if (socket.readyState <= WebSocket.OPEN) { // CONNECTING or OPEN
        socket.close();
    }
}

// ── ST event hooks (real-time streaming) ─────────────────────────────────────

function onGenerationStarted() {
    if (!currentProvider?.settings?.streaming) return;

    isGenerating   = true;
    lastSentLength = 0;
    streamPlayedAt = 0;
    stopAudio();
    ensureAudioContext();

    // Resolve per-character voice from ST's TTS voice map
    let voiceId = null;
    try {
        const ctx      = SillyTavern.getContext();
        const charName = ctx.name2;
        const voiceMap = ctx.extensionSettings?.tts?.voiceMap ?? {};
        if (charName && voiceMap[charName]) voiceId = voiceMap[charName];
    } catch (e) { console.warn(`[${EXT_NAME}] voiceMap error:`, e); }

    openStreamWs(voiceId);
}

function onStreamToken(text) {
    if (!currentProvider?.settings?.streaming) return;
    if (!isGenerating || typeof text !== 'string') return;

    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        console.warn(`[${EXT_NAME}] WS dropped — reconnecting`);
        openStreamWs();
    }
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const delta = text.slice(lastSentLength);
    if (!delta.length) return;
    lastSentLength = text.length;
    ws.send(delta);
}

function onGenerationEnded() {
    if (!currentProvider?.settings?.streaming) return;
    isGenerating  = false;
    streamPlayedAt = Date.now();
    closeStreamWs(true);
}

function onGenerationStopped() {
    if (!currentProvider?.settings?.streaming) return;
    isGenerating  = false;
    streamPlayedAt = Date.now();
    closeStreamWs(true);
}

// ── Minimal silent WAV (44 header + 1 silent sample) ─────────────────────────

function silentWav() {
    const b = new ArrayBuffer(46), v = new DataView(b);
    const w = (s, o) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w('RIFF', 0); v.setUint32(4, 38, true); w('WAVE', 8);
    w('fmt ', 12); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, 1, true); v.setUint32(24, 22050, true); v.setUint32(28, 44100, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w('data', 36); v.setUint32(40, 2, true); v.setInt16(44, 0, true);
    return b;
}

/**
 * Encode a Float32 mono PCM array as a 16-bit PCM WAV ArrayBuffer.
 * Used to merge multiple per-sentence WAV chunks into one playable blob.
 */
function _encodeWav(samples, sampleRate) {
    const buf  = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buf);
    const ws   = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    ws(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true);
    ws(8, 'WAVE'); ws(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);             // PCM
    view.setUint16(22, 1, true);             // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byteRate
    view.setUint16(32, 2, true);             // blockAlign
    view.setUint16(34, 16, true);            // bitsPerSample
    ws(36, 'data'); view.setUint32(40, samples.length * 2, true);
    for (let i = 0; i < samples.length; i++)
        view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, samples[i])) * 0x7FFF, true);
    return buf;
}

// ── Provider class ─────────────────────────────────────────────────────────────

class WsTtsStreamingProvider {

    settings = {};
    voices   = [];

    constructor() {
        // ST instantiates the provider class itself; keep module-level ref for streaming hooks.
        currentProvider = this;
    }

    defaultSettings = {
        provider_endpoint : 'ws://192.168.1.100:7860/ws/tts',
        language          : 'en',
        streaming         : true,
        volume            : 1.0,
    };

    languageLabels = {
        en: 'English', zh: 'Chinese', ja: 'Japanese', ko: 'Korean',
        fr: 'French',  de: 'German',  es: 'Spanish',  ru: 'Russian',
        ar: 'Arabic',  hi: 'Hindi',   pt: 'Portuguese', it: 'Italian',
    };

    // ── settingsHtml ──────────────────────────────────────────────────────────
    // ST renders this inside the TTS provider panel when this provider is active.
    // Uses defaultSettings values (loadSettings will update the DOM afterwards).
    get settingsHtml() {
        const s = this.defaultSettings;
        const langOptions = Object.entries(this.languageLabels)
            .map(([code, label]) =>
                `<option value="${code}"${code === s.language ? ' selected' : ''}>${label}</option>`)
            .join('\n                ');

        return `
<div id="wts_provider_settings">
    <div class="flex gap10px marginBot10 alignItemsFlexEnd">
        <div class="flex1 flexFlowColumn">
            <label for="wts_endpoint">Provider Endpoint (ws:// or wss://):</label>
            <input id="wts_endpoint" type="text" class="text_pole" maxlength="300"
                   value="${s.provider_endpoint}"
                   placeholder="ws://192.168.1.100:7860/ws/tts" />
        </div>
    </div>

    <div class="flex gap10px marginBot10">
        <div class="flex1 flexFlowColumn">
            <label for="wts_language">Language:</label>
            <select id="wts_language" class="text_pole">
                ${langOptions}
            </select>
        </div>
        <div class="flex1 flexFlowColumn">
            <label for="wts_volume">
                Volume: <span id="wts_volume_label">${s.volume.toFixed(2)}</span>
            </label>
            <input id="wts_volume" type="range" min="0" max="2" step="0.05"
                   value="${s.volume}" style="width:100%;margin-top:6px" />
        </div>
    </div>

    <div class="marginBot10">
        <label class="checkbox_label">
            <input id="wts_streaming" type="checkbox" ${s.streaming ? 'checked' : ''} />
            <span>Real-time Streaming
                <small style="color:#aaa;display:block;margin-top:2px">
                    Speaks each sentence as the LLM generates it.
                    If enabled, disable <em>Auto-read aloud</em> below to avoid double-playback.
                </small>
            </span>
        </label>
    </div>
</div>`;
    }

    // ── loadSettings ──────────────────────────────────────────────────────────
    // Called by ST when this provider is selected / settings are loaded.
    async loadSettings(settings) {
        this.settings = Object.assign({}, this.defaultSettings, settings ?? {});

        // Update DOM with saved values
        $('#wts_endpoint').val(this.settings.provider_endpoint);
        $('#wts_language').val(this.settings.language);
        $('#wts_volume').val(this.settings.volume);
        $('#wts_volume_label').text(Number(this.settings.volume).toFixed(2));
        $('#wts_streaming').prop('checked', this.settings.streaming);

        // Bind change handlers (off() first to prevent stacking)
        $('#wts_endpoint').off('change').on('change', () => {
            this.settings.provider_endpoint = $('#wts_endpoint').val().trim();
            _saveTtsProviderSettings();
        });
        $('#wts_language').off('change').on('change', () => {
            this.settings.language = $('#wts_language').val();
            _saveTtsProviderSettings();
        });
        $('#wts_volume').off('input').on('input', (e) => {
            const v = parseFloat(e.target.value);
            this.settings.volume = v;
            $('#wts_volume_label').text(v.toFixed(2));
            if (gainNode) gainNode.gain.value = v;
            _saveTtsProviderSettings();
        });
        $('#wts_streaming').off('change').on('change', () => {
            this.settings.streaming = $('#wts_streaming').is(':checked');
            _saveTtsProviderSettings();
        });

        await this.checkReady();
    }

    // ── URL helpers ───────────────────────────────────────────────────────────

    wsToHttpBase() {
        return (this.settings.provider_endpoint || this.defaultSettings.provider_endpoint)
            .replace(/^wss:\/\//, 'https://')
            .replace(/^ws:\/\//, 'http://')
            .replace(/\/ws\/.*$/,  '')
            .replace(/\/+$/, '');
    }

    buildWsUrl(voiceId = null) {
        const base   = (this.settings.provider_endpoint || this.defaultSettings.provider_endpoint)
            .replace(/\/+$/, '');
        const params = new URLSearchParams();
        if (voiceId)                    params.set('speaker_wav', voiceId);
        if (this.settings.language)     params.set('language', this.settings.language);
        const qs = params.toString();
        return qs ? `${base}?${qs}` : base;
    }

    // ── TTS provider interface ────────────────────────────────────────────────

    async fetchTtsVoiceObjects() {
        const base = this.wsToHttpBase();
        if (!base) return [];
        const resp = await fetch(`${base}/speakers`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${base}/speakers`);
        const data = await resp.json();
        const toObj = (v) => typeof v === 'string'
            ? { name: v, voice_id: v }
            : { name: v.name ?? v.id ?? String(v), voice_id: v.name ?? v.id ?? String(v) };
        this.voices = Array.isArray(data)
            ? data.map(toObj)
            : Object.keys(data).map(k => ({ name: k, voice_id: k }));
        return this.voices;
    }

    async getVoice(voiceName) {
        if (!this.voices.length) {
            try { await this.fetchTtsVoiceObjects(); } catch { /**/ }
        }
        const found = this.voices.find(v => v.name === voiceName || v.voice_id === voiceName);
        if (!found) throw new Error(`Voice "${voiceName}" not found — check Provider Endpoint.`);
        return found;
    }

    async checkReady() {
        try { await this.fetchTtsVoiceObjects(); } catch { /* offline is OK at load time */ }
        try { await this.fetchTtsLanguages(); }   catch { /* optional endpoint */ }
    }

    async onRefreshClick() {
        await this.fetchTtsVoiceObjects();
        try { await this.fetchTtsLanguages(); } catch { /**/ }
    }

    /**
     * Optionally fetch supported languages from GET /languages.
     * Falls back silently to the hardcoded languageLabels list if the
     * endpoint does not exist (404) or the server is unreachable.
     *
     * Accepted response formats:
     *   ["en", "zh", "ja"]                                  ← code array
     *   [{"code": "en", "name": "English"}, ...]            ← object array
     *   {"en": "English", "zh": "Chinese", ...}             ← code→name map
     */
    async fetchTtsLanguages() {
        const base = this.wsToHttpBase();
        if (!base) return;
        let resp;
        try { resp = await fetch(`${base}/languages`); } catch { return; }
        if (!resp.ok) return;   // 404 — endpoint not implemented, keep hardcoded list

        const data = await resp.json();
        let langs;
        if (Array.isArray(data)) {
            langs = data.map(v => typeof v === 'string'
                ? { code: v, name: this.languageLabels[v] ?? v }
                : { code: v.code ?? v.id ?? String(v), name: v.name ?? v.label ?? v.code ?? String(v) });
        } else {
            langs = Object.entries(data).map(([code, val]) => ({
                code,
                name: typeof val === 'string' ? val : (this.languageLabels[code] ?? code),
            }));
        }
        if (langs.length) this._buildLanguageSelect(langs);
    }

    /** Rebuild the language <select> from a dynamic list. */
    _buildLanguageSelect(langs) {
        const $sel = $('#wts_language');
        if (!$sel.length) return;
        const current = this.settings.language || this.defaultSettings.language;
        $sel.empty();
        for (const { code, name } of langs) {
            $sel.append($('<option>').val(code).text(name).prop('selected', code === current));
        }
    }

    /**
     * Preview a voice — collect full audio from WS and play via Audio element.
     * Using Audio element here (not our AudioContext streaming pipeline) so it
     * doesn't interfere with ongoing generation audio.
     */
    async previewTtsVoice(voiceId) {
        const text = _getPreviewString(this.settings.language);
        const blob = await this._collectWsAudio(text, voiceId);
        const url  = URL.createObjectURL(blob);
        const audio = new Audio(url);
        audio.volume = Math.min(1, this.settings.volume);
        audio.onended = () => URL.revokeObjectURL(url);
        audio.play().catch(e => console.warn(`[${EXT_NAME}] Preview play error:`, e));
    }

    /**
     * Generate TTS for the given text.  Returns a fetch Response containing WAV audio.
     * ST uses this for: Narrate button, Auto-read aloud, message replay.
     *
     * When Real-time Streaming just played this message (within the last 8 s),
     * return a silent WAV so auto-read-aloud does not double-play the same audio.
     * The Narrate button on past messages always works because the 8 s window will
     * have long expired by the time the user clicks it.
     */
    async generateTts(text, voiceId) {
        if (this.settings.streaming && Date.now() - streamPlayedAt < 8_000) {
            return new Response(silentWav(), { headers: { 'Content-Type': 'audio/wav' } });
        }
        const blob = await this._collectWsAudio(text, voiceId);
        return new Response(blob, { headers: { 'Content-Type': 'audio/wav' } });
    }

    /**
     * Open a dedicated WS connection, send text + [END], collect all WAV chunks,
     * decode each one via AudioContext, merge the PCM samples, and resolve with
     * a single well-formed WAV Blob.
     *
     * The server sends one WAV file per sentence.  Naively byte-concatenating
     * multiple WAV files produces a blob with multiple RIFF headers — browsers
     * only decode up to the first one, so only the first sentence would play.
     * Decoding + re-encoding ensures the full reply is audible.
     */
    _collectWsAudio(text, voiceId = null) {
        return new Promise((resolve, reject) => {
            const decodePromises = [];
            const socket  = new WebSocket(this.buildWsUrl(voiceId));
            socket.binaryType = 'arraybuffer';

            const timer = setTimeout(() => {
                socket.close();
                reject(new Error(`[${EXT_NAME}] generateTts timeout`));
            }, 60_000);

            socket.onopen    = () => { socket.send(text); socket.send('[END]'); };
            socket.onmessage = (ev) => {
                if (ev.data instanceof ArrayBuffer) {
                    // Decode each WAV chunk into PCM now — the close handler
                    // awaits all promises before merging.
                    const ctx = new (window.AudioContext || window.webkitAudioContext)();
                    decodePromises.push(
                        ctx.decodeAudioData(ev.data.slice(0))
                            .then(buf  => { ctx.close(); return buf; })
                            .catch(err => { ctx.close();
                                console.warn(`[${EXT_NAME}] chunk decode error:`, err);
                                return null; }),
                    );
                } else if (ev.data === '[DONE]') socket.close();
            };
            socket.onclose = async () => {
                clearTimeout(timer);
                const audioBuffers = (await Promise.all(decodePromises)).filter(Boolean);
                if (!audioBuffers.length) {
                    resolve(new Blob([silentWav()], { type: 'audio/wav' }));
                    return;
                }
                // Merge all decoded AudioBuffers → one Float32 array → one WAV
                const sr       = audioBuffers[0].sampleRate;
                const totalLen = audioBuffers.reduce((s, b) => s + b.length, 0);
                const merged   = new Float32Array(totalLen);
                let off = 0;
                for (const b of audioBuffers) {
                    // Mix down to mono in case the model ever produces stereo
                    const ch0 = b.getChannelData(0);
                    if (b.numberOfChannels > 1) {
                        const ch1 = b.getChannelData(1);
                        for (let i = 0; i < ch0.length; i++)
                            merged[off + i] = (ch0[i] + ch1[i]) / 2;
                    } else {
                        merged.set(ch0, off);
                    }
                    off += b.length;
                }
                resolve(new Blob([_encodeWav(merged, sr)], { type: 'audio/wav' }));
            };
            socket.onerror = (e) => { clearTimeout(timer); reject(e); };
        });
    }
}

// ── Init ──────────────────────────────────────────────────────────────────────

jQuery(async () => {
    try {
        // Dynamic import — avoids hard dependency on ST internals at parse time
        const ttsModule = await import('/scripts/extensions/tts/index.js');

        console.debug(`[${EXT_NAME}] TTS module exports:`, Object.keys(ttsModule));

        const { registerTtsProvider, getPreviewString, saveTtsProviderSettings } = ttsModule;

        if (typeof registerTtsProvider !== 'function') {
            throw new Error(
                `registerTtsProvider not found in TTS module. ` +
                `Available exports: ${Object.keys(ttsModule).join(', ')}. ` +
                `Make sure the built-in TTS extension is enabled in ST.`,
            );
        }

        if (typeof saveTtsProviderSettings === 'function')
            _saveTtsProviderSettings = saveTtsProviderSettings;
        if (typeof getPreviewString === 'function')
            _getPreviewString = getPreviewString;

        // Register the CLASS (not an instance) — ST calls new Provider() itself.
        // currentProvider is set inside the constructor when ST instantiates it.
        registerTtsProvider('WS TTS (Streaming)', WsTtsStreamingProvider);

        // Hook generation events for real-time streaming
        const { eventSource, event_types } = SillyTavern.getContext();
        eventSource.on(event_types.GENERATION_STARTED,    onGenerationStarted);
        eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
        eventSource.on(event_types.GENERATION_ENDED,      onGenerationEnded);
        eventSource.on(event_types.GENERATION_STOPPED,    onGenerationStopped);

        console.info(`[${EXT_NAME}] v1.5.1 loaded — select "${EXT_NAME}" in Extensions → TTS panel`);
    } catch (err) {
        console.error(`[${EXT_NAME}] Failed to initialise:`, err);
    }
});
