// SillyTavern Koishi Bridge - Client Extension
// Bridges SillyTavern chats to Koishi bot channels via WebSocket.

import { getContext, extension_settings } from '../../../extensions.js';

import {
    eventSource,
    event_types,
    sendMessageAsUser,
    Generate,
    getRequestHeaders,
    saveSettingsDebounced,
    openCharacterChat,
    selectCharacterById,
    characters,
    this_chid,
} from '../../../../script.js';

// Derive extension folder URL for loading templates
const EXTENSION_FOLDER_URL = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));

// ============================================================
// Constants
// ============================================================

const MODULE_NAME = 'koishi-bridge';
const LOG_MAX_ENTRIES = 100;

// ============================================================
// Default Settings
// ============================================================

const DEFAULT_SETTINGS = {
    wsUrl: 'ws://localhost:5140/st-proxy',
    apiKey: '',
    autoConnect: false,
    forwardUser: true,
    forwardAi: true,
    forwardTts: true,
    forwardImages: true,
    forwardImageDescriptions: false,
    autoReconnectApi: true,
};

// ============================================================
// Chat Switching
// ============================================================

/**
 * Switch to a specific chat by chatId.
 * chatId format: "CharName - 2026-03-14@18h06m18s170ms" (no .jsonl suffix)
 * Steps: 1) find character by name, 2) select character, 3) open specific chat file
 */
async function switchToChat(chatId) {
    // Extract character name from chatId (everything before " - ")
    const separatorIndex = chatId.indexOf(' - ');
    if (separatorIndex === -1) {
        throw new Error(`Invalid chatId format: ${chatId}`);
    }
    const charName = chatId.substring(0, separatorIndex);

    // Find character index by name
    const charIndex = characters.findIndex(c => c.name === charName);
    if (charIndex === -1) {
        throw new Error(`Character "${charName}" not found`);
    }

    // Verify the chat file exists before switching
    const response = await fetch('/api/chats/search', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ query: '', avatar_url: characters[charIndex].avatar }),
    });
    if (response.ok) {
        const chats = await response.json();
        if (!chats.some(c => c.file_name === chatId)) {
            throw new Error(`Chat "${chatId}" not found for character "${charName}"`);
        }
    }

    // Select the character first (loads their default chat)
    if (this_chid !== charIndex) {
        await selectCharacterById(String(charIndex));
        await new Promise(r => setTimeout(r, 500));
    }

    // Now switch to the specific chat file
    if (getContext().chatId !== chatId) {
        await openCharacterChat(chatId);
        await new Promise(r => setTimeout(r, 500));
    }
}

// ============================================================
// State
// ============================================================

let ws = null;
let isConnected = false;
let reconnectAttempts = 0;
let reconnectTimer = null;
let pendingSourceChannelKey = null;
let isGenerating = false;
let lastAiMessageId = null;
let lastProcessedMessageId = -1;
let ttsObserver = null;

const MAX_RECONNECT_DELAY = 30000;
const messageQueue = [];

// Incoming message queue for serial processing (prevents concurrent Generate() calls)
const incomingQueue = [];
let isProcessingIncoming = false;

// ============================================================
// Settings Management
// ============================================================

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    // Apply defaults for missing keys
    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = value;
        }
    }
    return extension_settings[MODULE_NAME];
}

function saveSettings() {
    saveSettingsDebounced();
}

// ============================================================
// Logging
// ============================================================

function log(message, level = 'info') {
    const prefix = `[Koishi Bridge]`;
    if (level === 'error') {
        console.error(prefix, message);
    } else if (level === 'warn') {
        console.warn(prefix, message);
    } else {
        console.log(prefix, message);
    }

    // Update UI log
    const logEl = document.getElementById('koishi_bridge_log');
    if (logEl) {
        const entry = document.createElement('div');
        entry.classList.add('log-entry');
        const time = new Date().toLocaleTimeString();
        entry.textContent = `[${time}] ${message}`;
        logEl.appendChild(entry);

        // Trim old entries
        while (logEl.children.length > LOG_MAX_ENTRIES) {
            logEl.removeChild(logEl.firstChild);
        }

        // Auto scroll
        logEl.scrollTop = logEl.scrollHeight;
    }
}

// ============================================================
// WebSocket Connection
// ============================================================

