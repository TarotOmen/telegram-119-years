require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const sharp = require("sharp");
const QUESTIONS = require("./questions");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 10000;
const TWELVE_WEEKS_BOT_USERNAME = process.env.TWELVE_WEEKS_BOT_USERNAME || "";

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!DATABASE_URL) throw new Error("DATABASE_URL is missing");

const bot = new Telegraf(BOT_TOKEN);

bot.use(async (ctx, next) => {
  if (ctx.message?.text?.startsWith("/start")) {
    console.log(`TELEGRAM /start RECEIVED: user=${ctx.from?.id}`);
  }
  return next();
});

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
});

const app = express();
app.get("/", (_, res) => res.send("119 лет bot is running"));
app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log("HTTP server on " + PORT));

const TOTAL_WEEKS = 119 * 52;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

async function db(sql, params = []) {
  return pool.query(sql, params);
}

async function initDb() {
  await db(`
    CREATE TABLE IF NOT EXISTS life119_users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      first_name TEXT,
      birth_date DATE,
      life_expectancy_years INTEGER NOT NULL DEFAULT 119,
      life_years_selected BOOLEAN NOT NULL DEFAULT FALSE,
      awaiting_life_years BOOLEAN NOT NULL DEFAULT FALSE,
      started_at TIMESTAMPTZ,
      notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_notified_week INTEGER,
      pending_review_week INTEGER,
      current_question_id INTEGER,
      current_question_week INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE life119_users ADD COLUMN IF NOT EXISTS life_expectancy_years INTEGER NOT NULL DEFAULT 119;
    ALTER TABLE life119_users ADD COLUMN IF NOT EXISTS life_years_selected BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE life119_users ADD COLUMN IF NOT EXISTS awaiting_life_years BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE life119_users ADD COLUMN IF NOT EXISTS pending_review_week INTEGER;
    ALTER TABLE life119_users ADD COLUMN IF NOT EXISTS current_question_id INTEGER;
    ALTER TABLE life119_users ADD COLUMN IF NOT EXISTS current_question_week INTEGER;

    CREATE TABLE IF NOT EXISTS life119_answers (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      week_number INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (telegram_id, week_number)
    );

    CREATE TABLE IF NOT EXISTS life119_question_history (
      telegram_id BIGINT NOT NULL,
      question_id INTEGER NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (telegram_id, question_id)
    );

    CREATE TABLE IF NOT EXISTS life119_marks (
      telegram_id BIGINT NOT NULL,
      week_number INTEGER NOT NULL,
      mark TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (telegram_id, week_number)
    );
  `);

  // Safe migration for the first MVP version of life119_answers.
  await db(`ALTER TABLE life119_answers ADD COLUMN IF NOT EXISTS question_id INTEGER`);
  await db(`
    DELETE FROM life119_answers a
    USING life119_answers b
    WHERE a.id < b.id
      AND a.telegram_id = b.telegram_id
      AND a.week_number = b.week_number
  `);
  await db(`CREATE UNIQUE INDEX IF NOT EXISTS life119_answers_user_week_idx ON life119_answers (telegram_id, week_number)`);

  await db(`
    CREATE TABLE IF NOT EXISTS promo_119_referrals (
      telegram_id BIGINT PRIMARY KEY,
      referred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    )
  `);

  // Safe migration if an older 119 version created this table with another schema.
  await db(`
    ALTER TABLE promo_119_referrals
      ADD COLUMN IF NOT EXISTS referred_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ
  `);

  await db(`
    UPDATE promo_119_referrals
    SET referred_at = COALESCE(referred_at, NOW())
    WHERE referred_at IS NULL
  `);

  console.log(`119 tables ready; questions: ${QUESTIONS.length}`);
}

