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

import { eventSource, event_types } from '../../../../script.js';
import { extension_settings, saveSettingsDebounced } from '../../../extensions.js';

const EXT_NAME = 'qwen-tts-streaming';

const DEFAULT_SETTINGS = {
    enabled: false,
    ws_endpoint: 'ws://192.168.1.100:7860/ws/tts',
    speaker_wav: '',
    language: 'en',
    volume: 1.0,
};

// ── State ──────────────────────────────────────────────────────────────────────

let ws = null;               // active WebSocket
let audioCtx = null;         // single AudioContext for the session
let nextStartTime = 0;       // when the next audio chunk should start playing
let lastSentLength = 0;      // track chars already forwarded to avoid re-sending
let isGenerating = false;    // true while LLM is streaming
let gainNode = null;         // volume control node

// ── Settings helpers ───────────────────────────────────────────────────────────

function getSettings() {
    if (!extension_settings[EXT_NAME]) {
        extension_settings[EXT_NAME] = Object.assign({}, DEFAULT_SETTINGS);
    }
    return extension_settings[EXT_NAME];
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

const SETTINGS_HTML = `
<div id="qwen_tts_streaming_settings">
    <div class="qts-header">
        <b>Qwen TTS — Real-Time Streaming</b>
        <small style="color:#aaa;display:block;margin-top:4px;">
            Speaks each sentence as it is generated, without waiting for the full reply.<br>
            ⚠️ Disable any other TTS provider to avoid double-playback.
        </small>
    </div>
    <hr>

    <label class="checkbox_label" style="margin:8px 0">
        <input type="checkbox" id="qts_enabled" />
        <span>Enable Qwen TTS Streaming</span>
    </label>

    <label style="display:block;margin-top:8px">
        WebSocket Endpoint:
        <input type="text" id="qts_ws_endpoint" class="text_pole"
               placeholder="ws://192.168.1.100:7860/ws/tts" style="width:100%;margin-top:4px"/>
    </label>

    <label style="display:block;margin-top:8px">
        Speaker / Voice ID:
        <input type="text" id="qts_speaker" class="text_pole"
               placeholder="e.g. Clone 1, custom_Alice (leave blank for default)"
               style="width:100%;margin-top:4px"/>
    </label>

    <label style="display:block;margin-top:8px">
        Language code:
        <input type="text" id="qts_language" class="text_pole"
               placeholder="en" style="width:100%;margin-top:4px"/>
    </label>

    <label style="display:block;margin-top:8px">
        Volume: <span id="qts_volume_label">1.0</span>
        <input type="range" id="qts_volume" min="0" max="2" step="0.05" value="1.0"
               style="width:100%;margin-top:4px"/>
    </label>

    <div style="margin-top:12px">
        <button class="menu_button" id="qts_test_btn" title="Send a test phrase">
            ▶ Test Voice
        </button>
        <span id="qts_status" style="margin-left:8px;font-size:0.85em;color:#aaa"></span>
    </div>
</div>
`;

function loadSettingsUI() {
    const s = getSettings();

    $('#qts_enabled').prop('checked', s.enabled);
    $('#qts_ws_endpoint').val(s.ws_endpoint);
    $('#qts_speaker').val(s.speaker_wav);
    $('#qts_language').val(s.language);
    $('#qts_volume').val(s.volume);
    $('#qts_volume_label').text(s.volume);

    // Guard against handler stacking if ST re-renders the extensions panel
    $('#qts_enabled').off('change').on('change', function () {
        getSettings().enabled = $(this).is(':checked');
        saveSettingsDebounced();
    });

    $('#qts_ws_endpoint').off('input').on('input', function () {
        getSettings().ws_endpoint = $(this).val().trim();
        saveSettingsDebounced();
    });

    $('#qts_speaker').off('input').on('input', function () {
        getSettings().speaker_wav = $(this).val().trim();
        saveSettingsDebounced();
    });

    $('#qts_language').off('input').on('input', function () {
        getSettings().language = $(this).val().trim() || 'en';
        saveSettingsDebounced();
    });

    $('#qts_volume').off('input').on('input', function () {
        const v = parseFloat($(this).val());
        getSettings().volume = v;
        $('#qts_volume_label').text(v.toFixed(2));
        if (gainNode) gainNode.gain.value = v;
        saveSettingsDebounced();
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
    // Inject settings panel
    const settingsContainer = document.getElementById('extensions_settings2')
        || document.getElementById('extensions_settings');
    if (settingsContainer) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = SETTINGS_HTML;
        settingsContainer.appendChild(wrapper);
        loadSettingsUI();
    }

    // Register event listeners
    eventSource.on(event_types.GENERATION_STARTED,    onGenerationStarted);
    eventSource.on(event_types.STREAM_TOKEN_RECEIVED, onStreamToken);
    eventSource.on(event_types.GENERATION_ENDED,      onGenerationEnded);  // normal finish
    eventSource.on(event_types.GENERATION_STOPPED,    onGenerationStopped); // user abort
    // NOTE: GENERATION_AFTER_COMMANDS fires after every generation (not only on abort)
    // so it is intentionally NOT used here — it would send a second [END] every time.

    console.info(`[${EXT_NAME}] Extension loaded`);
});