function connect() {
    const settings = getSettings();
    if (!settings.wsUrl) {
        log('No WebSocket URL configured', 'warn');
        return;
    }

    disconnect(); // Clean up any existing connection

    const url = new URL(settings.wsUrl);
    if (settings.apiKey) {
        url.searchParams.set('key', settings.apiKey);
    }

    log(`Connecting to ${settings.wsUrl}...`);
    updateStatus('connecting');

    try {
        ws = new WebSocket(url.toString());
    } catch (e) {
        log(`Failed to create WebSocket: ${e.message}`, 'error');
        updateStatus('disconnected');
        scheduleReconnect();
        return;
    }

    ws.onopen = () => {
        isConnected = true;
        reconnectAttempts = 0;
        log('Connected');
        updateStatus('connected');
        flushQueue();
    };

    ws.onmessage = (event) => {
        try {
            const msg = JSON.parse(event.data);
            handleKoishiMessage(msg);
        } catch (e) {
            log(`Failed to parse message: ${e.message}`, 'error');
        }
    };

    ws.onclose = (event) => {
        const wasConnected = isConnected;
        isConnected = false;
        ws = null;
        updateStatus('disconnected');

        if (event.code === 4001) {
            log('Authentication failed. Check your API key.', 'error');
            // Don't reconnect on auth failure
            return;
        }

        if (wasConnected) {
            log(`Disconnected (code: ${event.code})`);
        }

        scheduleReconnect();
    };

    ws.onerror = (event) => {
        log('WebSocket error', 'error');
    };
}

function disconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    reconnectAttempts = 0;

    if (ws) {
        // Remove listeners to prevent reconnect on intentional disconnect
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        ws = null;
    }
    isConnected = false;
    updateStatus('disconnected');
}

