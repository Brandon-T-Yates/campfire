import fs from 'node:fs';
import path from 'node:path';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  type AudioReceiveStream,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client } from 'discord.js';
import prism from 'prism-media';
import { WavWriter } from './wavWriter.js';

type ActiveBurst = {
  stream: AudioReceiveStream;
  decoder: prism.opus.Decoder;
};

type SpeakerRecording = {
  writer: WavWriter;
  loggedRecording: boolean;
  burst: ActiveBurst | null;
};

type ReceiveSession = {
  connection: VoiceConnection;
  sessionDir: string;
  speakers: Map<string, SpeakerRecording>;
  onStart: (userId: string) => void;
  onEnd: (userId: string) => void;
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
  const { stream, decoder } = speaker.burst;
  speaker.burst = null;
  stream.unpipe(decoder);
  decoder.removeAllListeners();
  stream.removeAllListeners();
  stream.destroy();
  decoder.destroy();
}

function savedAudioPath(filePath: string): string {
  return path.relative(process.cwd(), filePath).split(path.sep).join('/');
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
        writer: new WavWriter(path.join(sessionDir, `${userId}.wav`)),
        loggedRecording: false,
        burst: null,
      };
      speakers.set(userId, speaker);
    }

    if (speaker.burst) {
      return;
    }

    const stream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 200,
      },
    });
    const decoder = new prism.opus.Decoder({
      frameSize: 960,
      channels: 2,
      rate: 48_000,
    });
    speaker.burst = { stream, decoder };

    decoder.on('data', (pcm: Buffer) => {
      if (!speaker.loggedRecording) {
        speaker.loggedRecording = true;
        void speakerLabel(client, userId).then((label) => {
          console.log(`Recording audio for: ${label}`);
        });
      }
      speaker.writer.writePcm(pcm);
    });

    decoder.on('error', (error: Error) => {
      console.error(`Opus decode error for ${userId}`, error);
    });

    stream.on('error', (error: Error) => {
      console.error(`Audio stream error for ${userId}`, error);
    });

    stream.once('end', () => {
      if (speaker.burst?.stream === stream) {
        stopBurst(speaker);
      }
    });

    stream.pipe(decoder);
  };

  const onEnd = (userId: string) => {
    const speaker = speakers.get(userId);
    if (speaker) {
      stopBurst(speaker);
    }
  };

  const onDisconnect = () => {
    void stopVoiceReceive(guildId);
  };

  connection.receiver.speaking.on('start', onStart);
  connection.receiver.speaking.on('end', onEnd);
  connection.on(VoiceConnectionStatus.Disconnected, onDisconnect);
  connection.on(VoiceConnectionStatus.Destroyed, onDisconnect);

  sessions.set(guildId, {
    connection,
    sessionDir,
    speakers,
    onStart,
    onEnd,
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
  session.connection.receiver.speaking.off('end', session.onEnd);
  session.connection.off(VoiceConnectionStatus.Disconnected, session.onDisconnect);
  session.connection.off(VoiceConnectionStatus.Destroyed, session.onDisconnect);

  const saved: string[] = [];
  for (const speaker of session.speakers.values()) {
    stopBurst(speaker);
    await speaker.writer.close();
    saved.push(savedAudioPath(speaker.writer.filePath));
  }

  for (const filePath of saved) {
    console.log(`Saved audio: ${filePath}`);
  }
}