function parseBirthDate(value) {
  const match = String(value).match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (!match) return null;
  const [, dd, mm, yyyy] = match;
  const iso = `${yyyy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  const date = new Date(iso + "T00:00:00Z");
  if (Number.isNaN(date.getTime()) || date > new Date()) return null;
  // Reject impossible dates such as 31.02.1980.
  if (date.getUTCFullYear() !== Number(yyyy) || date.getUTCMonth() + 1 !== Number(mm) || date.getUTCDate() !== Number(dd)) return null;
  return iso;
}

function normalizeBirthDate(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate()
    };
  }

  const raw = String(value ?? "").trim();

  // PostgreSQL DATE normally comes back as YYYY-MM-DD.
  let m = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  }

  // Also accept DD.MM.YYYY / DD-MM-YYYY / DD/MM/YYYY.
  m = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);
  if (m) {
    return { year: Number(m[3]), month: Number(m[2]), day: Number(m[1]) };
  }

  return null;
}

function birthDateMs(birthDate) {
  const p = normalizeBirthDate(birthDate);
  if (!p || !Number.isInteger(p.year) || !Number.isInteger(p.month) || !Number.isInteger(p.day)) {
    return NaN;
  }

  const ms = Date.UTC(p.year, p.month - 1, p.day);
  const check = new Date(ms);
  if (
    check.getUTCFullYear() !== p.year ||
    check.getUTCMonth() + 1 !== p.month ||
    check.getUTCDate() !== p.day
  ) {
    return NaN;
  }
  return ms;
}

function elapsedDays(birthDate) {
  const birthMs = birthDateMs(birthDate);
  if (!Number.isFinite(birthMs)) {
    throw new Error(`Invalid birth_date: ${JSON.stringify(birthDate)}`);
  }
  return Math.max(0, Math.floor((Date.now() - birthMs) / MS_PER_DAY));
}

function livedWeeks(birthDate) {
  return Math.max(0, Math.floor(elapsedDays(birthDate) / 7));
}

function totalWeeks(years = 119) {
  return Math.max(1, Math.min(119, Number(years) || 119)) * 52;
}

function currentWeek(birthDate, years = 119) {
  return Math.min(totalWeeks(years), livedWeeks(birthDate) + 1);
}

function currentYearWeek(birthDate, years = 119) {
  return ((currentWeek(birthDate, years) - 1) % 52) + 1;
}

function stats(birthDate, years = 119) {
  const days = elapsedDays(birthDate);
  const weeks = Math.floor(days / 7);
  return {
    weeks,
    days,
    hours: days * 24,
    week: Math.min(totalWeeks(years), weeks + 1),
    yearWeek: ((weeks % 52) + 1)
  };
}

async function getUser(telegramId) {
  const r = await db("SELECT * FROM life119_users WHERE telegram_id=$1", [telegramId]);
  return r.rows[0];
}

async function ensureUser(ctx) {
  let u = await getUser(ctx.from.id);
  if (!u) {
    await db(
      "INSERT INTO life119_users (telegram_id, first_name) VALUES ($1,$2) ON CONFLICT (telegram_id) DO NOTHING",
      [ctx.from.id, ctx.from.first_name || ""]
    );
    u = await getUser(ctx.from.id);
  }
  return u;
}

function summaryText(birthDate) {
  const s = stats(birthDate);
  return `Прожито недель: ${s.weeks}\nПрожито дней: ${s.days}\nПрожито часов: ${s.hours}\nИдёт ${s.yearWeek} неделя текущего года.`;
}

async function makeMap(userId, birthDate, years = 119) {
  const s = stats(birthDate, years);
  const r = await db(
    "SELECT week_number, mark FROM life119_marks WHERE telegram_id=$1",
    [userId]
  );
  const marks = new Map(r.rows.map(x => [Number(x.week_number), x.mark]));

  // One row represents one year; each row contains 52 weeks.
  const width = 1240;
  const cols = 52;
  const rows = Math.max(1, Math.min(119, Number(years) || 119));
  const cell = 20;
  const gapX = 3;
  const gapY = 3;
  const gridW = cols * cell + (cols - 1) * gapX;
  const left = 38;
  const top = 250;
  const bottom = 105;
  const height = top + rows * cell + (rows - 1) * gapY + bottom;
  const startX = left;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="100%" height="100%" fill="#ffffff"/>

    <text x="38" y="58" fill="#101828" font-family="Arial, sans-serif" font-size="42" font-weight="800">${rows} лет</text>
    <text x="38" y="91" fill="#667085" font-family="Arial, sans-serif" font-size="22">52 недели в каждом году</text>

    <text x="38" y="136" fill="#101828" font-family="Arial, sans-serif" font-size="21" font-weight="700">${s.weeks}</text>
    <text x="38" y="162" fill="#667085" font-family="Arial, sans-serif" font-size="16">прожито недель</text>

    <text x="275" y="136" fill="#101828" font-family="Arial, sans-serif" font-size="21" font-weight="700">${s.days}</text>
    <text x="275" y="162" fill="#667085" font-family="Arial, sans-serif" font-size="16">прожито дней</text>

    <text x="505" y="136" fill="#101828" font-family="Arial, sans-serif" font-size="21" font-weight="700">${s.hours}</text>
    <text x="505" y="162" fill="#667085" font-family="Arial, sans-serif" font-size="16">прожито часов</text>

    <text x="810" y="136" fill="#101828" font-family="Arial, sans-serif" font-size="21" font-weight="700">${s.yearWeek}</text>
    <text x="810" y="162" fill="#667085" font-family="Arial, sans-serif" font-size="16">неделя текущего года</text>

    <line x1="38" y1="195" x2="1200" y2="195" stroke="#E4E7EC" stroke-width="2"/>

    <text x="38" y="228" fill="#98A2B3" font-family="Arial, sans-serif" font-size="14">ГОД</text>`;

  const xLabels = [1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50];
  for (const n of xLabels) {
    const col = n - 1;
    const x = startX + col * (cell + gapX) + cell / 2;
    svg += `<text x="${x}" y="228" text-anchor="middle" fill="#98A2B3" font-family="Arial, sans-serif" font-size="14">${n}</text>`;
  }

  for (let row = 0; row < rows; row++) {
    const year = row + 1;
    const y = top + row * (cell + gapY) + cell / 2;

    // A very light separator every 10 years makes the long map easier to read.
    if (year > 1 && year % 10 === 1) {
      svg += `<line x1="0" y1="${y - 13}" x2="1200" y2="${y - 13}" stroke="#F2F4F7" stroke-width="2"/>`;
    }

    if (year === 1 || year % 5 === 0 || year === rows) {
      svg += `<text x="28" y="${y + 5}" text-anchor="end" fill="#667085" font-family="Arial, sans-serif" font-size="14">${year}</text>`;
    }

    for (let col = 0; col < cols; col++) {
      const week = row * 52 + col + 1;
      const completed = week <= s.weeks;
      const fill = completed ? "#FF4D5A" : "#D9DEE7";
      const cx = startX + col * (cell + gapX) + cell / 2;
      const cy = y;
      const mark = marks.get(week);

      svg += `<circle cx="${cx}" cy="${cy}" r="${cell / 2}" fill="${fill}"/>`;

      if (mark === "star") {
        svg += `<circle cx="${cx}" cy="${cy}" r="7" fill="#FFC107"/>`;
      } else if (mark === "fire") {
        svg += `<circle cx="${cx}" cy="${cy}" r="7" fill="#FF7A00"/>`;
      }
    }
  }

  const ly = height - 58;
  svg += `
    <line x1="38" y1="${ly - 25}" x2="1200" y2="${ly - 25}" stroke="#E4E7EC" stroke-width="2"/>
    <circle cx="55" cy="${ly}" r="9" fill="#FF4D5A"/>
    <text x="75" y="${ly + 5}" fill="#667085" font-family="Arial, sans-serif" font-size="15">прожито</text>
    <circle cx="190" cy="${ly}" r="9" fill="#D9DEE7"/>
    <text x="210" y="${ly + 5}" fill="#667085" font-family="Arial, sans-serif" font-size="15">впереди</text>
    <circle cx="335" cy="${ly}" r="9" fill="#FFC107"/>
    <text x="355" y="${ly + 5}" fill="#667085" font-family="Arial, sans-serif" font-size="15">отмеченная неделя</text>
    <circle cx="555" cy="${ly}" r="9" fill="#FF7A00"/>
    <text x="575" y="${ly + 5}" fill="#667085" font-family="Arial, sans-serif" font-size="15">важная неделя</text>
  </svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function pickQuestion(userId, weekNumber) {
  const u = await getUser(userId);
  const existing = QUESTIONS.find(q => q.id === Number(u?.current_question_id));
  if (existing && Number(u.current_question_week) === Number(weekNumber)) {
    return existing;
  }

  const used = await db("SELECT question_id FROM life119_question_history WHERE telegram_id=$1", [userId]);
  const usedSet = new Set(used.rows.map(x => Number(x.question_id)));
  let available = QUESTIONS.filter(q => !usedSet.has(q.id));
  if (!available.length) {
    // If the whole bank was used, start a new random cycle.
    await db("DELETE FROM life119_question_history WHERE telegram_id=$1", [userId]);
    available = QUESTIONS.slice();
  }
  const q = available[Math.floor(Math.random() * available.length)];
  return q;
}

async function setQuestion(userId, weekNumber) {
  const q = await pickQuestion(userId, weekNumber);
  await db(
    `UPDATE life119_users SET current_question_id=$1, current_question_week=$2 WHERE telegram_id=$3`,
    [q.id, weekNumber, userId]
  );
  await db(
    `INSERT INTO life119_question_history (telegram_id, question_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [userId, q.id]
  );
  return q;
}

function questionKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔥 Важная неделя", "MARK_FIRE"), Markup.button.callback("⭐ Отметить", "MARK_STAR")],
  ]);
}

function weeklyQuestionKeyboard(weekNumber, showTwelveWeeks) {
  const rows = [
    [
      Markup.button.callback("🔥 Важная неделя", "MARK_FIRE"),
      Markup.button.callback("⭐ Отметить", "MARK_STAR")
    ]
  ];

  if (showTwelveWeeks && TWELVE_WEEKS_BOT_USERNAME) {
    rows.push([
      Markup.button.url(
        "🎯 Попробовать 12 недель",
        `https://t.me/${TWELVE_WEEKS_BOT_USERNAME}?start=from_119`
      )
    ]);
  }

  return Markup.inlineKeyboard(rows);
}

async function isUsingTwelveWeeks(telegramId) {
  const r = await db(
    "SELECT 1 FROM promo_119_referrals WHERE telegram_id=$1 AND used_at IS NOT NULL LIMIT 1",
    [telegramId]
  );
  return r.rowCount > 0;
}

async function sendPendingQuestion(ctx, user, weekNumber) {
  const q = await setQuestion(ctx.from.id, weekNumber);
  return ctx.reply(
    `Неделя №${weekNumber}\n\n${q.text}\n\nНапиши ответ одним сообщением — я сохраню его.`,
    questionKeyboard()
  );
}