function scheduleReconnect() {
    const settings = getSettings();
    // Always reconnect if autoConnect is on, or on the first drop of a manual connection
    if (!settings.autoConnect) return;

    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
    reconnectAttempts++;
    log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})...`);

    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
    }, delay);
}

function sendToKoishi(msg) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        try {
            ws.send(JSON.stringify(msg));
            return true;
        } catch (e) {
            log(`Send error, queuing: ${e.message}`, 'warn');
        }
    }
    // WS not available or send failed — queue the message
    messageQueue.push(msg);
    log(`Message queued (${messageQueue.length} pending)`);
    return false;
}

function flushQueue() {
    if (messageQueue.length === 0) return;
    log(`Flushing ${messageQueue.length} queued messages...`);
    let sent = 0;
    while (messageQueue.length > 0 && ws?.readyState === WebSocket.OPEN) {
        const msg = messageQueue.shift();
        try {
            ws.send(JSON.stringify(msg));
            sent++;
        } catch {
            messageQueue.unshift(msg); // put it back
            break;
        }
    }
    log(`Flushed ${sent} messages${messageQueue.length > 0 ? `, ${messageQueue.length} remaining` : ''}`);
}

// ============================================================
// Handle messages from Koishi
// ============================================================

async function handleKoishiMessage(msg) {
    switch (msg.type) {
        case 'send_combined_message':
            enqueueIncoming(msg);
            break;
        case 'validate_chat':
            await handleValidateChat(msg);
            break;
        case 'list_chats':
            await handleListChats(msg);
            break;
        case 'get_avatar':
            await handleGetAvatar(msg);
            break;
        default:
            log(`Unknown message type: ${msg.type}`, 'warn');
    }
}

/** Enqueue incoming send_combined_message for serial processing */
function enqueueIncoming(msg) {
    incomingQueue.push(msg);
    if (!isProcessingIncoming) {
        processIncomingQueue();
    }
}

async function processIncomingQueue() {
    isProcessingIncoming = true;
    while (incomingQueue.length > 0) {
        const msg = incomingQueue.shift();
        try {
            if (msg.type === 'send_combined_message') {
                await handleCombinedMessage(msg);
            }
        } catch (e) {
            log(`Error processing queued message: ${e.message}`, 'error');
        }
    }
    isProcessingIncoming = false;
}

async function handleValidateChat(msg) {
    const chatId = msg.chatId;
    const requestId = msg.requestId;

    // chatId format: "CharName - timestamp"
    const separatorIndex = chatId.indexOf(' - ');
    if (separatorIndex === -1) {
        sendToKoishi({ type: 'validate_chat_result', requestId, valid: false, chatId, error: 'Invalid format' });
        return;
    }

    const charName = chatId.substring(0, separatorIndex);

    // Check if character exists
    const charIndex = characters.findIndex(c => c.name === charName);
    if (charIndex === -1) {
        sendToKoishi({ type: 'validate_chat_result', requestId, valid: false, chatId, error: `Character "${charName}" not found` });
        return;
    }

    // Check if chat file exists via server API
    try {
        const response = await fetch('/api/chats/search', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ query: '', avatar_url: characters[charIndex].avatar }),
        });
        if (response.ok) {
            const chats = await response.json();
            const found = chats.some(chat => chat.file_name === chatId);
            sendToKoishi({
                type: 'validate_chat_result',
                requestId,
                valid: found,
                chatId,
                error: found ? null : `Chat "${chatId}" not found for character "${charName}"`,
            });
        } else {
            sendToKoishi({ type: 'validate_chat_result', requestId, valid: false, chatId, error: 'Failed to query chats' });
        }
    } catch (e) {
        sendToKoishi({ type: 'validate_chat_result', requestId, valid: false, chatId, error: e.message });
    }
}

async function handleListChats(msg) {
    const requestId = msg.requestId;
    try {
        const result = [];
        for (const char of characters) {
            if (!char || !char.avatar) continue;
            const response = await fetch('/api/chats/search', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ query: '', avatar_url: char.avatar }),
            });
            if (!response.ok) continue;
            const chats = await response.json();
            for (const chat of chats) {
                // file_name is like "CharName - timestamp.jsonl", strip .jsonl
                const chatId = chat.file_name?.replace(/\.jsonl$/, '') || '';
                if (!chatId) continue;
                result.push({
                    chatId,
                    characterName: char.name,
                    messageCount: chat.message_count || 0,
                    lastMessage: chat.last_mes || '',
                });
            }
        }
        sendToKoishi({ type: 'list_chats_result', requestId, chats: result });
    } catch (e) {
        sendToKoishi({ type: 'list_chats_result', requestId, chats: [], error: e.message });
    }
}

async function handleGetAvatar(msg) {
    const requestId = msg.requestId;
    const charName = msg.characterName;

    try {
        const char = characters.find(c => c.name === charName);
        if (!char || !char.avatar) {
            sendToKoishi({ type: 'get_avatar_result', requestId, avatar: null, error: `Character "${charName}" not found` });
            return;
        }

        // Fetch the character's full-size avatar (not thumbnail — Telegram needs larger images)
        const response = await fetch(`/characters/${encodeURIComponent(char.avatar)}`);
        if (response.ok) {
            const blob = await response.blob();
            const buffer = await blob.arrayBuffer();
            const base64 = arrayBufferToBase64(buffer);
            const mimeType = blob.type || 'image/png';
            sendToKoishi({ type: 'get_avatar_result', requestId, avatar: base64, mimeType });
        } else {
            sendToKoishi({ type: 'get_avatar_result', requestId, avatar: null, error: 'Failed to fetch avatar' });
        }
    } catch (e) {
        sendToKoishi({ type: 'get_avatar_result', requestId, avatar: null, error: e.message });
    }
}

async function handleCombinedMessage(msg) {
    const context = getContext();
    const currentChatId = context.chatId;
    const needsSwitch = currentChatId !== msg.chatId;

    log(`Forwarding combined message from ${msg.senderName} via ${msg.sourceChannelKey}${needsSwitch ? ` (switching from ${currentChatId})` : ''}`);

    if (needsSwitch) {
        try {
            await switchToChat(msg.chatId);
            log(`Switched to chat: ${msg.chatId}`);
        } catch (e) {
            log(`Failed to switch chat: ${e.message}`, 'error');
            sendToKoishi({ type: 'send_message_result', sourceChannelKey: msg.sourceChannelKey, success: false, error: e.message });
            return;
        }
    }

    pendingSourceChannelKey = msg.sourceChannelKey;

    try {
        let finalMessageText = msg.text || '';
        const files = msg.files || [];
        const attachFiles = [];

        for (const file of files) {
            if (file.mimeType.startsWith('audio/') && finalMessageText.trim() === '') {
                // Pure voice message (no text): attempt STT
                log('Audio file with no text detected, attempting STT transcription...');
                const transcript = await transcribeAudio(file.data, file.mimeType);
                if (transcript) {
                    log(`Transcribed: "${transcript.substring(0, 50)}..."`);
                    finalMessageText = transcript;
                } else {
                    log('Transcription empty, attaching audio as file', 'warn');
                    attachFiles.push(file);
                }
            } else {
                // All other files (images, PDFs, audio+text combos): attach via ST's file input
                attachFiles.push(file);
            }
        }

        // Inject files into ST's file input (simulates "Attach a File" button)
        if (attachFiles.length > 0) {
            const dt = new DataTransfer();
            for (const f of attachFiles) {
                const binary = atob(f.data);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
            }
            const fileInput = document.getElementById('file_form_input');
            if (fileInput) fileInput.files = dt.files;
            log(`Injected ${attachFiles.length} file(s) into ST file input`);
        }

        // Send message (ST's sendMessageAsUser will auto-process pending file attachments)
        if (finalMessageText.trim() !== '' || attachFiles.length > 0) {
            await sendMessageAsUser(finalMessageText.trim() || ' ');
            await Generate('normal');
        }

    } catch (e) {
        log(`Failed to send/generate: ${e.message}`, 'error');
        sendToKoishi({ type: 'send_message_result', sourceChannelKey: msg.sourceChannelKey, success: false, error: e.message });
    } finally {
        setTimeout(() => { pendingSourceChannelKey = null; }, 5000);
    }

    if (needsSwitch && currentChatId) {
        try { await switchToChat(currentChatId); } catch (e) {}
    }
}

// ============================================================
// ST Event Handlers: ST → Koishi
// ============================================================

async function forwardUserMessage(messageId) {
    const settings = getSettings();
    if (!settings.forwardUser || !isConnected) return;

    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) return;

    // Skip system messages
    if (message.is_system) return;

    // Only forward user messages
    if (!message.is_user) return;

    const content = {
        text: message.mes || '',
        images: [],
        files: [],
    };

    // Extract images from message.extra.media if enabled
    if (settings.forwardImages && message.extra?.media?.length) {
        for (const attachment of message.extra.media) {
            if (!attachment.url) continue;
            try {
                const response = await fetch(attachment.url);
                if (response.ok) {
                    const blob = await response.blob();
                    const buffer = await blob.arrayBuffer();
                    const base64 = arrayBufferToBase64(buffer);
                    content.images.push({ data: base64, mimeType: blob.type || 'image/jpeg' });
                }
            } catch (e) {
                log(`Failed to fetch user media: ${e.message}`, 'warn');
            }
        }
    }

    if (!content.text && content.images.length === 0) return;

    const sent = sendToKoishi({
        type: 'user_message',
        chatId: getContext().chatId,
        characterName: context.name2,
        userName: context.name1,
        content,
        sourceChannelKey: pendingSourceChannelKey,
        timestamp: Date.now(),
    });

    if (sent) {
        log(`Forwarded user message (${content.text.substring(0, 50)}...)`);
    }

    // Consume the pending source channel key
    pendingSourceChannelKey = null;
    // Clear AI message marker — any TTS after this is user audio, not AI
    lastAiMessageId = null;
}

async function forwardCharacterMessage(messageId) {
    const settings = getSettings();
    if (!settings.forwardAi || !isConnected) return;

    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) return;

    // Skip user messages
    if (message.is_user) return;

    log(`CHARACTER_MESSAGE_RENDERED #${messageId}: name=${message.name}, is_system=${message.is_system}, media=${message.extra?.media?.length || 0}`);

    lastAiMessageId = messageId;

    const content = {
        text: message.mes || '',
        images: [],
    };

    // If this is an image generation message and forwardImageDescriptions is false, clear the text
    if (!settings.forwardImageDescriptions && message.extra?.media?.length) {
        content.text = '';
    }

    // Extract images from message.extra.media (standard location for SD-generated images)
    if (settings.forwardImages && message.extra?.media?.length) {
        for (const attachment of message.extra.media) {
            if (!attachment.url) continue;
            try {
                const response = await fetch(attachment.url);
                if (response.ok) {
                    const blob = await response.blob();
                    const buffer = await blob.arrayBuffer();
                    const base64 = arrayBufferToBase64(buffer);
                    content.images.push({
                        data: base64,
                        mimeType: blob.type || 'image/jpeg',
                    });
                }
            } catch (e) {
                log(`Failed to fetch media: ${e.message}`, 'warn');
            }
        }
    }

    if (!content.text && content.images.length === 0) return;

    const sent = sendToKoishi({
        type: 'ai_message',
        chatId: context.chatId,
        characterName: context.name2,
        content,
        timestamp: Date.now(),
    });

    if (sent) {
        log(`Forwarded AI message (${content.text.substring(0, 50)}...) [images: ${content.images.length}]`);
    }
}

