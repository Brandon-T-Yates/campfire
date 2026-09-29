import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  type AudioReceiveStream,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client } from 'discord.js';
import { WavWriter } from './wavWriter.js';

const require = createRequire(import.meta.url);
const { OpusEncoder } = require('@discordjs/opus') as typeof import('@discordjs/opus');

type SpeechSegment = {
  userId: string;
  username: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  packetCount: number;
  decodeErrorCount: number;
  audioStartMs: number;
  audioEndMs: number;
};

type ActiveBurst = {
  stream: AudioReceiveStream;
  decoder: InstanceType<typeof OpusEncoder>;
  startMs: number;
  username: string;
  packetsReceived: number;
  decodeErrors: number;
  pcmStartBytes: number;
};

type SpeakerRecording = {
  userId: string;
  writer: WavWriter;
  loggedRecording: boolean;
  burst: ActiveBurst | null;
  packetsReceived: number;
  packetsDecoded: number;
  decodeErrors: number;
  pcmBytes: number;
};

type ReceiveSession = {
  client: Client;
  connection: VoiceConnection;
  sessionDir: string;
  sessionStartedAt: string;
  clockStartNs: bigint;
  speakers: Map<string, SpeakerRecording>;
  segments: SpeechSegment[];
  onStart: (userId: string) => void;
  onDisconnect: () => void;
};

const sessions = new Map<string, ReceiveSession>();

function elapsedMs(clockStartNs: bigint): number {
  return Number((process.hrtime.bigint() - clockStartNs) / 1_000_000n);
}

const PCM_BYTES_PER_MS = (48_000 * 2 * 2) / 1000;

function pcmBytesToAudioMs(bytes: number): number {
  return Math.round(bytes / PCM_BYTES_PER_MS);
}

async function speakerUsername(client: Client, userId: string): Promise<string> {
  const cached = client.users.cache.get(userId);
  const user =
    cached ??
    (await client.users.fetch(userId).catch(() => null));
  return user?.username ?? 'unknown';
}

async function speakerLabel(client: Client, userId: string): Promise<string> {
  const name = await speakerUsername(client, userId);
  return `${name} (${userId})`;
}

function createSessionFolder(): string {
  const tmpRoot = path.join(process.cwd(), 'tmp');
  fs.mkdirSync(tmpRoot, { recursive: true });

  const day = new Date().toISOString().slice(0, 10);
  const prefix = `session-${day}-`;
  let max = 0;
  for (const name of fs.readdirSync(tmpRoot)) {
    if (!name.startsWith(prefix)) {
      continue;
    }
    const suffix = name.slice(prefix.length);
    if (/^\d+$/.test(suffix)) {
      max = Math.max(max, Number(suffix));
    }
  }

  const folder = path.join(tmpRoot, `${prefix}${String(max + 1).padStart(3, '0')}`);
  fs.mkdirSync(folder);
  return folder;
}

function closeBurst(session: ReceiveSession, speaker: SpeakerRecording) {
  const burst = speaker.burst;
  if (!burst) {
    return;
  }
  speaker.burst = null;

  const endMs = elapsedMs(session.clockStartNs);
  session.segments.push({
    userId: speaker.userId,
    username: burst.username,
    startMs: burst.startMs,
    endMs,
    durationMs: Math.max(0, endMs - burst.startMs),
    packetCount: burst.packetsReceived,
    decodeErrorCount: burst.decodeErrors,
    audioStartMs: pcmBytesToAudioMs(burst.pcmStartBytes),
    audioEndMs: pcmBytesToAudioMs(speaker.pcmBytes),
  });

  burst.stream.removeAllListeners();
  burst.stream.destroy();
}

function savedAudioPath(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join('/');
}

function decodeSuccessPercent(speaker: SpeakerRecording): string {
  if (speaker.packetsReceived === 0) {
    return '100.0';
  }
  return ((speaker.packetsDecoded / speaker.packetsReceived) * 100).toFixed(1);
}