async function sendQuestion(ctx) {
  const u = await ensureUser(ctx);
  if (!u?.birth_date) return ctx.reply("Сначала введи дату рождения через /start.");
  const activeWeek = currentWeek(u.birth_date, Number(u.life_expectancy_years) || 119);
  return sendPendingQuestion(ctx, u, activeWeek);
}

async function sendMap(ctx) {
  const u = await ensureUser(ctx);
  if (!u?.birth_date) return ctx.reply("Сначала введи дату рождения через /start.");
  const years = Number(u.life_expectancy_years) || 119;
  const img = await makeMap(ctx.from.id, u.birth_date, years);
  const s = stats(u.birth_date, years);
  return ctx.replyWithPhoto({ source: img }, {
    caption: `Прожито недель: ${s.weeks} из ${totalWeeks(years)}.\nПрожито дней: ${s.days}.\nПрожито часов: ${s.hours}.\nИдёт ${s.yearWeek} неделя текущего года.`,
    ...Markup.inlineKeyboard([[Markup.button.callback("❓ Вопрос недели", "QUESTION")]])
  });
}

bot.start(async ctx => {
  try {
    const u = await ensureUser(ctx);
    if (!u.birth_date) {
      if (!u.life_years_selected) {
        return ctx.reply(
          "На сколько лет показать карту жизни?",
          Markup.inlineKeyboard([
            [Markup.button.callback("60 лет", "YEARS_60"), Markup.button.callback("80 лет", "YEARS_80")],
            [Markup.button.callback("100 лет", "YEARS_100"), Markup.button.callback("119 лет", "YEARS_119")],
            [Markup.button.callback("Другое число", "YEARS_CUSTOM")]
          ])
        );
      }
      return ctx.reply(
        `Карта жизни на ${Number(u.life_expectancy_years) || 119} лет.\n\nНапиши дату рождения в формате ДД.ММ.ГГГГ.`,
        Markup.inlineKeyboard([[Markup.button.callback("📅 Ввести дату рождения", "BIRTH")]])
      );
    }
    return sendMap(ctx);
  } catch (e) {
    console.error("START ERROR", e);
    return ctx.reply("Не удалось запустить бота. Проверь логи Render.");
  }
});

