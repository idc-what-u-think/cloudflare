import { Client, GatewayIntentBits, Collection, REST, Routes } from 'discord.js';

// Command Handler
class CommandHandler {
  constructor() {
    this.commands = new Collection();
  }

  async loadCommands() {
    // This will auto-load all commands from /commands folder
    // Note: In Cloudflare Workers, you'll need to manually import command files
    // For now, this is a placeholder structure
    console.log('Command handler initialized - Add commands manually or via bundler');
  }

  async handleCommand(interaction, env) {
    const command = this.commands.get(interaction.commandName);
    
    if (!command) {
      await interaction.reply({ content: 'Command not found!', ephemeral: true });
      return;
    }

    try {
      // Log command usage
      await this.logCommandUsage(interaction, env, true);
      
      // Execute command
      await command.execute(interaction, env);
    } catch (error) {
      console.error('Command execution error:', error);
      
      // Log command failure
      await this.logCommandUsage(interaction, env, false, error.message);
      
      const errorMessage = { content: 'There was an error executing this command!', ephemeral: true };
      
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(errorMessage);
      } else {
        await interaction.reply(errorMessage);
      }
    }
  }

  async logCommandUsage(interaction, env, success, errorMessage = null) {
    try {
      const id = `cmd_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const executionTime = Date.now() - interaction.createdTimestamp;
      
      await env.DB.prepare(
        `INSERT INTO command_usage (id, command_name, server_id, user_id, success, execution_time, error_message, used_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(
        id,
        interaction.commandName,
        interaction.guildId,
        interaction.user.id,
        success ? 1 : 0,
        executionTime,
        errorMessage
      ).run();
    } catch (error) {
      console.error('Failed to log command usage:', error);
    }
  }

  registerCommand(name, command) {
    this.commands.set(name, command);
  }
}

// Event Handler
class EventHandler {
  constructor(client, commandHandler, env) {
    this.client = client;
    this.commandHandler = commandHandler;
    this.env = env;
    this.setupEvents();
  }

  setupEvents() {
    // Ready Event
    this.client.once('ready', async () => {
      console.log(`✅ Bot logged in as ${this.client.user.tag}`);
      
      // Update bot stats
      await this.updateBotStats();
      
      // Set bot status
      this.client.user.setPresence({
        activities: [{ name: 'with Quantum Physics ⚛️', type: 0 }],
        status: 'online',
      });
    });

    // Interaction Create Event
    this.client.on('interactionCreate', async (interaction) => {
      if (interaction.isChatInputCommand()) {
        await this.commandHandler.handleCommand(interaction, this.env);
      }
    });

    // Guild Create Event (Bot joins server)
    this.client.on('guildCreate', async (guild) => {
      console.log(`✅ Joined new server: ${guild.name} (${guild.id})`);
      
      // Create server config
      await this.createServerConfig(guild);
      
      // Update bot stats
      await this.updateBotStats();
    });

    // Guild Delete Event (Bot leaves server)
    this.client.on('guildDelete', async (guild) => {
      console.log(`❌ Left server: ${guild.name} (${guild.id})`);
      
      // Update bot stats
      await this.updateBotStats();
    });

    // Message Create Event (for XP/leveling system)
    this.client.on('messageCreate', async (message) => {
      if (message.author.bot) return;
      if (!message.guild) return;

      // Check if leveling is enabled for this server
      const config = await this.getServerConfig(message.guild.id);
      if (!config || config.leveling_enabled === 0) return;

      // Award XP
      await this.awardXP(message);
    });

    // Error Handling
    this.client.on('error', (error) => {
      console.error('Discord client error:', error);
    });

    this.client.on('warn', (warning) => {
      console.warn('Discord client warning:', warning);
    });
  }

