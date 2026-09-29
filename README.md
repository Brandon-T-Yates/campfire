# Campfire

Private Discord bot for a small D&D group.

Later, Campfire is meant to join a voice channel, capture session audio, preserve speaker identity where possible, transcribe the session, generate an AI recap, and post that recap in Discord.

**This repo is only the bot foundation right now.** There is no voice capture, transcription, summarization, database, campaign memory, web UI, or SaaS layer.

## Current features

- Connects to Discord
- Registers slash commands on the configured guild at startup
- `/ping` replies `Pong!`

## Setup

1. Create an application and bot in the [Discord Developer Portal](https://discord.com/developers/applications).
2. Copy the bot token and application (client) ID.
3. Enable the bot and copy an invite URL with scopes `bot` and `applications.commands`. Invite it to your D&D server.
4. Copy the server (guild) ID (Discord Developer Mode → right-click the server → Copy Server ID).
5. Copy `.env.example` to `.env` and fill in the values:

```
DISCORD_TOKEN=
DISCORD_CLIENT_ID=
DISCORD_GUILD_ID=
```

6. Install and run:

```bash
npm install
npm run dev
```

Production-style run:

```bash
npm run build
npm start
```

After the bot is online, use `/ping` in the guild. Commands are registered for that guild only so they show up immediately.

## Layout

| File | Why it exists |
| --- | --- |
| `package.json` | Node project metadata, scripts, and dependencies (`discord.js`, `@discordjs/voice` for later, `dotenv`) |
| `tsconfig.json` | Strict TypeScript, ESM (`NodeNext`), compile `src` → `dist` |
| `.env.example` | Documents required secrets without committing them |
| `src/env.ts` | Loads `.env` and fails fast if a required variable is missing |
| `src/index.ts` | Creates the client, logs in, registers commands, handles interactions |
| `src/commands/ping.ts` | The `/ping` command |
| `src/commands/index.ts` | Explicit list of commands (add a file, then add it here) |

`@discordjs/voice` is listed as a dependency so the intended stack is in place. It is not used yet.