bot.command("map", async ctx => {
  try { return await sendMap(ctx); }
  catch (e) { console.error("MAP ERROR", e); return ctx.reply("Не удалось построить карту."); }
});

bot.command("question", async ctx => {
  try { return await sendQuestion(ctx); }
  catch (e) { console.error("QUESTION ERROR", e); return ctx.reply("Не удалось получить вопрос."); }
});

for (const years of [60, 80, 100, 119]) {
  bot.action(`YEARS_${years}`, async ctx => {
    await ctx.answerCbQuery();
    await db("UPDATE life119_users SET life_expectancy_years=$1, life_years_selected=TRUE, awaiting_life_years=FALSE WHERE telegram_id=$2", [years, ctx.from.id]);
    await ctx.reply(`Карта жизни на ${years} лет.\n\nНапиши дату рождения в формате ДД.ММ.ГГГГ\nНапример: 12.05.1982`);
  });
}

bot.action("YEARS_CUSTOM", async ctx => {
  await ctx.answerCbQuery();
  await db("UPDATE life119_users SET awaiting_life_years=TRUE WHERE telegram_id=$1", [ctx.from.id]);
  await ctx.reply("Напиши число от 1 до 119 — сколько лет показать на карте.");
});

bot.action("BIRTH", async ctx => {
  await ctx.answerCbQuery();
  await ctx.reply("Напиши дату рождения в формате ДД.ММ.ГГГГ\nНапример: 12.05.1982");
});

bot.action("MAP", async ctx => {
  await ctx.answerCbQuery();
  try { return await sendMap(ctx); }
  catch (e) { console.error("MAP ACTION ERROR", e); return ctx.reply("Не удалось построить карту."); }
});

bot.action("QUESTION", async ctx => {
  await ctx.answerCbQuery();
  try { return await sendQuestion(ctx); }
  catch (e) { console.error("QUESTION ACTION ERROR", e); return ctx.reply("Не удалось получить вопрос."); }
});

