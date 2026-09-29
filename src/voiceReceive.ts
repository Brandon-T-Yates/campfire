import fs from 'node:fs';
import path from 'node:path';
import { OpusEncoder } from '@discordjs/opus';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  type AudioReceiveStream,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client } from 'discord.js';
import { WavWriter } from './wavWriter.js';

type ActiveBurst = {
  stream: AudioReceiveStream;
  decoder: OpusEncoder;
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
  speakers: Map<string, SpeakerRecording>;
  onStart: (userId: string) => void;
  onDisconnect: () => void;
};

const sessions = new Map<string, ReceiveSession>();

async function speakerLabel(client: Client, userId: string): Promise<string> {
  const cached = client.users.cache.get(userId);
  const user =
    cached ??
    (await client.users.fetch(userId).catch(() => null));
  const name = user?.username ?? 'unknown';
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

function stopBurst(speaker: SpeakerRecording) {
  if (!speaker.burst) {
    return;
  }
  const { stream } = speaker.burst;
  speaker.burst = null;
  stream.removeAllListeners();
  stream.destroy();
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
  console.log(`Session audio folder: ${savedAudioPath(sessionDir)}`);

  const onStart = (userId: string) => {
    let speaker = speakers.get(userId);
    if (!speaker) {
      speaker = {
        userId,
        writer: new WavWriter(path.join(sessionDir, `${userId}.wav`)),
        loggedRecording: false,
        burst: null,
        packetsReceived: 0,
        packetsDecoded: 0,
        decodeErrors: 0,
        pcmBytes: 0,
      };
      speakers.set(userId, speaker);
    }

    if (speaker.burst) {
      return;
    }

    const stream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1000,
      },
    });
    const decoder = new OpusEncoder(48_000, 2);
    speaker.burst = { stream, decoder };

    stream.on('data', (packet: Buffer) => {
      speaker.packetsReceived += 1;
      try {
        const pcm = decoder.decode(packet);
        speaker.packetsDecoded += 1;
        speaker.pcmBytes += pcm.length;
        if (!speaker.loggedRecording) {
          speaker.loggedRecording = true;
          void speakerLabel(client, userId).then((label) => {
            console.log(`Recording audio for: ${label}`);
          });
        }
        speaker.writer.writePcm(pcm);
      } catch (error) {
        speaker.decodeErrors += 1;
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
        stopBurst(speaker);
      }
    });
  };

  const onDisconnect = () => {
    void stopVoiceReceive(guildId);
  };

  connection.receiver.speaking.on('start', onStart);
  connection.on(VoiceConnectionStatus.Disconnected, onDisconnect);
  connection.on(VoiceConnectionStatus.Destroyed, onDisconnect);

  sessions.set(guildId, {
    client,
    connection,
    sessionDir,
    speakers,
    onStart,
    onDisconnect,
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
    stopBurst(speaker);
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
}
