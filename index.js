/**
 * Qwen TTS Streaming — SillyTavern Extension
 *
 * Pipes LLM streaming tokens in real-time to the Qwen3-TTS WebSocket endpoint
 * (/ws/tts), so each sentence is spoken the moment it is generated — no waiting
 * for the full reply to finish.
 *
 * Install: copy this folder into SillyTavern/public/scripts/extensions/third-party/
 * then enable via Extensions panel.
 *
 * NOTE: Disable any other TTS provider (e.g. tts-webui) while using this extension
 *       to avoid double-playback after generation completes.
 */

// Prefer getContext() (stable API) over direct imports where possible.
// eventSource / event_types are imported directly as they are not yet exposed
// through getContext in all ST builds.
import { eventSource, event_types } from '../../../../script.js';

const EXT_NAME = 'qwen-tts-streaming';
const EXT_FOLDER = `scripts/extensions/third-party/${EXT_NAME}`;

const DEFAULT_SETTINGS = Object.freeze({
    enabled: false,
    ws_endpoint: 'ws://192.168.1.100:7860/ws/tts',
    speaker_wav: '',
    language: 'en',
    volume: 1.0,
});

// ── State ──────────────────────────────────────────────────────────────────────

let ws = null;               // active WebSocket
let audioCtx = null;         // single AudioContext for the session
let nextStartTime = 0;       // when the next audio chunk should start playing
let lastSentLength = 0;      // track chars already forwarded to avoid re-sending
let isGenerating = false;    // true while LLM is streaming
let gainNode = null;         // volume control node

// ── Settings helpers ───────────────────────────────────────────────────────────

/**
 * Returns the extension settings object, initialising it and backfilling any
 * keys that may be missing after an update (so existing users are not broken).
 */
function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    if (!extensionSettings[EXT_NAME]) {
        extensionSettings[EXT_NAME] = {};
    }
    // Backfill any missing keys with their defaults — handles new keys added in updates.
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extensionSettings[EXT_NAME][key] === undefined) {
            extensionSettings[EXT_NAME][key] = value;
        }
    }
    return extensionSettings[EXT_NAME];
}

function saveSettings() {
    const { saveSettingsDebounced } = SillyTavern.getContext();
    saveSettingsDebounced();
}

// ── Audio playback ─────────────────────────────────────────────────────────────

function ensureAudioContext() {
    if (!audioCtx || audioCtx.state === 'closed') {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        gainNode = audioCtx.createGain();
        gainNode.gain.value = getSettings().volume;
        gainNode.connect(audioCtx.destination);
        nextStartTime = audioCtx.currentTime;
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }
}

/**
 * Each binary WS message from the server is a complete WAV file.
 * Decode it and schedule it to play immediately after the previous chunk.
 */
function scheduleAudioChunk(arrayBuffer) {
    ensureAudioContext();
    // Capture ctx + gain locally — stopAudio() may replace them while decode is
    // in flight, and the callback must not write into a closed context.
    const ctx  = audioCtx;
    const gain = gainNode;
    ctx.decodeAudioData(
        arrayBuffer.slice(0), // slice to detach — decodeAudioData needs ownership
        (decoded) => {
            if (ctx.state === 'closed') return;
            const src = ctx.createBufferSource();
            src.buffer = decoded;
            src.connect(gain);
            const startAt = Math.max(ctx.currentTime + 0.02, nextStartTime);
            src.start(startAt);
            nextStartTime = startAt + decoded.duration;
        },
        (err) => {
            console.warn(`[${EXT_NAME}] Audio decode error:`, err);
        },
    );
}

function stopAudio() {
    if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close();
        audioCtx = null;
        gainNode = null;
    }
    nextStartTime = 0;
}

// ── WebSocket management ───────────────────────────────────────────────────────

function buildWsUrl() {
    const s = getSettings();
    const base = s.ws_endpoint.replace(/\/+$/, '');
    const params = new URLSearchParams();
    if (s.speaker_wav) params.set('speaker_wav', s.speaker_wav);
    if (s.language)    params.set('language', s.language);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
}

function openWs() {
    if (ws && ws.readyState === WebSocket.OPEN) return;
    closeWs();

    const url = buildWsUrl();
    console.info(`[${EXT_NAME}] Connecting → ${url}`);

    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.info(`[${EXT_NAME}] WebSocket connected`);
    };

    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            // Binary = WAV audio for a completed sentence
            scheduleAudioChunk(event.data);
        } else if (typeof event.data === 'string') {
            if (event.data === '[DONE]') {
                console.info(`[${EXT_NAME}] TTS generation complete`);
                closeWs();
            }
        }
    };

    ws.onerror = (err) => {
        console.error(`[${EXT_NAME}] WebSocket error:`, err);
    };

    ws.onclose = (event) => {
        console.info(`[${EXT_NAME}] WebSocket closed (code ${event.code})`);
        ws = null;
    };
}

function closeWs(sendEnd = false) {
    if (!ws) return;
    const socket = ws;
    ws = null; // null immediately so new connections are never blocked by a draining socket
    if (sendEnd && socket.readyState === WebSocket.OPEN) {
        socket.send('[END]');
        // Server closes the connection after sending [DONE]; force-close after a timeout
        // in case the server never responds (e.g. network drop).
        setTimeout(() => {
            if (socket.readyState !== WebSocket.CLOSED) socket.close();
        }, 10000);
    } else {
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close();
        }
    }
}

// ── ST Event hooks ─────────────────────────────────────────────────────────────

/**
 * ST fires STREAM_TOKEN_RECEIVED with the *full accumulated text* so far on each
 * streaming tick. We compute the delta and forward only new characters to the WS.
 */