async function catchUpMissedMessages(targetId) {
    const context = getContext();
    if (!context.chat) return;
    
    if (targetId === undefined) {
        targetId = context.chat.length - 1;
    }
    
    while (lastProcessedMessageId < targetId) {
        const nextId = lastProcessedMessageId + 1;
        const msg = context.chat[nextId];
        
        if (msg && !msg.is_system) {
            if (msg.is_user) {
                await forwardUserMessage(nextId);
            } else {
                await forwardCharacterMessage(nextId);
            }
        }
        
        lastProcessedMessageId = nextId;
    }
}

async function onUserMessageRendered(messageId) {
    await catchUpMissedMessages(messageId - 1);
    await forwardUserMessage(messageId);
    if (messageId > lastProcessedMessageId) {
        lastProcessedMessageId = messageId;
    }
}

async function onCharacterMessageRendered(messageId) {
    await catchUpMissedMessages(messageId - 1);
    await forwardCharacterMessage(messageId);
    if (messageId > lastProcessedMessageId) {
        lastProcessedMessageId = messageId;
    }
}

function onGenerationStarted() {
    isGenerating = true;
    if (!isConnected) return;

    const context = getContext();
    sendToKoishi({
        type: 'generation_started',
        chatId: getContext().chatId,
        characterName: context.name2,
    });
}