export function startVoiceReceive(connection: VoiceConnection, client: Client) {
  const guildId = connection.joinConfig.guildId;
  void stopVoiceReceive(guildId);

  const sessionDir = createSessionFolder();
  const speakers = new Map<string, SpeakerRecording>();
  const session: ReceiveSession = {
    client,
    connection,
    sessionDir,
    sessionStartedAt: new Date().toISOString(),
    clockStartNs: process.hrtime.bigint(),
    speakers,
    segments: [],
    onStart: (userId: string) => {
      void startBurst(session, userId);
    },
    onDisconnect: () => {
      void stopVoiceReceive(guildId);
    },
  };
  console.log(`Session audio folder: ${savedAudioPath(sessionDir)}`);

  connection.receiver.speaking.on('start', session.onStart);
  connection.on(VoiceConnectionStatus.Disconnected, session.onDisconnect);
  connection.on(VoiceConnectionStatus.Destroyed, session.onDisconnect);

  sessions.set(guildId, session);
}

async function startBurst(session: ReceiveSession, userId: string) {
  let speaker = session.speakers.get(userId);
  if (!speaker) {
    speaker = {
      userId,
      writer: new WavWriter(path.join(session.sessionDir, `${userId}.wav`)),
      loggedRecording: false,
      burst: null,
      packetsReceived: 0,
      packetsDecoded: 0,
      decodeErrors: 0,
      pcmBytes: 0,
    };
    session.speakers.set(userId, speaker);
  }

  if (speaker.burst) {
    return;
  }

  const stream = session.connection.receiver.subscribe(userId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1000,
    },
  });
  const decoder = new OpusEncoder(48_000, 2);
  const burst: ActiveBurst = {
    stream,
    decoder,
    startMs: elapsedMs(session.clockStartNs),
    username: 'unknown',
    packetsReceived: 0,
    decodeErrors: 0,
    pcmStartBytes: speaker.pcmBytes,
  };
  speaker.burst = burst;
  void speakerUsername(session.client, userId).then((username) => {
    burst.username = username;
  });

  stream.on('data', (packet: Buffer) => {
    speaker.packetsReceived += 1;
    burst.packetsReceived += 1;
    try {
      const pcm = burst.decoder.decode(packet);
      speaker.packetsDecoded += 1;
      speaker.pcmBytes += pcm.length;
      if (!speaker.loggedRecording) {
        speaker.loggedRecording = true;
        void speakerLabel(session.client, userId).then((label) => {
          console.log(`Recording audio for: ${label}`);
        });
      }
      speaker.writer.writePcm(pcm);
    } catch (error) {
      speaker.decodeErrors += 1;
      burst.decodeErrors += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `Dropped corrupt Opus packet for ${userId}: ${packet.length} bytes`,
      );
      console.warn(message);
    }
  });

  stream.on('error', (error: Error) => {
    console.error(`Audio stream error for ${userId}`, error);
  });

  stream.once('end', () => {
    if (speaker.burst?.stream === stream) {
      closeBurst(session, speaker);
    }
  });
}

export async function stopVoiceReceive(guildId: string) {
  const session = sessions.get(guildId);
  if (!session) {
    return;
  }

  sessions.delete(guildId);

  session.connection.receiver.speaking.off('start', session.onStart);
  session.connection.off(VoiceConnectionStatus.Disconnected, session.onDisconnect);
  session.connection.off(VoiceConnectionStatus.Destroyed, session.onDisconnect);

  const saved: string[] = [];
  for (const speaker of session.speakers.values()) {
    closeBurst(session, speaker);
    await speaker.writer.close();
    const label = await speakerLabel(session.client, speaker.userId);
    console.log(`Audio stats for ${label}:`);
    console.log(`Packets received: ${speaker.packetsReceived}`);
    console.log(`Packets decoded: ${speaker.packetsDecoded}`);
    console.log(`Decode errors: ${speaker.decodeErrors}`);
    console.log(`Decode success: ${decodeSuccessPercent(speaker)}%`);
    console.log(`PCM bytes written: ${speaker.pcmBytes}`);
    saved.push(savedAudioPath(speaker.writer.filePath));
  }

  for (const filePath of saved) {
    console.log(`Saved audio: ${filePath}`);
  }

  session.segments.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const manifestPath = path.join(session.sessionDir, 'manifest.json');
  const manifest = {
    sessionStartedAt: session.sessionStartedAt,
    segments: session.segments,
  };
  await fs.promises.writeFile(
    manifestPath,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(`Saved manifest: ${savedAudioPath(manifestPath)}`);
}
