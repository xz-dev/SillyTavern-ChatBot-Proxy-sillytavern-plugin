# SillyTavern Koishi Bridge

SillyTavern client extension that bridges chats to Koishi bot channels via WebSocket.

## Features

### Messaging
- **Bidirectional text messaging** — User messages and AI responses flow between SillyTavern and Koishi bot channels in real time
- **Auto chat switching** — Automatically switches to the target chat when receiving messages from a channel, then switches back after AI generation completes
- **Serial message queue** — Incoming messages are processed one at a time to prevent concurrent `Generate()` calls
- **Message queue on disconnect** — Outgoing messages are queued during WS disconnection and automatically flushed on reconnect
- **sourceChannelKey filtering** — Messages from a channel user are not echoed back to the originating channel

### Voice
- **Voice message STT** — Voice messages from channels are decoded, converted to WAV, and transcribed via the configured STT provider (Groq, OpenAI Whisper, etc.) using the Extension-Speech-Recognition pipeline
- **TTS audio forwarding** — Listens for `tts_audio_ready` events from the TTS extension and forwards AI-generated speech as voice messages to bound channels
- **TTS reply to text message** — Voice messages are sent as replies to the corresponding AI text message, so users can see which voice belongs to which text. Uses a per-channel `messageId → platformMsgId` cache (max 1000 entries)
- **TTS dedup** — Per-channel deduplication prevents the same TTS audio from being sent twice for the same message (MD5 hash comparison, max 500 entries per channel)

### Images & Files
- **AI image forwarding** — Extracts images from `message.extra.media` when `CHARACTER_MESSAGE_RENDERED` fires, fetches image data, and forwards to channels
- **Image receiving** — Images sent from channels are downloaded and injected into ST's file input
- **File attachments** — Non-audio files from channels are attached to the current ST chat via the file input, making them visible to the AI

### Bot Management
- **Bot avatar sync** — On `st.bind`, the bot's profile photo is automatically updated to match the SillyTavern character's avatar
- **Typing indicator** — Heartbeat-based typing indicator (2s interval) that auto-releases when the bot sends a message or generation ends
- **Chat ID validation** — Verifies chat existence before binding or switching (queries ST server API)

### Reliability
- **Error reporting** — ST reports errors back to Koishi via `send_message_result`, users see failure reasons in their channel
- **Auto reconnect WS** — Exponential backoff reconnection on WS disconnect (up to 30s max delay)
- **Auto reconnect API** — Automatically clicks the ST API Connect button when connection drops (configurable)
- **RFC 6455 ping/pong** — Protocol-level health checks with configurable interval (default 10s)
- **Settings persistence** — All configuration stored server-side in ST's `settings.json`

## SillyTavern Fork

This extension requires a forked version of SillyTavern with two patches applied on top of the `staging` branch. Both have been submitted as upstream PRs:

### TTS Event Signals ([PR #5309](https://github.com/SillyTavern/SillyTavern/pull/5309))

Adds event emissions to the TTS pipeline so extensions can receive audio data without intercepting `window.fetch`:

| Event | When | Payload |
|-------|------|---------|
| `tts_job_started` | TTS begins generating audio for a text segment | `{ messageId, characterName, text, voiceId }` |
| `tts_audio_ready` | An audio piece is ready (fires per chunk for async generators) | `{ messageId, characterName, text, audio: Blob, mimeType }` |
| `tts_job_complete` | All audio for a TTS job is generated | `{ messageId, characterName }` |

Also tracks `messageId` through the entire TTS pipeline (`_ttsMessageId` on job objects) so each audio piece can be associated with its source chat message.

### Streaming + Tool Call Fix ([PR #5308](https://github.com/SillyTavern/SillyTavern/pull/5308))

Fixes an upstream bug where `MESSAGE_RECEIVED` and `CHARACTER_MESSAGE_RENDERED` are never emitted for AI text messages that precede tool calls in streaming mode.

**The bug:** When AI returns text + tool_calls in a streaming response, `onFinishStreaming()` is skipped because the code exits via recursive `Generate()`. The text message is saved to chat and rendered in the DOM (by `onProgressStreaming` during streaming), but finalization events never fire.

**The fix:** Calls `onFinishStreaming()` for the text message before tool invocation when the message is kept (not deleted). This ensures all extensions (TTS, bridges, etc.) receive the event for every AI message.

### Setup