function onGenerationEnded() {
    isGenerating = false;
    if (!isConnected) return;

    sendToKoishi({
        type: 'generation_ended',
        chatId: getContext().chatId,
    });
}

// ============================================================
// Audio STT (Speech-to-Text)
// Replicates the flow from Extension-Speech-Recognition:
// audio data → decode → WAV conversion → POST to STT endpoint
// ============================================================

/** Map of STT provider names to their API endpoints */
const STT_PROVIDER_ENDPOINTS = {
    'Groq': '/api/openai/groq/transcribe-audio',
    'OpenAI': '/api/openai/transcribe-audio',
    'Whisper (OpenAI)': '/api/openai/transcribe-audio',
    'MistralAI': '/api/openai/mistral/transcribe-audio',
    'Z.AI': '/api/openai/zai/transcribe-audio',
    'Chutes': '/api/openai/chutes/transcribe-audio',
    'KoboldCpp': '/api/backends/kobold/transcribe-audio',
    'ElevenLabs': '/api/speech/elevenlabs/recognize',
    'Whisper (Local)': '/api/speech/recognize',
    'Whisper (Extras)': '/api/speech/recognize',
};

/**
 * Transcribe audio data to text using the configured STT provider.
 * @param {string} base64Data - Base64-encoded audio data
 * @param {string} mimeType - Audio MIME type
 * @returns {Promise<string|null>} Transcribed text or null on failure
 */
