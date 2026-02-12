/**
 * Bass Tournament Discord Bot
 * Features:
 * - /setup sets review + leaderboard + results channels
 * - /start_tournament name: starts a new active tournament (auto-ends any prior active one)
 * - /end_tournament: ends active tournament, snapshots results, posts FINAL standings to results channel
 * - /weighin pounds photo notes: submits weigh-in (requires active tournament), admin approves/rejects via buttons
 * - Big Bass + Total Bag (Top 5) leaderboards per tournament
 * - /month_leaderboard (YYYY-MM optional): monthly standings (sum of bags + best big bass) from finalized tournaments
 * - /year_leaderboard: yearly standings (sum of bags + best big bass) from finalized tournaments
 *
 * Requirements:
 * - Node.js 18+
 * - discord.js v14
 * - sqlite3
 * - dotenv
 *
 * .env:
 * DISCORD_TOKEN=...
 * CLIENT_ID=... (Application ID)
 * GUILD_ID=...  (Server ID)
 */

require("dotenv").config();

const sqlite3 = require("sqlite3").verbose();
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

// -------------------- ENV CHECK --------------------
const REQUIRED_ENVS = ["DISCORD_TOKEN", "CLIENT_ID", "GUILD_ID"];
for (const key of REQUIRED_ENVS) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

// -------------------- DB SETUP --------------------
const db = new sqlite3.Database("/data/tournament.sqlite");

function safeAlter(sql) {
  db.run(sql, () => {
    // ignore errors (e.g., column already exists)
  });
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      guild_id TEXT PRIMARY KEY,
      review_channel_id TEXT,
      leaderboard_channel_id TEXT,
      results_channel_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS weighins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      weight_lbs REAL NOT NULL,
      photo_url TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tournaments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      name TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tournament_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      tournament_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      big_bass REAL NOT NULL DEFAULT 0,
      total_bag REAL NOT NULL DEFAULT 0,
      fish_count INTEGER NOT NULL DEFAULT 0,
      bag_rank INTEGER,
      big_rank INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tournament_id, user_id)
    )
  `);

  // migrations
  safeAlter(`ALTER TABLE weighins ADD COLUMN tournament_id INTEGER`);
  safeAlter(`ALTER TABLE config ADD COLUMN results_channel_id TEXT`);
});

// -------------------- DISCORD CLIENT --------------------
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  partials: [Partials.Channel],
});

// -------------------- SLASH COMMANDS --------------------
const slashCommands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Set channels for review, leaderboard updates, and final results")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addChannelOption((o) =>
      o.setName("review_channel").setDescription("Where weigh-ins go for admin approval").setRequired(true)
    )
    .addChannelOption((o) =>
      o.setName("leaderboard_channel").setDescription("Where leaderboard updates post").setRequired(true)
    )
    .addChannelOption((o) =>
      o.setName("results_channel").setDescription("Where FINAL standings post on /end_tournament").setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("start_tournament")
    .setDescription("Start a new tournament (sets active flag; new event = clean board)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption((o) => o.setName("name").setDescription("Tournament name").setRequired(true)),

  new SlashCommandBuilder()
    .setName("end_tournament")
    .setDescription("End the active tournament (locks submissions and posts final standings)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  new SlashCommandBuilder()
    .setName("weighin")
    .setDescription("Submit a weigh-in (photo required, active tournament required)")
    .addNumberOption((o) =>
      o.setName("pounds").setDescription("Weight in pounds (e.g., 5.62)").setRequired(true).setMinValue(0.01)
    )
    .addAttachmentOption((o) => o.setName("photo").setDescription("Weigh-in photo").setRequired(true))
    .addStringOption((o) => o.setName("notes").setDescription("Optional notes").setRequired(false)),

  new SlashCommandBuilder()
    .setName("bigbass")
    .setDescription("Show Big Bass leaderboard (best single fish)"),

  new SlashCommandBuilder()
    .setName("totalbag")
    .setDescription("Show Total Bag leaderboard (top 5 fish total)"),

  new SlashCommandBuilder()
    .setName("month_leaderboard")
    .setDescription("Overall leaderboard for a month (sum of tournament bags + best big bass)")
    .addStringOption((o) =>
      o
        .setName("month")
        .setDescription("Month in YYYY-MM (example: 2026-02). Leave blank for current month.")
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName("year_leaderboard")
    .setDescription("Overall leaderboard for the year (sum of tournament bags + best big bass)"),

  new SlashCommandBuilder()
    .setName("reset_tournament_data")
    .setDescription("DANGER: Clears all weigh-ins + tournaments + results for this server")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID), {
    body: slashCommands,
  });
  console.log("Slash commands registered for the guild.");
}

// -------------------- DB HELPERS --------------------
function getConfig(guildId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM config WHERE guild_id = ?`, [guildId], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function upsertConfig(guildId, reviewChannelId, leaderboardChannelId, resultsChannelId) {
  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO config (guild_id, review_channel_id, leaderboard_channel_id, results_channel_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        review_channel_id=excluded.review_channel_id,
        leaderboard_channel_id=excluded.leaderboard_channel_id,
        results_channel_id=excluded.results_channel_id
      `,
      [guildId, reviewChannelId, leaderboardChannelId, resultsChannelId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getActiveTournament(guildId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM tournaments WHERE guild_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1`,
      [guildId],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
}

function startTournament(guildId, name) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        `UPDATE tournaments
         SET is_active = 0, ended_at = COALESCE(ended_at, datetime('now'))
         WHERE guild_id = ? AND is_active = 1`,
        [guildId]
      );

      db.run(`INSERT INTO tournaments (guild_id, name, is_active) VALUES (?, ?, 1)`, [guildId, name], function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      });
    });
  });
}