function onStreamToken(text) {
    if (!getSettings().enabled) return;
    if (!isGenerating) return;
    if (typeof text !== 'string') return;

    // Reconnect if the socket dropped mid-generation
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        console.warn(`[${EXT_NAME}] WS dropped mid-generation — reconnecting`);
        openWs();
    }

    // Still CONNECTING — the onopen handler will not replay missed tokens, but at
    // least we won't lose the remainder of the stream once it opens.
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const newPart = text.slice(lastSentLength);
    if (newPart.length === 0) return;

    lastSentLength = text.length;
    ws.send(newPart);
}

function onGenerationStarted() {
    if (!getSettings().enabled) return;

    isGenerating = true;
    lastSentLength = 0;

    // Reset audio scheduling for new session
    stopAudio();
    ensureAudioContext();

    openWs();
}

function onGenerationEnded() {
    if (!getSettings().enabled) return;

    isGenerating = false;
    // Signal server to flush its text buffer and finish
    closeWs(true);
}

function onGenerationStopped() {
    if (!getSettings().enabled) return;

    isGenerating = false;
    closeWs(true); // still flush whatever buffer we have
}

// ── Settings UI ────────────────────────────────────────────────────────────────

function loadSettingsUI() {
    const s = getSettings();

    $('#qts_enabled').prop('checked', s.enabled);
    $('#qts_ws_endpoint').val(s.ws_endpoint);
    $('#qts_speaker').val(s.speaker_wav);
    $('#qts_language').val(s.language);
    $('#qts_volume').val(s.volume);
    $('#qts_volume_counter').val(s.volume);
    $('#qts_volume_label').text(Number(s.volume).toFixed(2));

    // Guard against handler stacking if ST re-renders the extensions panel
    $('#qts_enabled').off('change').on('change', function () {
        getSettings().enabled = $(this).is(':checked');
        saveSettings();
    });

    $('#qts_ws_endpoint').off('input').on('input', function () {
        getSettings().ws_endpoint = $(this).val().trim();
        saveSettings();
    });

    $('#qts_speaker').off('input').on('input', function () {
        getSettings().speaker_wav = $(this).val().trim();
        saveSettings();
    });

    $('#qts_language').off('input').on('input', function () {
        getSettings().language = $(this).val().trim() || 'en';
        saveSettings();
    });

    // Keep the range slider and its numeric counter in sync.
    $('#qts_volume').off('input').on('input', function () {
        const v = parseFloat($(this).val());
        getSettings().volume = v;
        $('#qts_volume_label').text(v.toFixed(2));
        $('#qts_volume_counter').val(v.toFixed(2));
        if (gainNode) gainNode.gain.value = v;
        saveSettings();
    });

    $('#qts_volume_counter').off('input').on('input', function () {
        const v = Math.min(2, Math.max(0, parseFloat($(this).val()) || 0));
        getSettings().volume = v;
        $('#qts_volume_label').text(v.toFixed(2));
        $('#qts_volume').val(v);
        if (gainNode) gainNode.gain.value = v;
        saveSettings();
    });

    $('#qts_test_btn').off('click').on('click', async function () {
        const statusEl = $('#qts_status');
        statusEl.text('Connecting…');

        // Use a fully isolated AudioContext so the test never disturbs the live
        // generation pipeline (stopAudio / ensureAudioContext are NOT called here).
        let testCtx  = new (window.AudioContext || window.webkitAudioContext)();
        let testGain = testCtx.createGain();
        testGain.gain.value = getSettings().volume;
        testGain.connect(testCtx.destination);
        let testNextStart = testCtx.currentTime;

        const testWs = new WebSocket(buildWsUrl());
        testWs.binaryType = 'arraybuffer';

        testWs.onopen = () => {
            testWs.send('Hello! This is a test of the Qwen TTS streaming voice.');
            testWs.send('[END]');
            statusEl.text('Sent — waiting for audio…');
        };

        testWs.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                statusEl.text('Playing…');
                testCtx.decodeAudioData(event.data.slice(0), (decoded) => {
                    if (testCtx.state === 'closed') return;
                    const src = testCtx.createBufferSource();
                    src.buffer = decoded;
                    src.connect(testGain);
                    const startAt = Math.max(testCtx.currentTime + 0.02, testNextStart);
                    src.start(startAt);
                    testNextStart = startAt + decoded.duration;
                }, (err) => console.warn(`[${EXT_NAME}] Test audio decode error:`, err));
            } else if (event.data === '[DONE]') {
                statusEl.text('✓ Done');
                testWs.close();
            }
        };

        testWs.onerror = () => statusEl.text('✗ Connection failed');
        testWs.onclose = () => {
            setTimeout(() => {
                statusEl.text('');
                testCtx.close();
            }, 3000);
        };
    });
}

// ── Init ───────────────────────────────────────────────────────────────────────

jQuery(async () => {
    // Load settings HTML from the external file and inject into the ST settings panel.
    // #extensions_settings = left column (system/functional extensions — correct for TTS).
    const settingsHtml = await $.get(`${EXT_FOLDER}/settings.html`);
    $('#extensions_settings').append(settingsHtml);
    loadSettingsUI();

    // Register event listeners
    eventSource.on(event_types.GENERATION_STARTED,    onGenerationStarted);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(event_types.GENERATION_ENDED,      onGenerationEnded);  // normal finish
    eventSource.on(event_types.GENERATION_STOPPED,    onGenerationStopped); // user abort
    // NOTE: GENERATION_AFTER_COMMANDS fires after every generation (not only on abort)
    // so it is intentionally NOT used here — it would send a second [END] every time.

    console.info(`[${EXT_NAME}] Extension loaded`);
});
