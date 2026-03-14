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
let ttsObserver = null;

const MAX_RECONNECT_DELAY = 30000;

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
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    try {
        ws.send(JSON.stringify(msg));
        return true;
    } catch (e) {
        log(`Failed to send: ${e.message}`, 'error');
        return false;
    }
}

// ============================================================
// Handle messages from Koishi
// ============================================================

async function handleKoishiMessage(msg) {
    switch (msg.type) {
        case 'send_message':
            await handleSendMessage(msg);
            break;
        case 'send_file':
            await handleSendFile(msg);
            break;
        case 'validate_chat':
            await handleValidateChat(msg);
            break;
        case 'list_chats':
            await handleListChats(msg);
            break;
        case 'ping':
            sendToKoishi({ type: 'pong' });
            break;
        default:
            log(`Unknown message type: ${msg.type}`, 'warn');
    }
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

async function handleSendMessage(msg) {
    const context = getContext();
    const currentChatId = context.chatId;
    const needsSwitch = currentChatId !== msg.chatId;

    log(`Forwarding message from ${msg.senderName} via ${msg.sourceChannelKey}${needsSwitch ? ` (switching from ${currentChatId})` : ''}`);

    // Auto-switch to target chat if needed
    if (needsSwitch) {
        try {
            await switchToChat(msg.chatId);
            log(`Switched to chat: ${msg.chatId}`);
        } catch (e) {
            log(`Failed to switch chat: ${e.message}`, 'error');
            return;
        }
    }

    // Mark the source so we can tag the outgoing user_message
    pendingSourceChannelKey = msg.sourceChannelKey;

    try {
        await sendMessageAsUser(msg.text);
        await Generate('normal');
    } catch (e) {
        log(`Failed to send/generate: ${e.message}`, 'error');
    } finally {
        // pendingSourceChannelKey is consumed in onUserMessageRendered
        // but clear it here as a safety net after a delay
        setTimeout(() => {
            pendingSourceChannelKey = null;
        }, 5000);
    }

    // Switch back to original chat if we switched away
    if (needsSwitch && currentChatId) {
        try {
            await switchToChat(currentChatId);
            log(`Switched back to: ${currentChatId}`);
        } catch (e) {
            log(`Failed to switch back: ${e.message}`, 'warn');
        }
    }
}

async function handleSendFile(msg) {
    const context = getContext();
    const currentChatId = context.chatId;
    const needsSwitch = currentChatId !== msg.chatId;

    if (needsSwitch) {
        try {
            await switchToChat(msg.chatId);
        } catch (e) {
            log(`Failed to switch chat for file: ${e.message}`, 'error');
            return;
        }
    }

    log(`Forwarding file ${msg.file.name} from ${msg.senderName}`);

    pendingSourceChannelKey = msg.sourceChannelKey;

    try {
        // Upload via the ST file upload API (JSON body with base64 data)
        const headers = getRequestHeaders();

        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers,
            body: JSON.stringify({
                name: msg.file.name,
                data: `data:${msg.file.mimeType};base64,${msg.file.data}`,
            }),
        });

        if (!response.ok) {
            log(`File upload failed: ${response.status}`, 'error');
        } else {
            log(`File uploaded: ${msg.file.name}`);
        }
    } catch (e) {
        log(`Failed to upload file: ${e.message}`, 'error');
    } finally {
        setTimeout(() => {
            pendingSourceChannelKey = null;
        }, 5000);
    }
}

// ============================================================
// ST Event Handlers: ST → Koishi
// ============================================================

function onUserMessageRendered(messageId) {
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

    // Extract images from message if enabled
    if (settings.forwardImages) {
        content.images = extractImagesFromRenderedMessage(messageId);
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
}

function onCharacterMessageRendered(messageId) {
    const settings = getSettings();
    if (!settings.forwardAi || !isConnected) return;

    const context = getContext();
    const message = context.chat?.[messageId];
    if (!message) return;

    // Skip system messages and user messages
    if (message.is_system || message.is_user) return;

    lastAiMessageId = messageId;

    const content = {
        text: message.mes || '',
        images: [],
    };

    // Extract images from rendered message
    if (settings.forwardImages) {
        content.images = extractImagesFromRenderedMessage(messageId);
    }

    if (!content.text && content.images.length === 0) return;

    const sent = sendToKoishi({
        type: 'ai_message',
        chatId: getContext().chatId,
        characterName: context.name2,
        content,
        timestamp: Date.now(),
    });

    if (sent) {
        log(`Forwarded AI message (${content.text.substring(0, 50)}...)`);
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
// Image Extraction
// ============================================================

function extractImagesFromRenderedMessage(messageId) {
    const images = [];
    try {
        const mesElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
        if (!mesElement) return images;

        const imgElements = mesElement.querySelectorAll('.mes_text img');
        for (const img of imgElements) {
            const src = img.getAttribute('src') || '';
            if (src.startsWith('data:')) {
                // Already base64
                const match = src.match(/^data:(.*?);base64,(.*)$/);
                if (match) {
                    images.push({ data: match[2], mimeType: match[1] });
                }
            }
            // For URL images, we'd need to fetch them — skip for now to avoid complexity
            // TODO: fetch URL images and convert to base64
        }
    } catch (e) {
        log(`Image extraction error: ${e.message}`, 'warn');
    }
    return images;
}

// ============================================================
// TTS Audio Capture
// ============================================================

function setupTtsCapture() {
    // Watch for the #tts_audio element to appear
    const checkForTtsAudio = setInterval(() => {
        const audioEl = document.getElementById('tts_audio');
        if (!audioEl) return;

        clearInterval(checkForTtsAudio);
        log('TTS audio element detected, setting up capture');

        // Use MutationObserver to watch src attribute changes
        ttsObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type !== 'attributes' || mutation.attributeName !== 'src') continue;

                const settings = getSettings();
                if (!settings.forwardTts || !isConnected) continue;

                const el = mutation.target;
                const src = el.src;

                // Skip silence and empty
                if (!src || src.endsWith('silence.mp3') || src === '') continue;

                // Only capture after AI messages (not user STT)
                if (!lastAiMessageId) continue;

                if (src.startsWith('data:audio')) {
                    const match = src.match(/^data:(audio\/[^;]+);base64,(.*)$/);
                    if (match) {
                        sendToKoishi({
                            type: 'ai_tts',
                            chatId: getContext().chatId,
                            characterName: getContext().name2,
                            audio: match[2],
                            mimeType: match[1],
                            timestamp: Date.now(),
                        });
                        log('Forwarded AI TTS audio');
                    }
                }
                // Reset after capture to avoid double-sending
                lastAiMessageId = null;
            }
        });

        ttsObserver.observe(audioEl, {
            attributes: true,
            attributeFilter: ['src'],
        });
    }, 2000);
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

    if (wsUrlInput) wsUrlInput.value = settings.wsUrl;
    if (apiKeyInput) apiKeyInput.value = settings.apiKey;
    if (autoConnectInput) autoConnectInput.checked = settings.autoConnect;
    if (forwardUserInput) forwardUserInput.checked = settings.forwardUser;
    if (forwardAiInput) forwardAiInput.checked = settings.forwardAi;
    if (forwardTtsInput) forwardTtsInput.checked = settings.forwardTts;
    if (forwardImagesInput) forwardImagesInput.checked = settings.forwardImages;

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
    });

    // Settings loaded
    eventSource.on(event_types.SETTINGS_LOADED, () => {
        updateChatIdDisplay();
    });
}

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