function endTournament(guildId, tournamentId) {
  return new Promise((resolve, reject) => {
    db.run(
      `UPDATE tournaments
       SET is_active = 0, ended_at = datetime('now')
       WHERE guild_id = ? AND id = ?`,
      [guildId, tournamentId],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function insertWeighIn({ guildId, userId, tournamentId, weightLbs, photoUrl, notes }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO weighins (guild_id, user_id, tournament_id, weight_lbs, photo_url, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [guildId, userId, tournamentId, weightLbs, photoUrl, notes || null],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function setWeighInStatus(id, status) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE weighins SET status = ? WHERE id = ?`, [status, id], (err) =>
      err ? reject(err) : resolve()
    );
  });
}

function formatLb(weight) {
  return Number(weight || 0).toFixed(2);
}

// -------------------- LEADERBOARD QUERIES --------------------
// Note: Total Bag uses a window function (ROW_NUMBER). Modern SQLite supports this.
// If your environment has an old SQLite build and errors here, tell me and I’ll swap a fallback query.

function getBigBassLeaderboard(guildId, tournamentId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT user_id, MAX(weight_lbs) AS big_bass
      FROM weighins
      WHERE guild_id = ? AND tournament_id = ? AND status = 'approved'
      GROUP BY user_id
      ORDER BY big_bass DESC
      LIMIT 25
      `,
      [guildId, tournamentId],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function getTotalBagLeaderboard(guildId, tournamentId) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      WITH ranked AS (
        SELECT
          user_id,
          weight_lbs,
          ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY weight_lbs DESC) AS rn
        FROM weighins
        WHERE guild_id = ? AND tournament_id = ? AND status = 'approved'
      )
      SELECT
        user_id,
        SUM(weight_lbs) AS total_bag,
        COUNT(*) AS fish_count
      FROM ranked
      WHERE rn <= 5
      GROUP BY user_id
      ORDER BY total_bag DESC
      LIMIT 25
      `,
      [guildId, tournamentId],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

async function postLeaderboards(guild, leaderboardChannelId, tournamentId, tournamentName) {
  const big = await getBigBassLeaderboard(guild.id, tournamentId);
  const bag = await getTotalBagLeaderboard(guild.id, tournamentId);

  const bigEmbed = new EmbedBuilder()
    .setTitle(`🏆 Big Bass — ${tournamentName}`)
    .setDescription(
      big.length
        ? big.map((r, i) => `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.big_bass)} lbs**`).join("\n")
        : "No approved weigh-ins yet."
    )
    .setTimestamp(new Date());

  const bagEmbed = new EmbedBuilder()
    .setTitle(`🎣 Total Bag (Top 5) — ${tournamentName}`)
    .setDescription(
      bag.length
        ? bag
            .map(
              (r, i) =>
                `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.total_bag)} lbs** *(top ${r.fish_count} fish)*`
            )
            .join("\n")
        : "No approved weigh-ins yet."
    )
    .setTimestamp(new Date());

  const channel = await guild.channels.fetch(leaderboardChannelId);
  if (channel) {
    await channel.send({ embeds: [bigEmbed] });
    await channel.send({ embeds: [bagEmbed] });
  }
}

async function postFinalStandings(guild, resultsChannelId, tournamentId, tournamentName) {
  const big = await getBigBassLeaderboard(guild.id, tournamentId);
  const bag = await getTotalBagLeaderboard(guild.id, tournamentId);

  const header = new EmbedBuilder()
    .setTitle(`✅ FINAL RESULTS — ${tournamentName}`)
    .setDescription("Tournament ended. Submissions are now locked.")
    .setTimestamp(new Date());

  const bigEmbed = new EmbedBuilder()
    .setTitle("🏆 Big Bass (Final)")
    .setDescription(
      big.length
        ? big.map((r, i) => `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.big_bass)} lbs**`).join("\n")
        : "No approved weigh-ins."
    );

  const bagEmbed = new EmbedBuilder()
    .setTitle("🎣 Total Bag (Top 5) — Final")
    .setDescription(
      bag.length
        ? bag
            .map(
              (r, i) =>
                `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.total_bag)} lbs** *(top ${r.fish_count} fish)*`
            )
            .join("\n")
        : "No approved weigh-ins."
    );

  const channel = await guild.channels.fetch(resultsChannelId);
  if (channel) {
    await channel.send({ embeds: [header] });
    await channel.send({ embeds: [bigEmbed] });
    await channel.send({ embeds: [bagEmbed] });
  }
}

// -------------------- SNAPSHOT RESULTS (for year/month stats) --------------------
async function snapshotTournamentResults(guildId, tournamentId) {
  const big = await getBigBassLeaderboard(guildId, tournamentId);
  const bag = await getTotalBagLeaderboard(guildId, tournamentId);

  const bigRank = new Map(big.map((r, i) => [r.user_id, i + 1]));
  const bagRank = new Map(bag.map((r, i) => [r.user_id, i + 1]));

  const users = new Set([...big.map((r) => r.user_id), ...bag.map((r) => r.user_id)]);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO tournament_results (guild_id, tournament_id, user_id, big_bass, total_bag, fish_count, bag_rank, big_rank)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(tournament_id, user_id) DO UPDATE SET
          big_bass=excluded.big_bass,
          total_bag=excluded.total_bag,
          fish_count=excluded.fish_count,
          bag_rank=excluded.bag_rank,
          big_rank=excluded.big_rank
      `);

      for (const userId of users) {
        const bigRow = big.find((r) => r.user_id === userId);
        const bagRow = bag.find((r) => r.user_id === userId);

        stmt.run([
          guildId,
          tournamentId,
          userId,
          bigRow?.big_bass ?? 0,
          bagRow?.total_bag ?? 0,
          bagRow?.fish_count ?? 0,
          bagRank.get(userId) ?? null,
          bigRank.get(userId) ?? null,
        ]);
      }

      stmt.finalize((err) => (err ? reject(err) : resolve()));
    });
  });
}

