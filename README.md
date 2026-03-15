# SillyTavern Koishi Bridge

SillyTavern client extension that bridges chats to Koishi bot channels via WebSocket.

## Features

### Messaging
- **Bidirectional text messaging** — User messages and AI responses flow between SillyTavern and Koishi bot channels in real time
- **Auto chat switching** — Automatically switches to the target chat when receiving messages from a channel, then switches back to the original chat after AI generation completes
- **Serial message queue** — Incoming messages are processed one at a time to prevent concurrent `Generate()` calls
- **Message queue on disconnect** — Outgoing messages are queued during WS disconnection and automatically flushed on reconnect (unlimited queue, no expiry)
- **sourceChannelKey filtering** — When a channel user sends a message, the user's own message is not echoed back to the originating channel

### Voice
- **Voice message STT** — Voice messages from Telegram are downloaded, converted to WAV, and transcribed via the configured STT provider (Groq, OpenAI Whisper, etc.) using the Extension-Speech-Recognition pipeline
- **TTS audio forwarding** — Captures AI-generated TTS audio and forwards as Telegram voice messages (green bubble) via `sendVoice` API, with generic `h('audio')` fallback for other platforms

### Images & Files
- **AI image forwarding** — MutationObserver detects SD-generated images inserted into AI messages after render, fetches and forwards as Telegram photos with caption via `sendPhoto` API
- **Image receiving** — Images sent from channels are downloaded and forwarded to ST
- **File attachments** — Non-audio files from channels are attached to the current ST chat via `uploadFileAttachmentToServer()`, making them visible to the AI

### Bot Management
- **Bot avatar sync** — On `st.bind`, the bot's profile photo is automatically updated to match the SillyTavern character's avatar (Telegram `setMyProfilePhoto` / Discord `modifyCurrentUser`)
- **Typing indicator** — Promise-lock based typing indicator that auto-releases when the bot sends any message. Keeps typing alive with 4s refresh interval for Telegram's 5s expiry
- **Chat ID validation** — Verifies chat existence before binding or switching (queries ST server API)

### Reliability
- **Error reporting** — ST reports errors back to Koishi via `send_message_result`, users see failure reasons in their channel with `Use st.retry to retry.`
- **Auto reconnect WS** — Exponential backoff reconnection on WS disconnect (up to 30s max delay)
- **Auto reconnect API** — Automatically clicks the ST API Connect button when connection drops (configurable toggle, default on)
- **RFC 6455 ping/pong** — Protocol-level health checks with configurable interval (default 10s). Dead connections detected and terminated within 2 ping cycles
- **Settings persistence** — All configuration stored server-side in ST's `settings.json` (survives browser restart)

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
| **Auto Reconnect API** | Automatically reconnect ST's LLM API when connection drops |

The **Current Chat ID** field shows the active chat's identifier. Click to select the text for easy copying — use this with the `st.bind` command.

## Companion Plugin

This extension requires [koishi-plugin-sillytavern-bridge](https://github.com/xz-dev/SillyTavern-ChatBot-Proxy-koishi-plugin) installed in your Koishi instance.

### Koishi Commands

| Command | Description |
|---------|-------------|
| `st.bind <chatId>` | Bind the current channel to a SillyTavern chat (validates chatId exists, syncs bot avatar) |
| `st.unbind` | Unbind the current channel |
| `st.list` | List all available SillyTavern chats with message counts |
| `st.status` | Show bridge connection status, binding, and ping interval |
| `st.config ping <seconds>` | Set WS ping interval, 1-300s (persisted to `koishi.yml`) |
| `st.retry` | Retry the last failed message for the current channel |

## Architecture

```
SillyTavern (Browser)
  └─ Client Extension
       ├─ Monitors: USER_MESSAGE_RENDERED, CHARACTER_MESSAGE_RENDERED
       ├─ Monitors: TTS audio (MutationObserver on #tts_audio)
       ├─ Monitors: SD images (MutationObserver on .mes img.mes_img)
       ├─ Actions:  sendMessageAsUser(), Generate(), switchToChat()
       ├─ STT:      transcribeAudio() → WAV conversion → STT provider API
       ├─ Files:    uploadFileAttachmentToServer() for non-audio attachments
       └─ WebSocket Client
              │
              │  JSON over WebSocket (binary data as base64)
              │  Health: RFC 6455 ping/pong frames
              │
       WebSocket Server
  └─ Koishi Plugin
       ├─ Database: st_bindings (SQLite)
       ├─ Commands: st.bind / st.unbind / st.list / st.status / st.config / st.retry
       ├─ Middleware: commands consumed by next() before forwarding logic
       ├─ Typing: Promise-lock pattern, auto-released on bot.sendMessage
       ├─ Avatar: syncBotAvatar() on bind (Telegram setMyProfilePhoto, Discord modifyCurrentUser)
       └─ Bot Adapters → Channels (Discord, Telegram, QQ, etc.)
```

### Message Flow

**Channel → SillyTavern:**
1. User sends text/image/voice/file in a bound channel
2. Koishi middleware extracts content (text, images via `ctx.http`, audio via Telegram Bot API `getFile`)
3. Forwards to ST via WS as `send_message` (text) or `send_file` (media)
4. ST extension switches to the target chat (if needed)
5. For audio files: STT transcription → `sendMessageAsUser(transcribedText)` + `Generate()`
6. For other files: `uploadFileAttachmentToServer()` to attach to chat
7. For text: `sendMessageAsUser(text)` + `Generate()`
8. AI generates response
9. ST extension switches back to the original chat

**SillyTavern → Channels:**
1. ST extension captures user/AI message via event listeners
2. MutationObserver detects SD-generated images inserted after render
3. Sends `user_message` / `ai_message` / `ai_tts` to Koishi via WS
4. Koishi broadcasts to all channels bound to that chatId:
   - Text: via `sendToChannel()` (releases typing lock automatically)
   - Images: via Telegram `sendPhoto` with caption / generic `h('image')` for others
   - TTS: via Telegram `sendVoice` (voice bubble) / generic `h('audio')` for others
5. Originating channel is skipped for user messages (sourceChannelKey filtering)

## Protocol Messages

### ST → Koishi (upstream)

| Type | Description |
|------|-------------|
| `user_message` | User sent a message in ST (text + optional images) |
| `ai_message` | AI finished generating a response (text + optional images) |
| `ai_tts` | TTS audio captured for AI message (base64 audio) |
| `generation_started` | AI generation began |
| `generation_ended` | AI generation completed |
| `validate_chat_result` | Response to chat validation request |
| `list_chats_result` | Response to list chats request |
| `get_avatar_result` | Response to avatar request (base64 image) |
| `send_message_result` | Error report when message handling fails |

### Koishi → ST (downstream)

| Type | Description |
|------|-------------|
| `send_message` | Forward channel text message to ST |
| `send_file` | Forward channel file/image/audio to ST |
| `validate_chat` | Request to validate a chatId |
| `list_chats` | Request list of all chats |
| `get_avatar` | Request character avatar image |

## Requirements

- SillyTavern 1.16.0+
- Koishi 4.15.0+ with `database` (SQLite) and `server` plugins enabled
- For voice STT: [Extension-Speech-Recognition](https://github.com/SillyTavern/Extension-Speech-Recognition) installed with a configured provider (Groq, OpenAI Whisper, etc.)
- For TTS forwarding: TTS extension enabled with a configured provider (ElevenLabs, etc.)