async function transcribeAudio(base64Data, mimeType) {
    const sttSettings = extension_settings?.speech_recognition || {};
    const provider = sttSettings.currentProvider || 'None';

    if (provider === 'None' || provider === 'Browser' || provider === 'Streaming') {
        log(`STT provider "${provider}" cannot transcribe audio files`, 'warn');
        return null;
    }

    const endpoint = STT_PROVIDER_ENDPOINTS[provider];
    if (!endpoint) {
        log(`Unknown STT provider: ${provider}`, 'warn');
        return null;
    }

    const providerSettings = sttSettings[provider] || {};
    const model = providerSettings.model || '';
    const language = providerSettings.language || '';

    try {
        // Decode base64 → ArrayBuffer → AudioBuffer → WAV (same as STT extension)
        const byteString = atob(base64Data);
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }
        const audioBlob = new Blob([ab], { type: mimeType });

        // Decode to AudioBuffer then convert to WAV (replicating STT extension behavior)
        const arrayBuffer = await audioBlob.arrayBuffer();
        const audioContext = new AudioContext();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
        const wavBlob = await convertAudioBufferToWavBlob(audioBuffer);

        // For local whisper endpoint, send as JSON with base64 data URI
        if (endpoint === '/api/speech/recognize') {
            const wavArrayBuffer = await wavBlob.arrayBuffer();
            const wavBase64 = arrayBufferToBase64(wavArrayBuffer);
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    audio: `data:audio/wav;base64,${wavBase64}`,
                    lang: language,
                    model: model,
                }),
            });
            if (response.ok) {
                const result = await response.json();
                return result.text || null;
            }
            log(`STT API error: ${response.status}`, 'warn');
            return null;
        }

        // For all other providers, send as FormData (same as stt-base.js processAudio)
        const formData = new FormData();
        formData.append('avatar', wavBlob, 'record.wav');
        if (model) formData.append('model', model);
        if (language) formData.append('language', language);

        const headers = getRequestHeaders();
        delete headers['Content-Type']; // Let browser set multipart boundary

        const response = await fetch(endpoint, {
            method: 'POST',
            headers,
            body: formData,
        });

        if (response.ok) {
            const result = await response.json();
            return result.text || null;
        }
        log(`STT API error: ${response.status} ${await response.text()}`, 'warn');
        return null;
    } catch (e) {
        log(`Transcription error: ${e.message}`, 'error');
        return null;
    }
}

/**
 * Convert AudioBuffer to WAV Blob using a Web Worker.
 * Replicates convertAudioBufferToWavBlob from Extension-Speech-Recognition.
 */
function convertAudioBufferToWavBlob(audioBuffer) {
    return new Promise((resolve) => {
        // Try to use the STT extension's wave-worker if available
        const workerPaths = [
            '/scripts/extensions/third-party/Extension-Speech-Recognition/wave-worker.js',
            '/scripts/extensions/Extension-Speech-Recognition/wave-worker.js',
        ];

        // Try each path
        function tryWorker(index) {
            if (index >= workerPaths.length) {
                // Fallback: manual WAV conversion without Web Worker
                resolve(manualWavConvert(audioBuffer));
                return;
            }
            try {
                const worker = new Worker(workerPaths[index]);
                worker.onmessage = function (e) {
                    resolve(new Blob([e.data.buffer], { type: 'audio/wav' }));
                    worker.terminate();
                };
                worker.onerror = function () {
                    worker.terminate();
                    tryWorker(index + 1);
                };
                let pcmArrays = [];
                for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
                    pcmArrays.push(audioBuffer.getChannelData(i));
                }
                worker.postMessage({
                    pcmArrays,
                    config: { sampleRate: audioBuffer.sampleRate },
                });
            } catch {
                tryWorker(index + 1);
            }
        }
        tryWorker(0);
    });
}

/**
 * Fallback manual WAV conversion if Web Worker is not available.
 */
function manualWavConvert(audioBuffer) {
    const numChannels = 1; // mono
    const sampleRate = audioBuffer.sampleRate;
    const samples = audioBuffer.getChannelData(0);
    const dataLength = samples.length * 2; // 16-bit
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset, str) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
    };
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);

    // PCM data
    let offset = 44;
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
        offset += 2;
    }

    return new Blob([buffer], { type: 'audio/wav' });
}

// ============================================================
// Image Helpers
// ============================================================

/** Convert ArrayBuffer to base64 string (safe for large buffers) */
function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const chunk = bytes.subarray(i, i + chunkSize);
        binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
}

// ============================================================
// TTS Audio Capture (Intercepting window.fetch)
// ============================================================