  async updateBotStats() {
    try {
      const id = 'main_stats';
      const totalServers = this.client.guilds.cache.size;
      const totalUsers = this.client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);

      await this.env.DB.prepare(
        `INSERT OR REPLACE INTO bot_stats (id, total_servers, total_users, last_restart, recorded_at)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
      ).bind(id, totalServers, totalUsers).run();
    } catch (error) {
      console.error('Failed to update bot stats:', error);
    }
  }

  async createServerConfig(guild) {
    try {
      await this.env.DB.prepare(
        `INSERT OR IGNORE INTO server_configs (server_id, server_name, created_at)
         VALUES (?, ?, CURRENT_TIMESTAMP)`
      ).bind(guild.id, guild.name).run();
    } catch (error) {
      console.error('Failed to create server config:', error);
    }
  }

  async getServerConfig(serverId) {
    try {
      const result = await this.env.DB.prepare(
        'SELECT * FROM server_configs WHERE server_id = ?'
      ).bind(serverId).first();
      
      return result;
    } catch (error) {
      console.error('Failed to get server config:', error);
      return null;
    }
  }

  async awardXP(message) {
    try {
      const userId = message.author.id;
      const serverId = message.guild.id;
      const xpToAward = Math.floor(Math.random() * 15) + 10; // 10-25 XP per message

      // Check cooldown (1 minute between XP gains)
      const existing = await this.env.DB.prepare(
        'SELECT * FROM user_levels WHERE user_id = ? AND server_id = ?'
      ).bind(userId, serverId).first();

      if (existing && existing.last_xp_gain) {
        const lastGain = new Date(existing.last_xp_gain).getTime();
        const now = Date.now();
        if (now - lastGain < 60000) return; // 1 minute cooldown
      }

      if (existing) {
        // Update existing
        const newXP = existing.xp + xpToAward;
        const newLevel = Math.floor(0.1 * Math.sqrt(newXP));
        const leveledUp = newLevel > existing.level;

        await this.env.DB.prepare(
          `UPDATE user_levels 
           SET xp = ?, level = ?, messages_sent = messages_sent + 1, last_xp_gain = CURRENT_TIMESTAMP
           WHERE user_id = ? AND server_id = ?`
        ).bind(newXP, newLevel, userId, serverId).run();

        if (leveledUp) {
          message.reply(`🎉 Congratulations ${message.author}! You've reached level **${newLevel}**!`);
        }
      } else {
        // Create new entry
        const id = `lvl_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        await this.env.DB.prepare(
          `INSERT INTO user_levels (id, user_id, server_id, xp, level, messages_sent, last_xp_gain)
           VALUES (?, ?, ?, ?, 0, 1, CURRENT_TIMESTAMP)`
        ).bind(id, userId, serverId, xpToAward).run();
      }
    } catch (error) {
      console.error('Failed to award XP:', error);
    }
  }
}

// Database utilities
class DatabaseUtils {
  constructor(db) {
    this.db = db;
  }

  async getServerConfig(serverId) {
    try {
      const result = await this.db.prepare(
        'SELECT * FROM server_configs WHERE server_id = ?'
      ).bind(serverId).first();
      return result;
    } catch (error) {
      console.error('Database error:', error);
      return null;
    }
  }

  async isBlacklisted(type, targetId) {
    try {
      const result = await this.db.prepare(
        'SELECT * FROM blacklist WHERE type = ? AND target_id = ?'
      ).bind(type, targetId).first();
      return !!result;
    } catch (error) {
      console.error('Database error:', error);
      return false;
    }
  }

  async getGlobalConfig(key) {
    try {
      const result = await this.db.prepare(
        'SELECT value FROM global_config WHERE key = ?'
      ).bind(key).first();
      return result ? result.value : null;
    } catch (error) {
      console.error('Database error:', error);
      return null;
    }
  }
}

// Main worker export
export default {
  async fetch(request, env, ctx) {
    return new Response('QuantumX Bot is running! 🚀', {
      headers: { 'content-type': 'text/plain' },
    });
  },

  async scheduled(event, env, ctx) {
    // This runs on scheduled triggers (cron jobs)
    console.log('Scheduled task triggered');
    
    // You can add periodic tasks here like:
    // - Update bot statistics
    // - Check giveaway winners
    // - Clean up old data
    // - Send reminders
  },

  async queue(batch, env, ctx) {
    // Handle queued messages if needed
    console.log('Queue handler triggered');
  }
};
