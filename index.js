/**
 * Bass Tournament Discord Bot (UI Panel Edition)
 *
 * What you asked for:
 * ✅ Only ONE slash command: /panel (admin only)
 * ✅ /panel posts an embed UI panel:
 *    - Dropdown: Big Bass, Total Bag, Monthly, Yearly
 *    - Buttons: Submit Weigh-in (modal), Start Tournament (modal, admin), End Tournament (admin)
 * ✅ Weigh-in flow:
 *    - User uploads photo FIRST in the channel
 *    - User clicks "Submit Weigh-in"
 *    - Modal asks for weight + notes
 *    - Bot uses that user's MOST RECENT uploaded image (from this channel)
 * ✅ No approve/reject.
 * ✅ Persistent SQLite (use /data on Railway with a volume)
 *
 * IMPORTANT:
 * - This bot NEEDS Message Content access to detect image uploads.
 *   In Discord Developer Portal -> Bot -> Privileged Gateway Intents:
 *   ✅ Message Content Intent ON
 *
 * .env (Railway Variables):
 * DISCORD_TOKEN=...
 * CLIENT_ID=... (Application ID)
 * GUILD_ID=...  (Server ID - for guild command registration)
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
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
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
// Use /data/tournament.sqlite on Railway if you mounted a Volume at /data
const DB_PATH = process.env.DB_PATH || "/data/tournament.sqlite";
const db = new sqlite3.Database(DB_PATH);

function safeAlter(sql) {
  db.run(sql, () => {});
}

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      guild_id TEXT PRIMARY KEY,
      panel_channel_id TEXT,
      leaderboard_channel_id TEXT,
      results_channel_id TEXT,
      bigbass_message_id TEXT,
      totalbag_message_id TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS uploads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      image_url TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS weighins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      tournament_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      weight_lbs REAL NOT NULL,
      photo_url TEXT NOT NULL,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'approved',
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
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (tournament_id, user_id)
    )
  `);

  // migrations (if older DB exists)
  safeAlter(`ALTER TABLE config ADD COLUMN panel_channel_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN leaderboard_channel_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN results_channel_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN bigbass_message_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN totalbag_message_id TEXT`);
  safeAlter(`ALTER TABLE uploads ADD COLUMN channel_id TEXT`);
  safeAlter(`ALTER TABLE weighins ADD COLUMN channel_id TEXT`);
});

// -------------------- DISCORD CLIENT --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // REQUIRED for “upload photo first” flow
  ],
  partials: [Partials.Channel, Partials.Message],
});

// -------------------- SLASH COMMANDS --------------------
const slashCommands = [
  new SlashCommandBuilder()
    .setName("panel")
    .setDescription("Post the Bass Tournament control panel (admin only)")
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

function upsertConfig(guildId, patch) {
  // patch can include any config fields
  const fields = {
    panel_channel_id: patch.panel_channel_id ?? null,
    leaderboard_channel_id: patch.leaderboard_channel_id ?? null,
    results_channel_id: patch.results_channel_id ?? null,
    bigbass_message_id: patch.bigbass_message_id ?? null,
    totalbag_message_id: patch.totalbag_message_id ?? null,
  };

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO config (guild_id, panel_channel_id, leaderboard_channel_id, results_channel_id, bigbass_message_id, totalbag_message_id)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        panel_channel_id=COALESCE(excluded.panel_channel_id, config.panel_channel_id),
        leaderboard_channel_id=COALESCE(excluded.leaderboard_channel_id, config.leaderboard_channel_id),
        results_channel_id=COALESCE(excluded.results_channel_id, config.results_channel_id),
        bigbass_message_id=COALESCE(excluded.bigbass_message_id, config.bigbass_message_id),
        totalbag_message_id=COALESCE(excluded.totalbag_message_id, config.totalbag_message_id)
      `,
      [
        guildId,
        fields.panel_channel_id,
        fields.leaderboard_channel_id,
        fields.results_channel_id,
        fields.bigbass_message_id,
        fields.totalbag_message_id,
      ],
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

function insertUpload({ guildId, channelId, userId, messageId, imageUrl }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO uploads (guild_id, channel_id, user_id, message_id, image_url) VALUES (?, ?, ?, ?, ?)`,
      [guildId, channelId, userId, messageId, imageUrl],
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function getLatestUpload({ guildId, channelId, userId, maxMinutes = 120 }) {
  // only accept uploads within last maxMinutes
  return new Promise((resolve, reject) => {
    db.get(
      `
      SELECT * FROM uploads
      WHERE guild_id = ? AND channel_id = ? AND user_id = ?
        AND datetime(created_at) >= datetime('now', ?)
      ORDER BY datetime(created_at) DESC
      LIMIT 1
      `,
      [guildId, channelId, userId, `-${maxMinutes} minutes`],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
}

function insertWeighIn({ guildId, channelId, tournamentId, userId, weightLbs, photoUrl, notes }) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO weighins (guild_id, channel_id, tournament_id, user_id, weight_lbs, photo_url, notes, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`,
      [guildId, channelId, tournamentId, userId, weightLbs, photoUrl, notes || null],
      function (err) {
        if (err) return reject(err);
        resolve(this.lastID);
      }
    );
  });
}

function formatLb(weight) {
  return Number(weight || 0).toFixed(2);
}

// -------------------- LEADERBOARD QUERIES --------------------
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
  // Top 5 fish total per angler (requires SQLite window functions)
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

async function snapshotTournamentResults(guildId, tournamentId) {
  const big = await getBigBassLeaderboard(guildId, tournamentId);
  const bag = await getTotalBagLeaderboard(guildId, tournamentId);

  const users = new Set([...big.map((r) => r.user_id), ...bag.map((r) => r.user_id)]);

  return new Promise((resolve, reject) => {
    db.serialize(() => {
      const stmt = db.prepare(`
        INSERT INTO tournament_results (guild_id, tournament_id, user_id, big_bass, total_bag, fish_count)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(tournament_id, user_id) DO UPDATE SET
          big_bass=excluded.big_bass,
          total_bag=excluded.total_bag,
          fish_count=excluded.fish_count
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
        ]);
      }

      stmt.finalize((err) => (err ? reject(err) : resolve()));
    });
  });
}

// -------------------- PANEL + MESSAGE MANAGEMENT --------------------
function buildPanelEmbed(activeTournament) {
  const title = activeTournament ? `🎣 Bass Tournament Panel — ${activeTournament.name}` : "🎣 Bass Tournament Panel";
  const status = activeTournament ? "🟢 **Tournament is ACTIVE**" : "🔴 **No active tournament**";

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(
      [
        status,
        "",
        "✅ **How to submit a weigh-in**",
        "1) Upload your weigh-in photo in this channel",
        "2) Click **Submit Weigh-in**",
        "3) Enter weight + notes in the popup",
        "",
        "Use the dropdown to view leaderboards (Big Bass / Total Bag / Monthly / Yearly).",
      ].join("\n")
    )
    .setTimestamp(new Date());
}

function buildPanelComponents(isAdmin) {
  const select = new StringSelectMenuBuilder()
    .setCustomId("panel_select")
    .setPlaceholder("Choose a leaderboard to view…")
    .addOptions(
      { label: "🏆 Big Bass (Current Tournament)", value: "bigbass_current" },
      { label: "🎣 Total Bag Top 5 (Current Tournament)", value: "totalbag_current" },
      { label: "📆 Monthly Leaderboard", value: "monthly" },
      { label: "📅 Yearly Leaderboard", value: "yearly" }
    );

  const row1 = new ActionRowBuilder().addComponents(select);

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("submit_weighin").setLabel("Submit Weigh-in").setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId("start_tournament")
      .setLabel("Start Tournament")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!isAdmin),
    new ButtonBuilder()
      .setCustomId("end_tournament")
      .setLabel("End Tournament")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(!isAdmin)
  );

  return [row1, row2];
}

function buildBigBassEmbed(tournamentName, rows) {
  return new EmbedBuilder()
    .setTitle(`🏆 Big Bass — ${tournamentName}`)
    .setDescription(
      rows.length
        ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.big_bass)} lbs**`).join("\n")
        : "No weigh-ins yet."
    )
    .setTimestamp(new Date());
}

function buildTotalBagEmbed(tournamentName, rows) {
  return new EmbedBuilder()
    .setTitle(`🎣 Total Bag (Top 5) — ${tournamentName}`)
    .setDescription(
      rows.length
        ? rows
            .map(
              (r, i) =>
                `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.total_bag)} lbs** *(top ${r.fish_count} fish)*`
            )
            .join("\n")
        : "No weigh-ins yet."
    )
    .setTimestamp(new Date());
}

async function ensureLeaderboardMessages(guild, channelId, tournament) {
  // Creates or reuses two messages in the leaderboard channel and stores their IDs,
  // then edits them as the tournament updates.
  const cfg = await getConfig(guild.id);

  const channel = await guild.channels.fetch(channelId);
  if (!channel) return null;

  let bigMsg = null;
  let bagMsg = null;

  // Try fetch existing
  if (cfg?.bigbass_message_id) {
    try {
      bigMsg = await channel.messages.fetch(cfg.bigbass_message_id);
    } catch {}
  }
  if (cfg?.totalbag_message_id) {
    try {
      bagMsg = await channel.messages.fetch(cfg.totalbag_message_id);
    } catch {}
  }

  // Create missing
  if (!bigMsg) {
    bigMsg = await channel.send({ embeds: [buildBigBassEmbed(tournament?.name || "Current", [])] });
  }
  if (!bagMsg) {
    bagMsg = await channel.send({ embeds: [buildTotalBagEmbed(tournament?.name || "Current", [])] });
  }

  await upsertConfig(guild.id, {
    leaderboard_channel_id: channelId,
    bigbass_message_id: bigMsg.id,
    totalbag_message_id: bagMsg.id,
  });

  return { bigMsg, bagMsg };
}

async function updateLeaderboardMessages(guild, tournament) {
  const cfg = await getConfig(guild.id);
  if (!cfg?.leaderboard_channel_id || !cfg?.bigbass_message_id || !cfg?.totalbag_message_id) return;

  const channel = await guild.channels.fetch(cfg.leaderboard_channel_id);
  if (!channel) return;

  const bigRows = tournament ? await getBigBassLeaderboard(guild.id, tournament.id) : [];
  const bagRows = tournament ? await getTotalBagLeaderboard(guild.id, tournament.id) : [];

  try {
    const bigMsg = await channel.messages.fetch(cfg.bigbass_message_id);
    await bigMsg.edit({ embeds: [buildBigBassEmbed(tournament?.name || "No Active Tournament", bigRows)] });
  } catch {}

  try {
    const bagMsg = await channel.messages.fetch(cfg.totalbag_message_id);
    await bagMsg.edit({ embeds: [buildTotalBagEmbed(tournament?.name || "No Active Tournament", bagRows)] });
  } catch {}
}

async function postFinalStandings(guild, resultsChannelId, tournament) {
  const big = await getBigBassLeaderboard(guild.id, tournament.id);
  const bag = await getTotalBagLeaderboard(guild.id, tournament.id);

  const header = new EmbedBuilder()
    .setTitle(`✅ FINAL RESULTS — ${tournament.name}`)
    .setDescription("Tournament ended. Submissions are now locked.")
    .setTimestamp(new Date());

  const bigEmbed = new EmbedBuilder()
    .setTitle("🏆 Big Bass (Final)")
    .setDescription(
      big.length
        ? big.map((r, i) => `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.big_bass)} lbs**`).join("\n")
        : "No weigh-ins."
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
        : "No weigh-ins."
    );

  const channel = await guild.channels.fetch(resultsChannelId);
  if (channel) {
    await channel.send({ embeds: [header] });
    await channel.send({ embeds: [bigEmbed] });
    await channel.send({ embeds: [bagEmbed] });
  }
}

// -------------------- CAPTURE IMAGE UPLOADS --------------------
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;

    // Track only messages that contain at least one image attachment
    const img = message.attachments.find((a) => (a.contentType || "").startsWith("image/"));
    if (!img) return;

    await insertUpload({
      guildId: message.guild.id,
      channelId: message.channel.id,
      userId: message.author.id,
      messageId: message.id,
      imageUrl: img.url,
    });
  } catch (e) {
    console.error("messageCreate upload tracking error:", e);
  }
});

// -------------------- READY --------------------
client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await registerCommands();
  } catch (e) {
    console.error("Failed to register commands:", e);
  }
});

// -------------------- INTERACTIONS --------------------
client.on("interactionCreate", async (interaction) => {
  try {
    // ---------- /panel ----------
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "panel") return;

      // Save config: panel/leaderboard/results = this channel
      await upsertConfig(interaction.guildId, {
        panel_channel_id: interaction.channelId,
        leaderboard_channel_id: interaction.channelId,
        results_channel_id: interaction.channelId,
      });

      const active = await getActiveTournament(interaction.guildId);

      // Ensure leaderboard messages exist in this channel (so we edit instead of spamming)
      await ensureLeaderboardMessages(interaction.guild, interaction.channelId, active || { name: "Current" });
      await updateLeaderboardMessages(interaction.guild, active);

      const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.Administrator);

      const panel = await interaction.channel.send({
        embeds: [buildPanelEmbed(active)],
        components: buildPanelComponents(isAdmin),
      });

      return interaction.reply({
        content: `✅ Panel posted in ${interaction.channel}.`,
        ephemeral: true,
      });
    }

    // ---------- Dropdown selection ----------
    if (interaction.isStringSelectMenu()) {
      if (interaction.customId !== "panel_select") return;

      const active = await getActiveTournament(interaction.guildId);

      const choice = interaction.values?.[0];

      if (choice === "bigbass_current") {
        if (!active) {
          return interaction.reply({ content: "❌ No active tournament.", ephemeral: true });
        }
        const rows = await getBigBassLeaderboard(interaction.guildId, active.id);
        return interaction.reply({ embeds: [buildBigBassEmbed(active.name, rows)], ephemeral: true });
      }

      if (choice === "totalbag_current") {
        if (!active) {
          return interaction.reply({ content: "❌ No active tournament.", ephemeral: true });
        }
        const rows = await getTotalBagLeaderboard(interaction.guildId, active.id);
        return interaction.reply({ embeds: [buildTotalBagEmbed(active.name, rows)], ephemeral: true });
      }

      if (choice === "monthly") {
        // Open a modal to ask YYYY-MM
        const modal = new ModalBuilder().setCustomId("monthly_modal").setTitle("Monthly Leaderboard");
        const monthInput = new TextInputBuilder()
          .setCustomId("month")
          .setLabel("Month (YYYY-MM) e.g., 2026-02")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(monthInput));
        return interaction.showModal(modal);
      }

      if (choice === "yearly") {
        const now = new Date();
        const yyyy = now.getFullYear();
        const rows = await getYearLeaderboard(interaction.guildId, yyyy);

        const embed = new EmbedBuilder()
          .setTitle(`📅 Yearly Leaderboard — ${yyyy}`)
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
              : "No finalized tournaments this year yet."
          )
          .setTimestamp(new Date());

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }

    // ---------- Buttons ----------
    if (interaction.isButton()) {
      const isAdmin =
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

      if (interaction.customId === "submit_weighin") {
        const active = await getActiveTournament(interaction.guildId);
        if (!active) {
          return interaction.reply({ content: "❌ No active tournament. Admin must start one first.", ephemeral: true });
        }

        const modal = new ModalBuilder().setCustomId("weighin_modal").setTitle("Submit Weigh-in");

        const weightInput = new TextInputBuilder()
          .setCustomId("weight")
          .setLabel("Weight in pounds (example: 5.62)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const notesInput = new TextInputBuilder()
          .setCustomId("notes")
          .setLabel("Notes (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false);

        modal.addComponents(
          new ActionRowBuilder().addComponents(weightInput),
          new ActionRowBuilder().addComponents(notesInput)
        );

        return interaction.showModal(modal);
      }

      if (interaction.customId === "start_tournament") {
        if (!isAdmin) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

        const modal = new ModalBuilder().setCustomId("start_modal").setTitle("Start Tournament");
        const nameInput = new TextInputBuilder()
          .setCustomId("name")
          .setLabel("Tournament name")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(new ActionRowBuilder().addComponents(nameInput));
        return interaction.showModal(modal);
      }

      if (interaction.customId === "end_tournament") {
        if (!isAdmin) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

        const active = await getActiveTournament(interaction.guildId);
        if (!active) {
          return interaction.reply({ content: "❌ No active tournament to end.", ephemeral: true });
        }

        const cfg = await getConfig(interaction.guildId);
        const resultsChannelId = cfg?.results_channel_id || interaction.channelId;

        await endTournament(interaction.guildId, active.id);
        await snapshotTournamentResults(interaction.guildId, active.id);
        await postFinalStandings(interaction.guild, resultsChannelId, active);

        // Update leaderboard messages to show final numbers (still safe)
        await updateLeaderboardMessages(interaction.guild, active);

        return interaction.reply({
          content: `🛑 Ended **${active.name}**. Final standings posted.`,
          ephemeral: true,
        });
      }
    }

    // ---------- Modals ----------
    if (interaction.isModalSubmit()) {
      // Monthly modal
      if (interaction.customId === "monthly_modal") {
        const yyyyMm = interaction.fields.getTextInputValue("month")?.trim();
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

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // Start tournament modal
      if (interaction.customId === "start_modal") {
        const isAdmin =
          interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
          interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
        if (!isAdmin) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

        const name = interaction.fields.getTextInputValue("name")?.trim();
        if (!name) return interaction.reply({ content: "❌ Tournament name required.", ephemeral: true });

        await startTournament(interaction.guildId, name);

        // Ensure leaderboard messages exist (in configured channel)
        const cfg = await getConfig(interaction.guildId);
        const channelId = cfg?.leaderboard_channel_id || interaction.channelId;

        const active = await getActiveTournament(interaction.guildId);
        await ensureLeaderboardMessages(interaction.guild, channelId, active || { name });
        await updateLeaderboardMessages(interaction.guild, active);

        return interaction.reply({ content: `✅ Started tournament: **${name}**`, ephemeral: true });
      }

      // Weigh-in modal
      if (interaction.customId === "weighin_modal") {
        const active = await getActiveTournament(interaction.guildId);
        if (!active) {
          return interaction.reply({ content: "❌ No active tournament.", ephemeral: true });
        }

        const weightRaw = interaction.fields.getTextInputValue("weight")?.trim();
        const notes = interaction.fields.getTextInputValue("notes")?.trim() || null;

        // Parse weight
        const weight = Number(weightRaw);
        if (!Number.isFinite(weight) || weight <= 0) {
          return interaction.reply({ content: "❌ Weight must be a valid number (example: 5.62).", ephemeral: true });
        }

        // Find most recent upload from this user in this channel
        const latest = await getLatestUpload({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          maxMinutes: 180,
        });

        if (!latest) {
          return interaction.reply({
            content:
              "❌ I don’t see a recent weigh-in photo from you in this channel.\nUpload your photo first, then click **Submit Weigh-in** again.",
            ephemeral: true,
          });
        }

        // Save weigh-in
        await insertWeighIn({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          tournamentId: active.id,
          userId: interaction.user.id,
          weightLbs: weight,
          photoUrl: latest.image_url,
          notes,
        });

        // Update persistent leaderboard messages
        await updateLeaderboardMessages(interaction.guild, active);

        const embed = new EmbedBuilder()
          .setTitle("✅ Weigh-in Submitted")
          .addFields(
            { name: "Tournament", value: `**${active.name}**`, inline: false },
            { name: "Angler", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Weight", value: `**${formatLb(weight)} lbs**`, inline: true },
            { name: "Notes", value: notes || "—", inline: false }
          )
          .setImage(latest.image_url)
          .setTimestamp(new Date());

        return interaction.reply({ embeds: [embed], ephemeral: true });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      // Avoid double-reply errors
      if (interaction.deferred || interaction.replied) {
        return interaction.followUp({ content: "❌ Something went wrong. Check logs.", ephemeral: true }).catch(() => {});
      }
      await interaction.reply({ content: "❌ Something went wrong. Check logs.", ephemeral: true }).catch(() => {});
    }
  }
});

// -------------------- START BOT --------------------
client.login(process.env.DISCORD_TOKEN);