async function markReviewedWeek(ctx, mark) {
  const u = await ensureUser(ctx);
  if (!u?.birth_date) return ctx.reply("Сначала введи дату рождения.");

  const completed = currentWeek(u.birth_date, Number(u.life_expectancy_years) || 119) - 1;
  if (completed < 1) return ctx.reply("Пока нечего оценивать — первая неделя ещё идёт.");

  const week = Math.min(u.pending_review_week || completed, completed);
  await db(
    `INSERT INTO life119_marks (telegram_id, week_number, mark)
     VALUES ($1,$2,$3)
     ON CONFLICT (telegram_id,week_number) DO UPDATE SET mark=EXCLUDED.mark`,
    [ctx.from.id, week, mark]
  );
  await db("UPDATE life119_users SET pending_review_week=NULL WHERE telegram_id=$1", [ctx.from.id]);

  return ctx.reply(mark === "fire" ? "🔥 Неделя №" + week + " отмечена как важная." : "⭐ Неделя №" + week + " отмечена.");
}

bot.action("MARK_FIRE", async ctx => { await ctx.answerCbQuery(); try { await markReviewedWeek(ctx, "fire"); } catch (e) { console.error("MARK FIRE ERROR", e); await ctx.reply("Не удалось отметить неделю."); } });
bot.action("MARK_STAR", async ctx => { await ctx.answerCbQuery(); try { await markReviewedWeek(ctx, "star"); } catch (e) { console.error("MARK STAR ERROR", e); await ctx.reply("Не удалось отметить неделю."); } });

bot.on("text", async ctx => {
  try {
    const u = await ensureUser(ctx);
    const text = ctx.message.text.trim();

    if (u.awaiting_life_years) {
      const years = Number(text);
      if (!Number.isInteger(years) || years < 1 || years > 119) {
        return ctx.reply("Введи целое число от 1 до 119.");
      }
      await db("UPDATE life119_users SET life_expectancy_years=$1, life_years_selected=TRUE, awaiting_life_years=FALSE WHERE telegram_id=$2", [years, ctx.from.id]);
      return ctx.reply(`Карта жизни на ${years} лет.\n\nТеперь напиши дату рождения в формате ДД.ММ.ГГГГ\nНапример: 12.05.1982`);
    }

    if (!u.birth_date) {
      const d = parseBirthDate(text);
      if (!d) return ctx.reply("Нужна корректная дата в формате ДД.ММ.ГГГГ");

      await db("UPDATE life119_users SET birth_date=$1, started_at=NOW() WHERE telegram_id=$2", [d, ctx.from.id]);
      const fresh = await getUser(ctx.from.id);
      const years = Number(fresh.life_expectancy_years) || 119;
      const img = await makeMap(ctx.from.id, d, years);
      await ctx.reply(`Готово. Это твоя карта жизни на ${years} лет.`);
      return ctx.replyWithPhoto({ source: img }, {
        caption: `Карта жизни: ${years} лет.\n${summaryText(d)}`,
        ...Markup.inlineKeyboard([[Markup.button.callback("❓ Первый вопрос", "QUESTION")]])
      });
    }

    const activeWeek = currentWeek(u.birth_date, Number(u.life_expectancy_years) || 119);
    if (u.current_question_id && u.current_question_week && Number(u.current_question_week) === activeWeek) {
      const q = QUESTIONS.find(x => x.id === Number(u.current_question_id));
      if (q) {
        await db(
          `INSERT INTO life119_answers (telegram_id, week_number, question_id, question, answer)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (telegram_id, week_number) DO UPDATE SET question_id=EXCLUDED.question_id, question=EXCLUDED.question, answer=EXCLUDED.answer, created_at=NOW()`,
          [ctx.from.id, u.current_question_week, q.id, q.text, text]
        );
        return ctx.reply("Сохранил. Вернёмся к этому ответу на следующей неделе.");
      }
    }

    return ctx.reply("Сейчас я не жду ответа. Нажми «❓ Вопрос недели», когда появится вопрос.");
  } catch (e) {
    console.error("TEXT ERROR", e);
    return ctx.reply("Не удалось сохранить сообщение. Проверь логи Render.");
  }
});

