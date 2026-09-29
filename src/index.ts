import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
} from 'discord.js';
import { commands } from './commands/index.js';
import { env } from './env.js';

const commandByName = new Map(commands.map((command) => [command.data.name, command]));

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    return;
  }

  const command = commandByName.get(interaction.commandName);
  if (!command) {
    return;
  }

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`Error running /${interaction.commandName}`, error);
    const reply = { content: 'Something went wrong running that command.' };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

const rest = new REST().setToken(env.discordToken);
await rest.put(
  Routes.applicationGuildCommands(env.discordClientId, env.discordGuildId),
  { body: commands.map((command) => command.data.toJSON()) },
);
console.log('Registered guild slash commands.');

await client.login(env.discordToken);
