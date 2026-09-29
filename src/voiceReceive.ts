import {
  EndBehaviorType,
  VoiceConnectionStatus,
  type AudioReceiveStream,
  type VoiceConnection,
} from '@discordjs/voice';
import type { Client } from 'discord.js';

type SpeakerStats = {
  packets: number;
  bytes: number;
  loggedReceive: boolean;
  stream: AudioReceiveStream;
};

type ReceiveSession = {
  connection: VoiceConnection;
  speakers: Map<string, SpeakerStats>;
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

function closeSpeaker(speakers: Map<string, SpeakerStats>, userId: string) {
  const stats = speakers.get(userId);
  if (!stats) {
    return;
  }
  stats.stream.destroy();
  speakers.delete(userId);
}

export function startVoiceReceive(connection: VoiceConnection, client: Client) {
  const guildId = connection.joinConfig.guildId;
  stopVoiceReceive(guildId);

  const speakers = new Map<string, SpeakerStats>();

  const onStart = (userId: string) => {
    void speakerLabel(client, userId).then((label) => {
      console.log(`Speaker started: ${label}`);
    });

    if (speakers.has(userId)) {
      return;
    }

    const stream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 200,
      },
    });

    const stats: SpeakerStats = {
      packets: 0,
      bytes: 0,
      loggedReceive: false,
      stream,
    };
    speakers.set(userId, stats);

    stream.on('data', (chunk: Buffer) => {
      stats.packets += 1;
      stats.bytes += chunk.length;
      if (!stats.loggedReceive) {
        stats.loggedReceive = true;
        console.log(`Receiving audio from: ${userId}`);
      }
    });

    stream.once('end', () => {
      if (speakers.get(userId)?.stream === stream) {
        speakers.delete(userId);
      }
    });

    stream.on('error', (error: Error) => {
      console.error(`Audio stream error for ${userId}`, error);
    });
  };

  const onEnd = (userId: string) => {
    const stats = speakers.get(userId);
    if (stats) {
      console.log(`Packets received: ${stats.packets} (${stats.bytes} bytes)`);
    }
    void speakerLabel(client, userId).then((label) => {
      console.log(`Speaker stopped: ${label}`);
    });
    closeSpeaker(speakers, userId);
  };

  const onDisconnect = () => {
    stopVoiceReceive(guildId);
  };

  connection.receiver.speaking.on('start', onStart);
  connection.receiver.speaking.on('end', onEnd);
  connection.on(VoiceConnectionStatus.Disconnected, onDisconnect);
  connection.on(VoiceConnectionStatus.Destroyed, onDisconnect);

  sessions.set(guildId, {
    connection,
    speakers,
    onStart,
    onEnd,
    onDisconnect,
  });
}

export function stopVoiceReceive(guildId: string) {
  const session = sessions.get(guildId);
  if (!session) {
    return;
  }

  sessions.delete(guildId);

  session.connection.receiver.speaking.off('start', session.onStart);
  session.connection.receiver.speaking.off('end', session.onEnd);
  session.connection.off(VoiceConnectionStatus.Disconnected, session.onDisconnect);
  session.connection.off(VoiceConnectionStatus.Destroyed, session.onDisconnect);

  for (const userId of [...session.speakers.keys()]) {
    closeSpeaker(session.speakers, userId);
  }
}