// -------------------- YEAR / MONTH LEADERBOARDS --------------------
function getYearLeaderboard(guildId, yyyy) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        tr.user_id,
        SUM(tr.total_bag) AS year_total_bag,
        MAX(tr.big_bass) AS year_big_bass,
        COUNT(DISTINCT tr.tournament_id) AS tournaments_count
      FROM tournament_results tr
      JOIN tournaments t ON t.id = tr.tournament_id
      WHERE tr.guild_id = ?
        AND t.ended_at IS NOT NULL
        AND strftime('%Y', t.ended_at) = ?
      GROUP BY tr.user_id
      ORDER BY year_total_bag DESC, year_big_bass DESC
      LIMIT 25
      `,
      [guildId, String(yyyy)],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

function getMonthLeaderboard(guildId, yyyyMm) {
  return new Promise((resolve, reject) => {
    db.all(
      `
      SELECT
        tr.user_id,
        SUM(tr.total_bag) AS month_total_bag,
        MAX(tr.big_bass) AS month_big_bass,
        COUNT(DISTINCT tr.tournament_id) AS tournaments_count
      FROM tournament_results tr
      JOIN tournaments t ON t.id = tr.tournament_id
      WHERE tr.guild_id = ?
        AND t.ended_at IS NOT NULL
        AND strftime('%Y-%m', t.ended_at) = ?
      GROUP BY tr.user_id
      ORDER BY month_total_bag DESC, month_big_bass DESC
      LIMIT 25
      `,
      [guildId, yyyyMm],
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });
}

// -------------------- DISCORD EVENTS --------------------
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("Failed to register commands:", e);
  }
});

client.on("interactionCreate", async (interaction) => {
  try {
    // -------------------- SLASH COMMANDS --------------------
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === "setup") {
        const reviewChannel = interaction.options.getChannel("review_channel", true);
        const leaderboardChannel = interaction.options.getChannel("leaderboard_channel", true);
        const resultsChannel = interaction.options.getChannel("results_channel", true);

        await upsertConfig(interaction.guildId, reviewChannel.id, leaderboardChannel.id, resultsChannel.id);

        return interaction.reply({
          content: `✅ Setup saved.\nReview: ${reviewChannel}\nLeaderboard: ${leaderboardChannel}\nResults: ${resultsChannel}`,
          ephemeral: true,
        });
      }

      if (commandName === "start_tournament") {
        const name = interaction.options.getString("name", true);
        const newId = await startTournament(interaction.guildId, name);

        return interaction.reply({
          content: `✅ Started tournament: **${name}** (ID: ${newId}). New weigh-ins will count toward this event.`,
          ephemeral: true,
        });
      }

      if (commandName === "end_tournament") {
        const active = await getActiveTournament(interaction.guildId);
        if (!active) {
          return interaction.reply({ content: "❌ No active tournament to end.", ephemeral: true });
        }

        const config = await getConfig(interaction.guildId);
        if (!config?.results_channel_id) {
          return interaction.reply({ content: "❌ Missing results channel. Run `/setup` first.", ephemeral: true });
        }

        await endTournament(interaction.guildId, active.id);
        await snapshotTournamentResults(interaction.guildId, active.id);
        await postFinalStandings(interaction.guild, config.results_channel_id, active.id, active.name);

        return interaction.reply({
          content: `🛑 Ended tournament: **${active.name}**. Final standings posted to the results channel.`,
          ephemeral: true,
        });
      }

      if (commandName === "weighin") {
        const config = await getConfig(interaction.guildId);
        if (!config?.review_channel_id) {
          return interaction.reply({
            content: "❌ Bot isn’t set up yet. An admin needs to run `/setup` first.",
            ephemeral: true,
          });
        }

        const active = await getActiveTournament(interaction.guildId);
        if (!active) {
          return interaction.reply({
            content: "❌ No active tournament right now. An admin needs to run `/start_tournament name:...`",
            ephemeral: true,
          });
        }

        const pounds = interaction.options.getNumber("pounds", true);
        const photo = interaction.options.getAttachment("photo", true);
        const notes = interaction.options.getString("notes", false);

        if (!photo.contentType?.startsWith("image/")) {
          return interaction.reply({ content: "❌ Please upload an image file.", ephemeral: true });
        }

        const weighInId = await insertWeighIn({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          tournamentId: active.id,
          weightLbs: pounds,
          photoUrl: photo.url,
          notes,
        });

        const reviewChannel = await interaction.guild.channels.fetch(config.review_channel_id);

        const embed = new EmbedBuilder()
          .setTitle("🧾 Weigh-In Pending Review")
          .addFields(
            { name: "Tournament", value: `**${active.name}**`, inline: false },
            { name: "Angler", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Weight", value: `**${formatLb(pounds)} lbs**`, inline: true },
            { name: "Weigh-In ID", value: `#${weighInId}`, inline: true },
            { name: "Notes", value: notes || "—", inline: false }
          )
          .setImage(photo.url)
          .setTimestamp(new Date());

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`approve:${weighInId}`).setLabel("Approve").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`reject:${weighInId}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
        );

        await reviewChannel.send({ embeds: [embed], components: [row] });

        return interaction.reply({
          content: `✅ Submitted! Your weigh-in is pending admin approval. (ID #${weighInId})`,
          ephemeral: true,
        });
      }

      if (commandName === "bigbass") {
        const active = await getActiveTournament(interaction.guildId);
        if (!active) return interaction.reply({ content: "❌ No active tournament.", ephemeral: true });

        const rows = await getBigBassLeaderboard(interaction.guildId, active.id);

        const embed = new EmbedBuilder()
          .setTitle(`🏆 Big Bass — ${active.name}`)
          .setDescription(
            rows.length
              ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.big_bass)} lbs**`).join("\n")
              : "No approved weigh-ins yet."
          )
          .setTimestamp(new Date());

        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === "totalbag") {
        const active = await getActiveTournament(interaction.guildId);
        if (!active) return interaction.reply({ content: "❌ No active tournament.", ephemeral: true });

        const rows = await getTotalBagLeaderboard(interaction.guildId, active.id);

        const embed = new EmbedBuilder()
          .setTitle(`🎣 Total Bag (Top 5) — ${active.name}`)
          .setDescription(
            rows.length
              ? rows
                  .map(
                    (r, i) =>
                      `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.total_bag)} lbs** *(top ${r.fish_count} fish)*`
                  )
                  .join("\n")
              : "No approved weigh-ins yet."
          )
          .setTimestamp(new Date());

        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === "month_leaderboard") {
        const input = interaction.options.getString("month", false);

        const now = new Date();
        const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
        const yyyyMm = input || current;

        if (!/^\d{4}-\d{2}$/.test(yyyyMm)) {
          return interaction.reply({ content: "❌ Use YYYY-MM format (example: 2026-02).", ephemeral: true });
        }

        const rows = await getMonthLeaderboard(interaction.guildId, yyyyMm);

        const embed = new EmbedBuilder()
          .setTitle(`📆 Monthly Leaderboard — ${yyyyMm}`)
          .setDescription(
            rows.length
              ? rows
                  .map(
                    (r, i) =>
                      `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.month_total_bag)} lbs** (bag) • **${formatLb(
                        r.month_big_bass
                      )} lbs** (big) • *${r.tournaments_count} events*`
                  )
                  .join("\n")
              : "No finalized tournaments for this month yet."
          )
          .setTimestamp(new Date());

        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === "year_leaderboard") {
        const now = new Date();
        const yyyy = now.getFullYear();

        const rows = await getYearLeaderboard(interaction.guildId, yyyy);

        const embed = new EmbedBuilder()
          .setTitle(`📅 Overall Leaderboard (Year) — ${yyyy}`)
          .setDescription(
            rows.length
              ? rows
                  .map(
                    (r, i) =>
                      `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.year_total_bag)} lbs** (bag) • **${formatLb(
                        r.year_big_bass
                      )} lbs** (big) • *${r.tournaments_count} events*`
                  )
                  .join("\n")
              : "No finalized tournaments yet. End a tournament to save results."
          )
          .setTimestamp(new Date());

        return interaction.reply({ embeds: [embed] });
      }

      if (commandName === "reset_tournament_data") {
        db.serialize(() => {
          db.run(`DELETE FROM weighins WHERE guild_id = ?`, [interaction.guildId]);
          db.run(`DELETE FROM tournament_results WHERE guild_id = ?`, [interaction.guildId]);
          db.run(`DELETE FROM tournaments WHERE guild_id = ?`, [interaction.guildId]);
        });

        return interaction.reply({ content: "🧹 Reset complete: cleared all tournament data for this server.", ephemeral: true });
      }
    }

    // -------------------- BUTTONS (APPROVE / REJECT) --------------------
    if (interaction.isButton()) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
      }

      const config = await getConfig(interaction.guildId);
      const [action, idStr] = interaction.customId.split(":");
      const weighInId = Number(idStr);

      if (!Number.isFinite(weighInId)) {
        return interaction.reply({ content: "❌ Invalid weigh-in ID.", ephemeral: true });
      }

      if (action === "approve") {
        await setWeighInStatus(weighInId, "approved");
        await interaction.reply({ content: `✅ Approved weigh-in #${weighInId}.`, ephemeral: true });

        // Post updated leaderboards to leaderboard channel (current active tournament)
        const active = await getActiveTournament(interaction.guildId);
        if (active && config?.leaderboard_channel_id) {
          await postLeaderboards(interaction.guild, config.leaderboard_channel_id, active.id, active.name);
        }
        return;
      }

      if (action === "reject") {
        await setWeighInStatus(weighInId, "rejected");
        await interaction.reply({ content: `🗑️ Rejected weigh-in #${weighInId}.`, ephemeral: true });
        return;
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      await interaction
        .reply({ content: "❌ Something went wrong. Check the bot logs.", ephemeral: true })
        .catch(() => {});
    }
  }
});

// -------------------- START BOT --------------------
client.login(process.env.DISCORD_TOKEN);


