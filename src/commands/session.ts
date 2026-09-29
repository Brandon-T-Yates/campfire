import {
  ChannelType,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import {
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { startVoiceReceive, stopVoiceReceive } from '../voiceReceive.js';

export const session = {
  data: new SlashCommandBuilder()
    .setName('session')
    .setDescription('Start or stop a Campfire voice session.')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('Join your current voice channel.'),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName('stop').setDescription('Leave the voice channel.'),
    ),
  async execute(interaction: ChatInputCommandInteraction) {
    if (!interaction.inGuild() || !interaction.guildId) {
      await interaction.reply('This command only works in a server.');
      return;
    }

    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'start') {
      await startSession(interaction);
      return;
    }

    await stopSession(interaction);
  },
};

async function startSession(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId!;

  if (getVoiceConnection(guildId)) {
    await interaction.reply(
      'Campfire is already in a voice channel in this server.',
    );
    return;
  }

  const guild = await interaction.client.guilds.fetch(guildId);
  const member = await guild.members.fetch(interaction.user.id);

  const channel = member.voice.channel;
  if (
    !channel ||
    (channel.type !== ChannelType.GuildVoice &&
      channel.type !== ChannelType.GuildStageVoice)
  ) {
    await interaction.reply(
      'Join a voice channel first, then run `/session start`.',
    );
    return;
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (error) {
    connection.destroy();
    console.error('Failed to join voice channel', error);
    await interaction.reply('Campfire could not join the voice channel.');
    return;
  }

  startVoiceReceive(connection, interaction.client);
  await interaction.reply('🔥 Campfire is lit. Session started.');
}

async function stopSession(interaction: ChatInputCommandInteraction) {
  const connection = getVoiceConnection(interaction.guildId!);
  if (!connection) {
    await interaction.reply('Campfire is not in a voice channel.');
    return;
  }

  stopVoiceReceive(interaction.guildId!);
  connection.destroy();
  await interaction.reply('🔥 Campfire has gone quiet. Session ended.');
}