The fork is at [xz-dev/SillyTavern](https://github.com/xz-dev/SillyTavern) on the `staging` branch. To build with Docker/Podman:

```yaml
# compose.yml
services:
  sillytavern:
    build:
      context: https://github.com/xz-dev/SillyTavern.git#staging
```

## Installation

Install via SillyTavern's extension manager:

1. Open **Extensions** panel → click **Manage Extensions** (puzzle icon)
2. Paste the URL: `https://github.com/xz-dev/SillyTavern-ChatBot-Proxy-sillytavern-plugin`
3. Click **Install**
4. Reload the page

## Configuration

Open **Extensions** panel → expand **Koishi Bridge**:

| Setting | Description |
|---------|-------------|
| **WebSocket URL** | Koishi server WS endpoint (e.g. `ws://localhost:5140/st-proxy`) |
| **API Key** | Must match the Koishi plugin's configured API key |
| **Auto Connect on Load** | Automatically connect WS when the page loads |
| **Forward User Messages** | Forward user-sent messages to Koishi |
| **Forward AI Messages** | Forward AI responses to Koishi |
| **Forward AI TTS Audio** | Capture and forward TTS audio |
| **Forward Images** | Extract and forward inline images |
| **Forward Image Descriptions** | Include SD prompt text for image messages |
| **Auto Reconnect API** | Automatically reconnect ST's LLM API when connection drops |

The **Current Chat ID** field shows the active chat's identifier. Click to copy — use this with the `st.bind` command.

## Companion Plugin

This extension requires [koishi-plugin-sillytavern-bridge](https://github.com/xz-dev/SillyTavern-ChatBot-Proxy-koishi-plugin) installed in your Koishi instance.

### Koishi Commands

| Command | Description |
|---------|-------------|
| `st.bind <chatId>` | Bind the current channel to a SillyTavern chat (validates chatId, syncs bot avatar) |
| `st.unbind` | Unbind the current channel |
| `st.list` | List all available SillyTavern chats with message counts |
| `st.status` | Show bridge connection status, binding, and ping interval |
| `st.config ping <seconds>` | Set WS ping interval, 1-300s (persisted to `koishi.yml`) |
| `st.retry` | Retry the last failed message for the current channel |

## Architecture

```
SillyTavern (Browser)
  └─ Client Extension (sillytavern-plugin)
       ├─ Events:  USER_MESSAGE_RENDERED, CHARACTER_MESSAGE_RENDERED
       ├─ Events:  tts_audio_ready (from forked TTS extension)
       ├─ Events:  CHAT_CHANGED, SETTINGS_LOADED, ONLINE_STATUS_CHANGED
       ├─ Observe: body[data-generating] via MutationObserver
       ├─ Actions: sendMessageAsUser(), Generate(), switchToChat()
       ├─ STT:     transcribeAudio() → WAV conversion → STT provider API
       ├─ Files:   Inject into ST file input via DataTransfer API
       └─ WebSocket Client
              │
              │  JSON over WebSocket (binary data as base64)
              │  Health: RFC 6455 ping/pong frames
              │
       WebSocket Server
  └─ Koishi Plugin (koishi-plugin-sillytavern-bridge)
       ├─ Database:  st_bindings (SQLite)
       ├─ Commands:  st.bind / st.unbind / st.list / st.status / st.config / st.retry
       ├─ Cache:     msgIdCache (stMsgId → platformMsgId, for TTS reply targeting)
       ├─ Cache:     ttsDedup (messageId → audioHash, per-channel dedup)
       ├─ Typing:    Heartbeat-based, auto-released on sendMessage
       ├─ Avatar:    syncBotAvatar() on bind
       ├─ Transcode: ffmpeg OGG Opus conversion for TTS voice messages
       └─ Bot Adapters → Channels (Telegram, Discord, QQ, etc.)
```

### Message Flow

**Channel → SillyTavern:**
1. User sends text/image/voice/file in a bound channel
2. Koishi middleware extracts content (text, images, audio)
3. Forwards to ST via WS as `send_combined_message`
4. ST extension switches to the target chat (if needed)
5. For voice: STT transcription → text
6. For files: inject into ST file input
7. `sendMessageAsUser(text)` + `Generate()`
8. AI generates response
9. ST extension switches back to the original chat

**SillyTavern → Channels:**
1. `CHARACTER_MESSAGE_RENDERED` fires → `forwardCharacterMessage()` extracts text + images from `context.chat[messageId]`
2. `tts_audio_ready` fires → captures audio Blob, converts to base64
3. Sends `ai_message` / `ai_tts` to Koishi via WS (both include `messageId`)
4. Koishi broadcasts to all bound channels:
   - Text/images: `bot.sendMessage()`, caches `stMsgId → platformMsgId`
   - TTS: dedup check → transcode to OGG Opus → `h.quote(platformMsgId)` + `h('audio')` (reply to text message)
5. Originating channel is skipped for user messages (`sourceChannelKey` filtering)

## Protocol Messages

### ST → Koishi

| Type | Key Fields | Description |
|------|------------|-------------|
| `user_message` | `chatId`, `userName`, `content{text, images}`, `sourceChannelKey` | User sent a message in ST |
| `ai_message` | `chatId`, `characterName`, `messageId`, `content{text, images}` | AI finished generating a response |
| `ai_tts` | `chatId`, `characterName`, `messageId`, `audio`, `mimeType` | TTS audio captured for AI message |
| `generation_started` | `chatId`, `characterName` | AI generation began (also used as typing heartbeat) |
| `generation_ended` | `chatId` | AI generation completed |
| `validate_chat_result` | `requestId`, `valid`, `chatId`, `error` | Response to chat validation request |
| `list_chats_result` | `requestId`, `chats[]` | Response to list chats request |
| `get_avatar_result` | `requestId`, `avatar`, `mimeType` | Response to avatar request (base64) |
| `send_message_result` | `sourceChannelKey`, `success`, `error` | Error report when message handling fails |

### Koishi → ST

| Type | Key Fields | Description |
|------|------------|-------------|
| `send_combined_message` | `chatId`, `sourceChannelKey`, `senderName`, `text`, `files[]` | Forward channel message to ST |
| `validate_chat` | `requestId`, `chatId` | Request to validate a chatId |
| `list_chats` | `requestId` | Request list of all chats |
| `get_avatar` | `requestId`, `characterName` | Request character avatar image |
| `reload_page` | — | Force ST page reload |

## Requirements

- **SillyTavern**: [xz-dev/SillyTavern](https://github.com/xz-dev/SillyTavern) `staging` branch (fork with TTS events + streaming tool call fix)
- **Koishi**: 4.15.0+ with `database` (SQLite) and `server` plugins enabled
- **For voice STT**: [Extension-Speech-Recognition](https://github.com/SillyTavern/Extension-Speech-Recognition) with a configured provider (Groq, OpenAI Whisper, etc.)
- **For TTS forwarding**: TTS extension enabled with a configured provider (ElevenLabs, Edge, etc.)
- **For TTS transcoding**: `ffmpeg` available in the Koishi environment (for OGG Opus conversion)
