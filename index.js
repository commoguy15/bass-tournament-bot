/**
 * Bass Tournament Discord Bot — Auto-Updating Leaderboard Embeds (UI Panel)
 *
 * ✅ Only slash command: /panel (admin only)
 * ✅ Panel has:
 *   - Submit Weigh-in (modal)
 *   - Start Tournament (modal, admin)
 *   - End Tournament (admin)
 *   - Set Channels (modal, admin) -> panel/leaderboard/results
 *
 * ✅ Weigh-in flow:
 *   1) User uploads photo FIRST in the panel channel
 *   2) User clicks "Submit Weigh-in"
 *   3) Modal asks weight + notes
 *   4) Bot uses user's MOST RECENT image upload in that channel (within last 180 min)
 *
 * ✅ No approve/reject
 * ✅ Leaderboard channel has 4 persistent messages that UPDATE automatically:
 *   - Big Bass (Current Tournament)
 *   - Total Bag Top 5 (Current Tournament)
 *   - Monthly Winners (current month): #1 bag + #1 big bass
 *   - Yearly Winners (current year): #1 bag + #1 big bass
 *
 * ✅ Results channel gets FINAL standings on End Tournament
 *
 * IMPORTANT DISCORD SETTING:
 * Discord Developer Portal -> Bot -> Privileged Gateway Intents:
 * ✅ Message Content Intent ON
 *
 * .env / Railway Variables:
 * DISCORD_TOKEN=...
 * CLIENT_ID=... (Application ID)
 * GUILD_ID=...  (Server ID)
 * Optional:
 * DB_PATH=/data/tournament.sqlite (defaults to /data/tournament.sqlite)
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

      cur_bigbass_msg_id TEXT,
      cur_totalbag_msg_id TEXT,
      monthly_winners_msg_id TEXT,
      yearly_winners_msg_id TEXT
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

  // migrations
  safeAlter(`ALTER TABLE config ADD COLUMN panel_channel_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN leaderboard_channel_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN results_channel_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN cur_bigbass_msg_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN cur_totalbag_msg_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN monthly_winners_msg_id TEXT`);
  safeAlter(`ALTER TABLE config ADD COLUMN yearly_winners_msg_id TEXT`);

  safeAlter(`ALTER TABLE uploads ADD COLUMN channel_id TEXT`);
  safeAlter(`ALTER TABLE weighins ADD COLUMN channel_id TEXT`);
});

// -------------------- DISCORD CLIENT --------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // REQUIRED for tracking user photo uploads
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
  const fields = {
    panel_channel_id: patch.panel_channel_id ?? null,
    leaderboard_channel_id: patch.leaderboard_channel_id ?? null,
    results_channel_id: patch.results_channel_id ?? null,

    cur_bigbass_msg_id: patch.cur_bigbass_msg_id ?? null,
    cur_totalbag_msg_id: patch.cur_totalbag_msg_id ?? null,
    monthly_winners_msg_id: patch.monthly_winners_msg_id ?? null,
    yearly_winners_msg_id: patch.yearly_winners_msg_id ?? null,
  };

  return new Promise((resolve, reject) => {
    db.run(
      `
      INSERT INTO config (
        guild_id,
        panel_channel_id,
        leaderboard_channel_id,
        results_channel_id,
        cur_bigbass_msg_id,
        cur_totalbag_msg_id,
        monthly_winners_msg_id,
        yearly_winners_msg_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET
        panel_channel_id=COALESCE(excluded.panel_channel_id, config.panel_channel_id),
        leaderboard_channel_id=COALESCE(excluded.leaderboard_channel_id, config.leaderboard_channel_id),
        results_channel_id=COALESCE(excluded.results_channel_id, config.results_channel_id),
        cur_bigbass_msg_id=COALESCE(excluded.cur_bigbass_msg_id, config.cur_bigbass_msg_id),
        cur_totalbag_msg_id=COALESCE(excluded.cur_totalbag_msg_id, config.cur_totalbag_msg_id),
        monthly_winners_msg_id=COALESCE(excluded.monthly_winners_msg_id, config.monthly_winners_msg_id),
        yearly_winners_msg_id=COALESCE(excluded.yearly_winners_msg_id, config.yearly_winners_msg_id)
      `,
      [
        guildId,
        fields.panel_channel_id,
        fields.leaderboard_channel_id,
        fields.results_channel_id,
        fields.cur_bigbass_msg_id,
        fields.cur_totalbag_msg_id,
        fields.monthly_winners_msg_id,
        fields.yearly_winners_msg_id,
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

function getLatestUpload({ guildId, channelId, userId, maxMinutes = 180 }) {
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

function getMonthSummaryWinners(guildId, yyyyMm) {
  // winners computed from finalized tournaments (tournament_results)
  return new Promise((resolve, reject) => {
    db.get(
      `
      WITH agg AS (
        SELECT
          tr.user_id,
          SUM(tr.total_bag) AS bag_sum,
          MAX(tr.big_bass) AS best_big
        FROM tournament_results tr
        JOIN tournaments t ON t.id = tr.tournament_id
        WHERE tr.guild_id = ?
          AND t.ended_at IS NOT NULL
          AND strftime('%Y-%m', t.ended_at) = ?
        GROUP BY tr.user_id
      )
      SELECT
        (SELECT user_id FROM agg ORDER BY bag_sum DESC, best_big DESC LIMIT 1) AS bag_winner_id,
        (SELECT bag_sum  FROM agg ORDER BY bag_sum DESC, best_big DESC LIMIT 1) AS bag_winner_bag,
        (SELECT user_id FROM agg ORDER BY best_big DESC, bag_sum DESC LIMIT 1) AS big_winner_id,
        (SELECT best_big FROM agg ORDER BY best_big DESC, bag_sum DESC LIMIT 1) AS big_winner_big
      `,
      [guildId, yyyyMm],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
}

function getYearSummaryWinners(guildId, yyyy) {
  return new Promise((resolve, reject) => {
    db.get(
      `
      WITH agg AS (
        SELECT
          tr.user_id,
          SUM(tr.total_bag) AS bag_sum,
          MAX(tr.big_bass) AS best_big
        FROM tournament_results tr
        JOIN tournaments t ON t.id = tr.tournament_id
        WHERE tr.guild_id = ?
          AND t.ended_at IS NOT NULL
          AND strftime('%Y', t.ended_at) = ?
        GROUP BY tr.user_id
      )
      SELECT
        (SELECT user_id FROM agg ORDER BY bag_sum DESC, best_big DESC LIMIT 1) AS bag_winner_id,
        (SELECT bag_sum  FROM agg ORDER BY bag_sum DESC, best_big DESC LIMIT 1) AS bag_winner_bag,
        (SELECT user_id FROM agg ORDER BY best_big DESC, bag_sum DESC LIMIT 1) AS big_winner_id,
        (SELECT best_big FROM agg ORDER BY best_big DESC, bag_sum DESC LIMIT 1) AS big_winner_big
      `,
      [guildId, String(yyyy)],
      (err, row) => (err ? reject(err) : resolve(row || null))
    );
  });
}

// -------------------- EMBEDS --------------------
function panelEmbed(activeTournament, cfg) {
  const status = activeTournament ? `🟢 **ACTIVE:** ${activeTournament.name}` : "🔴 **No active tournament**";

  const panelCh = cfg?.panel_channel_id ? `<#${cfg.panel_channel_id}>` : "Not set";
  const lbCh = cfg?.leaderboard_channel_id ? `<#${cfg.leaderboard_channel_id}>` : "Not set";
  const resCh = cfg?.results_channel_id ? `<#${cfg.results_channel_id}>` : "Not set";

  return new EmbedBuilder()
    .setTitle("🎣 Bass Tournament Panel")
    .setDescription(
      [
        status,
        "",
        "✅ **Weigh-in steps**",
        "1) Upload your weigh-in photo in the **Panel Channel**",
        "2) Click **Submit Weigh-in**",
        "3) Enter weight + notes",
        "",
        "⚙️ **Channel Routing**",
        `• Panel: ${panelCh}`,
        `• Leaderboards: ${lbCh}`,
        `• Results: ${resCh}`,
      ].join("\n")
    )
    .setTimestamp(new Date());
}

function panelComponents(isAdmin) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("submit_weighin").setLabel("Submit Weigh-in").setStyle(ButtonStyle.Success),
      const panelInput = new TextInputBuilder()
  .setCustomId("panel_ch")
  .setLabel("Panel channel (#channel or ID)")
  .setStyle(TextInputStyle.Short)
  .setRequired(true);

const lbInput = new TextInputBuilder()
  .setCustomId("lb_ch")
  .setLabel("Leaderboard channel (#channel or ID)")
  .setStyle(TextInputStyle.Short)
  .setRequired(true);

const resInput = new TextInputBuilder()
  .setCustomId("res_ch")
  .setLabel("Results channel (#channel or ID)")
  .setStyle(TextInputStyle.Short)
  .setRequired(true);
    ),
  ];
}

function bigBassCurrentEmbed(tournamentName, rows) {
  return new EmbedBuilder()
    .setTitle(`🏆 Big Bass — ${tournamentName || "No Active Tournament"}`)
    .setDescription(
      rows?.length
        ? rows.map((r, i) => `**${i + 1}.** <@${r.user_id}> — **${formatLb(r.big_bass)} lbs**`).join("\n")
        : "No weigh-ins yet."
    )
    .setTimestamp(new Date());
}

function totalBagCurrentEmbed(tournamentName, rows) {
  return new EmbedBuilder()
    .setTitle(`🎣 Total Bag (Top 5) — ${tournamentName || "No Active Tournament"}`)
    .setDescription(
      rows?.length
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

function monthlyWinnersEmbed(yyyyMm, winners) {
  const bagLine =
    winners?.bag_winner_id
      ? `🏅 **Bag Winner:** <@${winners.bag_winner_id}> — **${formatLb(winners.bag_winner_bag)} lbs**`
      : "🏅 **Bag Winner:** —";
  const bigLine =
    winners?.big_winner_id
      ? `🐷 **Big Bass Winner:** <@${winners.big_winner_id}> — **${formatLb(winners.big_winner_big)} lbs**`
      : "🐷 **Big Bass Winner:** —";

  return new EmbedBuilder()
    .setTitle(`📆 Monthly Winners — ${yyyyMm}`)
    .setDescription([bagLine, bigLine, "", "_Monthly winners update when tournaments end._"].join("\n"))
    .setTimestamp(new Date());
}

function yearlyWinnersEmbed(yyyy, winners) {
  const bagLine =
    winners?.bag_winner_id
      ? `🏅 **Bag Winner:** <@${winners.bag_winner_id}> — **${formatLb(winners.bag_winner_bag)} lbs**`
      : "🏅 **Bag Winner:** —";
  const bigLine =
    winners?.big_winner_id
      ? `🐷 **Big Bass Winner:** <@${winners.big_winner_id}> — **${formatLb(winners.big_winner_big)} lbs**`
      : "🐷 **Big Bass Winner:** —";

  return new EmbedBuilder()
    .setTitle(`📅 Yearly Winners — ${yyyy}`)
    .setDescription([bagLine, bigLine, "", "_Yearly winners update when tournaments end._"].join("\n"))
    .setTimestamp(new Date());
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

// -------------------- AUTO-UPDATING LEADERBOARD MESSAGES --------------------
async function ensureLeaderboardMessages(guild, leaderboardChannelId) {
  const cfg = await getConfig(guild.id);
  const channel = await guild.channels.fetch(leaderboardChannelId);
  if (!channel) return null;

  let curBig = null;
  let curBag = null;
  let mon = null;
  let yr = null;

  // fetch existing
  if (cfg?.cur_bigbass_msg_id) {
    try { curBig = await channel.messages.fetch(cfg.cur_bigbass_msg_id); } catch {}
  }
  if (cfg?.cur_totalbag_msg_id) {
    try { curBag = await channel.messages.fetch(cfg.cur_totalbag_msg_id); } catch {}
  }
  if (cfg?.monthly_winners_msg_id) {
    try { mon = await channel.messages.fetch(cfg.monthly_winners_msg_id); } catch {}
  }
  if (cfg?.yearly_winners_msg_id) {
    try { yr = await channel.messages.fetch(cfg.yearly_winners_msg_id); } catch {}
  }

  // create missing (empty placeholders)
  if (!curBig) curBig = await channel.send({ embeds: [bigBassCurrentEmbed("No Active Tournament", [])] });
  if (!curBag) curBag = await channel.send({ embeds: [totalBagCurrentEmbed("No Active Tournament", [])] });

  const now = new Date();
  const yyyyMm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const yyyy = now.getFullYear();

  if (!mon) mon = await channel.send({ embeds: [monthlyWinnersEmbed(yyyyMm, null)] });
  if (!yr) yr = await channel.send({ embeds: [yearlyWinnersEmbed(yyyy, null)] });

  await upsertConfig(guild.id, {
    leaderboard_channel_id: leaderboardChannelId,
    cur_bigbass_msg_id: curBig.id,
    cur_totalbag_msg_id: curBag.id,
    monthly_winners_msg_id: mon.id,
    yearly_winners_msg_id: yr.id,
  });

  return { curBig, curBag, mon, yr };
}

async function updateAllLeaderboardEmbeds(guild) {
  const cfg = await getConfig(guild.id);
  if (!cfg?.leaderboard_channel_id) return;

  const channel = await guild.channels.fetch(cfg.leaderboard_channel_id);
  if (!channel) return;

  // ensure messages exist
  await ensureLeaderboardMessages(guild, cfg.leaderboard_channel_id);

  const active = await getActiveTournament(guild.id);

  // current tournament boards
  const bigRows = active ? await getBigBassLeaderboard(guild.id, active.id) : [];
  const bagRows = active ? await getTotalBagLeaderboard(guild.id, active.id) : [];

  // monthly/yearly winners
  const now = new Date();
  const yyyyMm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const yyyy = now.getFullYear();

  const monthW = await getMonthSummaryWinners(guild.id, yyyyMm).catch(() => null);
  const yearW = await getYearSummaryWinners(guild.id, yyyy).catch(() => null);

  // edit the stored messages
  try {
    const msg = await channel.messages.fetch(cfg.cur_bigbass_msg_id);
    await msg.edit({ embeds: [bigBassCurrentEmbed(active?.name || "No Active Tournament", bigRows)] });
  } catch {}

  try {
    const msg = await channel.messages.fetch(cfg.cur_totalbag_msg_id);
    await msg.edit({ embeds: [totalBagCurrentEmbed(active?.name || "No Active Tournament", bagRows)] });
  } catch {}

  try {
    const msg = await channel.messages.fetch(cfg.monthly_winners_msg_id);
    await msg.edit({ embeds: [monthlyWinnersEmbed(yyyyMm, monthW)] });
  } catch {}

  try {
    const msg = await channel.messages.fetch(cfg.yearly_winners_msg_id);
    await msg.edit({ embeds: [yearlyWinnersEmbed(yyyy, yearW)] });
  } catch {}
}

// -------------------- TRACK IMAGE UPLOADS --------------------
client.on("messageCreate", async (message) => {
  try {
    if (!message.guild) return;
    if (message.author?.bot) return;

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
    console.error("upload tracking error:", e);
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
function parseChannelIdFromText(text) {
  // accepts <#123> or 123
  const mention = text.match(/<#(\d{15,25})>/);
  if (mention) return mention[1];
  const raw = text.match(/\b(\d{15,25})\b/);
  if (raw) return raw[1];
  return null;
}

client.on("interactionCreate", async (interaction) => {
  try {
    const isAdmin =
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);

    // /panel
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName !== "panel") return;
      if (!isAdmin) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

      // Default routing: panel channel = where /panel ran
      // If leaderboards/results not set yet, default them to same channel for now.
      const cfg = await getConfig(interaction.guildId);
      await upsertConfig(interaction.guildId, {
        panel_channel_id: interaction.channelId,
        leaderboard_channel_id: cfg?.leaderboard_channel_id || interaction.channelId,
        results_channel_id: cfg?.results_channel_id || interaction.channelId,
      });

      const updatedCfg = await getConfig(interaction.guildId);
      const active = await getActiveTournament(interaction.guildId);

      // Ensure the leaderboard messages exist + update them
      await ensureLeaderboardMessages(interaction.guild, updatedCfg.leaderboard_channel_id);
      await updateAllLeaderboardEmbeds(interaction.guild);

      // Post the panel
      await interaction.channel.send({
        embeds: [panelEmbed(active, updatedCfg)],
        components: panelComponents(true),
      });

      return interaction.reply({ content: "✅ Panel posted.", ephemeral: true });
    }

    // Buttons
    if (interaction.isButton()) {
      const cfg = await getConfig(interaction.guildId);
      const active = await getActiveTournament(interaction.guildId);

      if (interaction.customId === "set_channels") {
        if (!isAdmin) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

        const modal = new ModalBuilder().setCustomId("set_channels_modal").setTitle("Set Channels");

        const panelInput = new TextInputBuilder()
          .setCustomId("panel_ch")
          .setLabel("Panel channel (paste #channel or channel ID)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const lbInput = new TextInputBuilder()
          .setCustomId("lb_ch")
          .setLabel("Leaderboard channel (paste #channel or channel ID)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        const resInput = new TextInputBuilder()
          .setCustomId("res_ch")
          .setLabel("Results channel (paste #channel or channel ID)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);

        modal.addComponents(
          new ActionRowBuilder().addComponents(panelInput),
          new ActionRowBuilder().addComponents(lbInput),
          new ActionRowBuilder().addComponents(resInput)
        );

        return interaction.showModal(modal);
      }

      if (interaction.customId === "submit_weighin") {
        // Must be in panel channel (recommended)
        if (cfg?.panel_channel_id && interaction.channelId !== cfg.panel_channel_id) {
          return interaction.reply({
            content: `❌ Submit weigh-ins in the panel channel: <#${cfg.panel_channel_id}>`,
            ephemeral: true,
          });
        }

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

        const modal = new ModalBuilder().setCustomId("start_tournament_modal").setTitle("Start Tournament");
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
        if (!active) return interaction.reply({ content: "❌ No active tournament to end.", ephemeral: true });

        const resultsChannelId = cfg?.results_channel_id || interaction.channelId;

        await endTournament(interaction.guildId, active.id);
        await snapshotTournamentResults(interaction.guildId, active.id);
        await postFinalStandings(interaction.guild, resultsChannelId, active);

        // Update leaderboards + winners (monthly/yearly) after ending
        await updateAllLeaderboardEmbeds(interaction.guild);

        return interaction.reply({ content: `🛑 Ended **${active.name}**. Finals posted.`, ephemeral: true });
      }
    }

    // Modals
    if (interaction.isModalSubmit()) {
      if (interaction.customId === "set_channels_modal") {
        if (!isAdmin) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

        const panelText = interaction.fields.getTextInputValue("panel_ch")?.trim();
        const lbText = interaction.fields.getTextInputValue("lb_ch")?.trim();
        const resText = interaction.fields.getTextInputValue("res_ch")?.trim();

        const panelId = parseChannelIdFromText(panelText);
        const lbId = parseChannelIdFromText(lbText);
        const resId = parseChannelIdFromText(resText);

        if (!panelId || !lbId || !resId) {
          return interaction.reply({
            content: "❌ Couldn’t read one of the channels. Paste a real #channel mention or channel ID.",
            ephemeral: true,
          });
        }

        await upsertConfig(interaction.guildId, {
          panel_channel_id: panelId,
          leaderboard_channel_id: lbId,
          results_channel_id: resId,
          // Reset message IDs so we recreate them in the new leaderboard channel
          cur_bigbass_msg_id: null,
          cur_totalbag_msg_id: null,
          monthly_winners_msg_id: null,
          yearly_winners_msg_id: null,
        });

        // Ensure new leaderboard messages exist and update
        await ensureLeaderboardMessages(interaction.guild, lbId);
        await updateAllLeaderboardEmbeds(interaction.guild);

        return interaction.reply({
          content: `✅ Channels set.\nPanel: <#${panelId}>\nLeaderboards: <#${lbId}>\nResults: <#${resId}>`,
          ephemeral: true,
        });
      }

      if (interaction.customId === "start_tournament_modal") {
        if (!isAdmin) return interaction.reply({ content: "❌ Admins only.", ephemeral: true });

        const name = interaction.fields.getTextInputValue("name")?.trim();
        if (!name) return interaction.reply({ content: "❌ Tournament name required.", ephemeral: true });

        await startTournament(interaction.guildId, name);

        // Update leaderboards immediately
        await updateAllLeaderboardEmbeds(interaction.guild);

        return interaction.reply({ content: `✅ Started tournament: **${name}**`, ephemeral: true });
      }

      if (interaction.customId === "weighin_modal") {
        const cfg = await getConfig(interaction.guildId);
        const active = await getActiveTournament(interaction.guildId);

        if (cfg?.panel_channel_id && interaction.channelId !== cfg.panel_channel_id) {
          return interaction.reply({
            content: `❌ Submit weigh-ins in the panel channel: <#${cfg.panel_channel_id}>`,
            ephemeral: true,
          });
        }

        if (!active) return interaction.reply({ content: "❌ No active tournament.", ephemeral: true });

        const weightRaw = interaction.fields.getTextInputValue("weight")?.trim();
        const notes = interaction.fields.getTextInputValue("notes")?.trim() || null;

        const weight = Number(weightRaw);
        if (!Number.isFinite(weight) || weight <= 0) {
          return interaction.reply({ content: "❌ Weight must be a valid number (example: 5.62).", ephemeral: true });
        }

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

        await insertWeighIn({
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          tournamentId: active.id,
          userId: interaction.user.id,
          weightLbs: weight,
          photoUrl: latest.image_url,
          notes,
        });

        // Update current boards
        await updateAllLeaderboardEmbeds(interaction.guild);

        const receipt = new EmbedBuilder()
          .setTitle("✅ Weigh-in Submitted")
          .addFields(
            { name: "Tournament", value: `**${active.name}**`, inline: false },
            { name: "Angler", value: `<@${interaction.user.id}>`, inline: true },
            { name: "Weight", value: `**${formatLb(weight)} lbs**`, inline: true },
            { name: "Notes", value: notes || "—", inline: false }
          )
          .setImage(latest.image_url)
          .setTimestamp(new Date());

        return interaction.reply({ embeds: [receipt], ephemeral: true });
      }
    }
  } catch (err) {
    console.error(err);
    if (interaction.isRepliable()) {
      if (interaction.deferred || interaction.replied) {
        return interaction.followUp({ content: "❌ Something went wrong. Check logs.", ephemeral: true }).catch(() => {});
      }
      await interaction.reply({ content: "❌ Something went wrong. Check logs.", ephemeral: true }).catch(() => {});
    }
  }
});

// -------------------- START BOT --------------------
client.login(process.env.DISCORD_TOKEN);

