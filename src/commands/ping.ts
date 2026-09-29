import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

export const ping = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check that the bot is responding.'),
  async execute(interaction: ChatInputCommandInteraction) {
    await interaction.reply('Pong!');
  },
};