function setupTtsCapture() {
    const originalFetch = window.fetch;
    window.fetch = async function(...args) {
        const response = await originalFetch.apply(this, args);
        
        try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            const settings = getSettings();
            
            if (response.ok && settings.forwardTts && isConnected && !url.includes('/sounds/')) {
                const contentType = response.headers.get('content-type') || '';
                if (contentType.startsWith('audio/')) {
                    // Only forward AI TTS, not user STT audio
                    if (lastAiMessageId) {
                        const clone = response.clone();
                        clone.blob().then(async blob => {
                            const buffer = await blob.arrayBuffer();
                            const base64 = arrayBufferToBase64(buffer);
                            
                            sendToKoishi({
                                type: 'ai_tts',
                                chatId: getContext().chatId || '',
                                characterName: getContext().name2 || '',
                                audio: base64,
                                mimeType: contentType,
                                timestamp: Date.now(),
                            });
                            log('Intercepted TTS fetch and forwarded instantly');
                        }).catch(e => {
                            log(`Failed to process intercepted TTS blob: ${e}`, 'warn');
                        });
                    }
                }
            }
        } catch (err) {
            log(`Error in fetch interceptor: ${err}`, 'warn');
        }
        
        return response;
    };
    log('TTS fetch interceptor installed');
}

// ============================================================
// Status UI
// ============================================================

function updateStatus(status) {
    const dot = document.getElementById('koishi_bridge_status_dot');
    const text = document.getElementById('koishi_bridge_status_text');
    const connectBtn = document.getElementById('koishi_bridge_connect_btn');
    const disconnectBtn = document.getElementById('koishi_bridge_disconnect_btn');

    if (dot) {
        dot.classList.remove('connected', 'disconnected', 'connecting');
        dot.classList.add(status);
    }

    if (text) {
        const labels = {
            connected: 'Connected',
            disconnected: 'Disconnected',
            connecting: 'Connecting...',
        };
        text.textContent = labels[status] || status;
    }

    if (connectBtn) {
        connectBtn.disabled = status === 'connected' || status === 'connecting';
    }
    if (disconnectBtn) {
        disconnectBtn.disabled = status === 'disconnected';
    }
}

function updateChatIdDisplay() {
    const el = document.getElementById('koishi_bridge_chat_id');
    if (!el) return;

    const context = getContext();
    el.value = getContext().chatId || '(no chat loaded)';
}

// ============================================================
// UI Initialization
// ============================================================

async function initUI() {
    // Load settings HTML directly via fetch (more reliable for third-party extensions)
    const settingsHtml = await (await fetch(`${EXTENSION_FOLDER_URL}/settings.html`)).text();
    const container = document.getElementById('extensions_settings');
    if (container) {
        container.insertAdjacentHTML('beforeend', settingsHtml);
    }

    const settings = getSettings();

    // Populate fields
    const wsUrlInput = document.getElementById('koishi_bridge_ws_url');
    const apiKeyInput = document.getElementById('koishi_bridge_api_key');
    const autoConnectInput = document.getElementById('koishi_bridge_auto_connect');
    const forwardUserInput = document.getElementById('koishi_bridge_forward_user');
    const forwardAiInput = document.getElementById('koishi_bridge_forward_ai');
    const forwardTtsInput = document.getElementById('koishi_bridge_forward_tts');
    const forwardImagesInput = document.getElementById('koishi_bridge_forward_images');
    const forwardImageDescriptionsInput = document.getElementById('koishi_bridge_forward_image_descriptions');
    const autoReconnectApiInput = document.getElementById('koishi_bridge_auto_reconnect_api');

    if (wsUrlInput) wsUrlInput.value = settings.wsUrl;
    if (apiKeyInput) apiKeyInput.value = settings.apiKey;
    if (autoConnectInput) autoConnectInput.checked = settings.autoConnect;
    if (forwardUserInput) forwardUserInput.checked = settings.forwardUser;
    if (forwardAiInput) forwardAiInput.checked = settings.forwardAi;
    if (forwardTtsInput) forwardTtsInput.checked = settings.forwardTts;
    if (forwardImagesInput) forwardImagesInput.checked = settings.forwardImages;
    if (forwardImageDescriptionsInput) forwardImageDescriptionsInput.checked = settings.forwardImageDescriptions;
    if (autoReconnectApiInput) autoReconnectApiInput.checked = settings.autoReconnectApi;

    // Bind change events
    wsUrlInput?.addEventListener('input', () => {
        settings.wsUrl = wsUrlInput.value.trim();
        saveSettings();
    });

    apiKeyInput?.addEventListener('input', () => {
        settings.apiKey = apiKeyInput.value.trim();
        saveSettings();
    });

    autoConnectInput?.addEventListener('change', () => {
        settings.autoConnect = autoConnectInput.checked;
        saveSettings();
    });

    forwardUserInput?.addEventListener('change', () => {
        settings.forwardUser = forwardUserInput.checked;
        saveSettings();
    });

    forwardAiInput?.addEventListener('change', () => {
        settings.forwardAi = forwardAiInput.checked;
        saveSettings();
    });

    forwardTtsInput?.addEventListener('change', () => {
        settings.forwardTts = forwardTtsInput.checked;
        saveSettings();
    });

    forwardImagesInput?.addEventListener('change', () => {
        settings.forwardImages = forwardImagesInput.checked;
        saveSettings();
    });

    forwardImageDescriptionsInput?.addEventListener('change', () => {
        settings.forwardImageDescriptions = forwardImageDescriptionsInput.checked;
        saveSettings();
    });

    autoReconnectApiInput?.addEventListener('change', () => {
        settings.autoReconnectApi = autoReconnectApiInput.checked;
        saveSettings();
    });

    // Connect / Disconnect buttons
    document.getElementById('koishi_bridge_connect_btn')?.addEventListener('click', () => {
        connect();
    });

    document.getElementById('koishi_bridge_disconnect_btn')?.addEventListener('click', () => {
        disconnect();
        log('Manually disconnected');
    });

    // Chat ID click-to-select
    document.getElementById('koishi_bridge_chat_id')?.addEventListener('click', (e) => {
        e.target.select();
    });

    updateChatIdDisplay();
}

