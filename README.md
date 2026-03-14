# SillyTavern Koishi Bridge

SillyTavern client extension that bridges chats to Koishi bot channels via WebSocket.

## Features

- **Bidirectional messaging** — User messages and AI responses flow between SillyTavern and Koishi bot channels in real time
- **Auto chat switching** — Automatically switches to the target chat when receiving messages from a channel, then switches back to the original chat after AI generation completes
- **Chat ID validation** — Verifies chat existence before binding or switching (queries ST server API)
- **TTS audio forwarding** — Captures AI-generated TTS audio from the `#tts_audio` element and forwards to bound channels
- **Image forwarding** — Extracts inline images from rendered messages and forwards as base64
- **Message queue** — Messages are queued during WS disconnection and automatically flushed on reconnect (unlimited queue, no expiry)
- **Error reporting** — ST reports errors back to Koishi via `send_message_result`, so users see failure reasons in their channel
- **Auto reconnect** — Exponential backoff reconnection on WS disconnect (up to 30s max delay)
- **RFC 6455 ping/pong** — Protocol-level health checks with configurable interval (default 10s). Dead connections are detected and terminated within 2 ping cycles
- **Settings persistence** — All configuration stored server-side in ST's `settings.json` (survives browser restart)
- **sourceChannelKey filtering** — When a channel user sends a message that triggers an AI response, the user's own message is not echoed back to the originating channel

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

The **Current Chat ID** field shows the active chat's identifier. Click to select the text for easy copying — use this with the `st.bind` command.

## Companion Plugin

This extension requires [koishi-plugin-sillytavern-bridge](https://github.com/xz-dev/SillyTavern-ChatBot-Proxy-koishi-plugin) installed in your Koishi instance.

### Koishi Commands

| Command | Description |
|---------|-------------|
| `st.bind <chatId>` | Bind the current channel to a SillyTavern chat (validates chatId exists) |
| `st.unbind` | Unbind the current channel |
| `st.list` | List all available SillyTavern chats with message counts |
| `st.status` | Show bridge connection status and current binding |
| `st.config ping <seconds>` | Set WS ping interval, 1-300s (persisted to `koishi.yml`) |

## Architecture

```
SillyTavern (Browser)
  └─ Client Extension
       ├─ Monitors: USER_MESSAGE_RENDERED, CHARACTER_MESSAGE_RENDERED, TTS audio
       ├─ Actions:  sendMessageAsUser(), Generate(), switchToChat()
       └─ WebSocket Client
              │
              │  JSON over WebSocket (binary data as base64)
              │  Health: RFC 6455 ping/pong frames
              │
       WebSocket Server
  └─ Koishi Plugin
       ├─ Database: st_bindings (SQLite)
       ├─ Commands: st.bind / st.unbind / st.list / st.status / st.config
       ├─ Middleware: commands consumed before forwarding logic
       └─ Bot Adapters → Channels (Discord, Telegram, QQ, etc.)
```

### Message Flow

**Channel → SillyTavern:**
1. User sends message in a bound channel
2. Koishi middleware forwards text/images to ST via WS `send_message`
3. ST extension switches to the target chat (if needed)
4. Calls `sendMessageAsUser()` + `Generate()`
5. AI generates response
6. ST extension switches back to the original chat

**SillyTavern → Channels:**
1. ST extension captures user/AI message via event listeners
2. Sends `user_message` / `ai_message` / `ai_tts` to Koishi via WS
3. Koishi broadcasts to all channels bound to that chatId
4. Originating channel is skipped for user messages (sourceChannelKey filtering)

## Protocol Messages

### ST → Koishi (upstream)

| Type | Description |
|------|-------------|
| `user_message` | User sent a message in ST |
| `ai_message` | AI finished generating a response |
| `ai_tts` | TTS audio captured for AI message |
| `generation_started` | AI generation began |
| `generation_ended` | AI generation completed |
| `validate_chat_result` | Response to chat validation request |
| `list_chats_result` | Response to list chats request |
| `send_message_result` | Error report when message handling fails |

### Koishi → ST (downstream)

| Type | Description |
|------|-------------|
| `send_message` | Forward channel text message to ST |
| `send_file` | Forward channel file/image to ST |
| `validate_chat` | Request to validate a chatId |
| `list_chats` | Request list of all chats |

## Requirements

- SillyTavern 1.16.0+
- Koishi 4.15.0+ with `database` (SQLite) and `server` plugins enabled