async function weeklyReview() {
  const r = await db("SELECT * FROM life119_users WHERE birth_date IS NOT NULL AND notify_enabled=TRUE");
  for (const u of r.rows) {
    const years = Number(u.life_expectancy_years) || 119;
    const completedWeek = currentWeek(u.birth_date, years) - 1;
    if (completedWeek < 1) continue;
    // Atomically claim this completed week before sending anything.
    // The conditional UPDATE is the single-winner gate across overlapping cron
    // runs and multiple Render instances. A week can be claimed only once.
    const claim = await db(
      `UPDATE life119_users
       SET last_notified_week=$1, pending_review_week=$1
       WHERE telegram_id=$2
         AND COALESCE(last_notified_week, 0) < $1
       RETURNING telegram_id`,
      [completedWeek, u.telegram_id]
    );
    if (claim.rowCount === 0) continue;

    const yearWeek = ((completedWeek - 1) % 52) + 1;
    const previousAnswerResult = await db(
      "SELECT question, answer FROM life119_answers WHERE telegram_id=$1 AND week_number=$2 LIMIT 1",
      [u.telegram_id, completedWeek]
    );
    const previousAnswer = previousAnswerResult.rows[0];
    const nextWeek = completedWeek + 1;
    const q = await setQuestion(u.telegram_id, nextWeek);
    const mapImage = await makeMap(u.telegram_id, u.birth_date, years);
    const s = stats(u.birth_date, years);
    const isUsingTwelveWeeksApp = await isUsingTwelveWeeks(u.telegram_id);

    // The weekly notification must include the actual life map, not a separate generic week graphic.
    await bot.telegram.sendPhoto(
      u.telegram_id,
      { source: mapImage },
      {
        caption: `Карта жизни: ${years} лет.\nПрожито недель: ${s.weeks} из ${totalWeeks(years)}.\nПрожито дней: ${s.days}.\nПрожито часов: ${s.hours}.\nИдёт ${s.yearWeek} неделя текущего года.`,
        disable_notification: false
      }
    );

    let message = `Неделя №${completedWeek} закончилась.\n${yearWeek} неделя текущего года.`;
    if (previousAnswer) {
      message += `\n\nТвой ответ на прошлой неделе:\n${previousAnswer.question}\nТвой ответ: «${previousAnswer.answer}»`;
    } else if (completedWeek > 1) {
      message += "\n\nНа прошлой неделе ответа не было сохранено.";
    }
    message += `\n\nТеперь можно оценить эту неделю.\n\nВопрос на неделю №${nextWeek}:\n${q.text}\n\nНапиши ответ одним сообщением — я сохраню его.`;

    await bot.telegram.sendMessage(
      u.telegram_id,
      message,
      { ...weeklyQuestionKeyboard(completedWeek, !isUsingTwelveWeeksApp), disable_notification: false }
    );

    console.log(`WEEKLY NOTIFICATION SENT: user=${u.telegram_id}, week=${completedWeek}, map=true, previousAnswer=${Boolean(previousAnswer)}`);
  }
}

// Проверяем каждые 12 минут. Оставляем polling через bot.launch().
cron.schedule("*/12 * * * *", async () => {
  try { await weeklyReview(); }
  catch (e) { console.error("CRON ERROR", e); }
}, { timezone: "Europe/Moscow" });

bot.catch((error, ctx) => {
  console.error("TELEGRAM UPDATE ERROR:", error);
  console.error("UPDATE TYPE:", ctx.updateType);
});

(async () => {
  try {
    console.log("119 bot startup: initializing database");
    await initDb();
    console.log("119 bot startup: database ready");

    const botInfo = await bot.telegram.getMe();
    console.log(`119 bot startup: Telegram authorization OK (@${botInfo.username})`);

    await bot.launch({ dropPendingUpdates: false });
    console.log("119 bot startup: Telegram polling started");
  } catch (error) {
    console.error("119 BOT STARTUP FAILED:", error);
    process.exit(1);
  }
})();

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