// ============================================================
// Event Registration
// ============================================================

function registerEvents() {
    // User and AI message events
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onUserMessageRendered);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);

    // Generation lifecycle
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
    eventSource.on(event_types.GENERATION_STOPPED, onGenerationEnded);

    // Chat changed — update chat ID display
    eventSource.on(event_types.CHAT_CHANGED, () => {
        updateChatIdDisplay();
        lastAiMessageId = null;
        pendingSourceChannelKey = null;
        const context = getContext();
        lastProcessedMessageId = context.chat ? context.chat.length - 1 : -1;
    });

    // Tool calls rendered (Catch missed messages skipped by streaming bypass)
    eventSource.on(event_types.TOOL_CALLS_RENDERED, async () => {
        await catchUpMissedMessages();
    });

    // Settings loaded
    eventSource.on(event_types.SETTINGS_LOADED, () => {
        updateChatIdDisplay();
    });

    // Auto-reconnect API when connection drops
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, (status) => {
        if (status === 'no_connection' && getSettings().autoReconnectApi) {
            log('API disconnected, reconnecting...');
            const buttonMap = {
                'kobold': '#api_button',
                'novel': '#api_button_novel',
                'textgenerationwebui': '#api_button_textgenerationwebui',
                'openai': '#api_button_openai',
            };
            const mainApi = $('#main_api').val();
            const btn = buttonMap[mainApi];
            if (btn) {
                $(btn).trigger('click');
                log(`Triggered reconnect for API: ${mainApi}`);
            }
        }
    });
}

// ============================================================
// Monkey-patch to fix TTS queue getting stuck on autoplay blocks
// ============================================================
const originalPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function() {
    const playPromise = originalPlay.apply(this, arguments);
    if (playPromise !== undefined) {
        playPromise.catch(error => {
            if (error.name === 'NotAllowedError') {
                log('Browser blocked audio autoplay. Faking playback to prevent TTS queue from getting stuck.', 'warn');
                setTimeout(() => {
                    this.dispatchEvent(new Event('ended'));
                }, 100);
            }
        });
    }
    return playPromise;
};

// ============================================================
// Entry Point
// ============================================================

jQuery(async () => {
    // Init UI
    await initUI();

    // Register event listeners
    registerEvents();

    // Setup TTS capture
    setupTtsCapture();

    // Update chat ID display immediately (in case chat was already loaded before extension)
    setTimeout(updateChatIdDisplay, 500);

    // Auto-connect if enabled
    const settings = getSettings();
    if (settings.autoConnect && settings.wsUrl) {
        // Small delay to let ST fully initialize
        setTimeout(() => {
            connect();
        }, 2000);
    }

    log('Extension loaded');
});
