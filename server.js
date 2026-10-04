require("dotenv").config();

const express = require("express");
const cron = require("node-cron");
const { Telegraf, Markup } = require("telegraf");
const { Pool } = require("pg");
const sharp = require("sharp");

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) throw new Error("BOT_TOKEN is missing");
if (!DATABASE_URL) throw new Error("DATABASE_URL is missing");

const bot = new Telegraf(BOT_TOKEN);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

const app = express();

app.get("/", (_, res) => res.send("119 лет bot is running"));
app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log("HTTP server on " + PORT));

const QUESTIONS = [
  "Что ты откладываешь уже слишком долго?",
  "Что ты хочешь успеть изменить до следующей недели?",
  "Кому ты давно хотел позвонить?",
  "Что сейчас занимает твоё время, но уже ничего тебе не даёт?",
  "Если бы следующая неделя была особенно важной — на что бы ты её потратил?",
  "Что ты давно понимаешь, но всё ещё не делаешь?",
  "Что из сделанного на этой неделе действительно имело значение?",
  "От чего тебе пора отказаться?",
  "Что ты хочешь запомнить об этой неделе?",
  "Какой один шаг сделает следующую неделю лучше?"
];

const TOTAL_WEEKS = 119 * 52;

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
      started_at TIMESTAMPTZ,
      notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_notified_week INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS life119_answers (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      week_number INTEGER NOT NULL,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS life119_marks (
      telegram_id BIGINT NOT NULL,
      week_number INTEGER NOT NULL,
      mark TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (telegram_id, week_number)
    );
  `);

  console.log("119 tables ready");
}

function livedWeeks(birthDate) {
  const birth = new Date(String(birthDate) + "T00:00:00Z");

  return Math.max(
    0,
    Math.floor((Date.now() - birth.getTime()) / 604800000)
  );
}

function getWeekNumber(birthDate) {
  return Math.min(
    TOTAL_WEEKS,
    livedWeeks(birthDate) + 1
  );
}

async function getUser(telegramId) {
  const r = await db(
    "SELECT * FROM life119_users WHERE telegram_id=$1",
    [telegramId]
  );

  return r.rows[0];
}

async function makeMap(userId, currentWeek) {
  const r = await db(
    "SELECT week_number, mark FROM life119_marks WHERE telegram_id=$1",
    [userId]
  );

  const marks = new Map(
    r.rows.map(x => [Number(x.week_number), x.mark])
  );

  const cell = 15;
  const gap = 3;
  const left = 30;
  const top = 52;

  const W = left + 52 * (cell + gap) + 12;
  const H = top + 119 * (cell + gap) + 10;

  let svg = `
    <svg xmlns="http://www.w3.org/2000/svg"
      width="${W}" height="${H}">

      <rect width="100%" height="100%" fill="#0b0d12"/>

      <text
        x="${left}"
        y="22"
        fill="#fff"
        font-family="Arial"
        font-size="18"
        font-weight="700">
        119 лет твоей жизни
      </text>

      <text
        x="${left}"
        y="40"
        fill="#8f96a3"
        font-family="Arial"
        font-size="10">
        один кружок — одна неделя
      </text>
  `;

  for (let row = 0; row < 119; row++) {
    for (let col = 0; col < 52; col++) {

      const week = row * 52 + col + 1;

      let fill =
        week < currentWeek
          ? "#d94343"
          : week === currentWeek
            ? "#f2b84b"
            : "#252a33";

      const mark = marks.get(week);

      if (mark === "star") fill = "#806be8";
      if (mark === "fire") fill = "#ff7138";

      const cx =
        left +
        col * (cell + gap) +
        cell / 2;

      const cy =
        top +
        row * (cell + gap) +
        cell / 2;

      svg += `
        <circle
          cx="${cx}"
          cy="${cy}"
          r="${cell / 2 - 1}"
          fill="${fill}"
        />
      `;

      if (mark === "star") {
        svg += `
          <text
            x="${cx}"
            y="${cy + 4}"
            text-anchor="middle"
            fill="#fff"
            font-size="10">
            ★
          </text>
        `;
      }
    }
  }

  svg += "</svg>";

  return sharp(Buffer.from(svg))
    .png()
    .toBuffer();
}

async function sendQuestion(ctx) {
  const u = await getUser(ctx.from.id);

  if (!u || !u.birth_date) {
    return ctx.reply(
      "Сначала напиши дату рождения через /start."
    );
  }

  const week = getWeekNumber(u.birth_date);
  const q = QUESTIONS[(week - 1) % QUESTIONS.length];

  return ctx.reply(
    `Неделя №${week}\n\n${q}\n\nНапиши ответ одним сообщением — я сохраню его.`,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "🔥 Важная неделя",
          "MARK_FIRE"
        ),
        Markup.button.callback(
          "★ Отметить",
          "MARK_STAR"
        )
      ],
      [
        Markup.button.callback(
          "📊 Моя карта",
          "MAP"
        )
      ]
    ])
  );
}

bot.start(async ctx => {
  try {
    let u = await getUser(ctx.from.id);

    if (!u) {
      await db(
        `INSERT INTO life119_users
        (telegram_id, first_name)
        VALUES ($1,$2)
        ON CONFLICT (telegram_id)
        DO NOTHING`,
        [
          ctx.from.id,
          ctx.from.first_name || ""
        ]
      );

      u = await getUser(ctx.from.id);
    }

    if (!u.birth_date) {
      return ctx.reply(
        `119 ЛЕТ

Твоя жизнь уже идёт.
Я покажу её в неделях — 119 лет на одной карте.

Напиши дату рождения в формате ДД.ММ.ГГГГ.`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "📅 Ввести дату рождения",
              "BIRTH"
            )
          ]
        ])
      );
    }

    return ctx.reply(
      `119 ЛЕТ

Прожито недель: ${livedWeeks(u.birth_date)}.`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📊 Моя карта",
            "MAP"
          )
        ],
        [
          Markup.button.callback(
            "❓ Вопрос недели",
            "QUESTION"
          )
        ]
      ])
    );

  } catch (e) {
    console.error("START ERROR", e);

    return ctx.reply(
      "Не удалось запустить бота. Проверь логи Render."
    );
  }
});

bot.command("map", async ctx => {
  try {
    const u = await getUser(ctx.from.id);

    if (!u?.birth_date) {
      return ctx.reply("Сначала /start.");
    }

    const week = getWeekNumber(u.birth_date);

    const img = await makeMap(
      ctx.from.id,
      week
    );

    return ctx.replyWithPhoto(
      { source: img },
      {
        caption:
          `Прожито недель: ${livedWeeks(u.birth_date)} из ${TOTAL_WEEKS}.`,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "❓ Вопрос недели",
              "QUESTION"
            )
          ]
        ])
      }
    );

  } catch (e) {
    console.error("MAP ERROR", e);
    return ctx.reply(
      "Не удалось построить карту."
    );
  }
});

bot.command("question", sendQuestion);

bot.action("BIRTH", async ctx => {
  await ctx.answerCbQuery();

  await ctx.reply(
    "Напиши дату рождения в формате ДД.ММ.ГГГГ\nНапример: 12.05.1982"
  );
});

bot.action("MAP", async ctx => {
  await ctx.answerCbQuery();

  const u = await getUser(ctx.from.id);

  if (!u?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения."
    );
  }

  const week = getWeekNumber(u.birth_date);

  const img = await makeMap(
    ctx.from.id,
    week
  );

  await ctx.replyWithPhoto(
    { source: img },
    {
      caption:
        `Прожито недель: ${livedWeeks(u.birth_date)} из ${TOTAL_WEEKS}.`,
      ...Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "❓ Вопрос недели",
            "QUESTION"
          )
        ]
      ])
    }
  );
});

bot.action("QUESTION", async ctx => {
  await ctx.answerCbQuery();
  await sendQuestion(ctx);
});

async function markCurrent(ctx, mark) {
  const u = await getUser(ctx.from.id);

  if (!u?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения."
    );
  }

  const week = getWeekNumber(u.birth_date);

  await db(
    `INSERT INTO life119_marks
    (telegram_id, week_number, mark)
    VALUES ($1,$2,$3)
    ON CONFLICT (telegram_id,week_number)
    DO UPDATE SET mark=EXCLUDED.mark`,
    [
      ctx.from.id,
      week,
      mark
    ]
  );

  await ctx.reply(
    mark === "fire"
      ? "🔥 Неделя отмечена как важная."
      : "★ Неделя отмечена."
  );
}

bot.action("MARK_FIRE", async ctx => {
  await ctx.answerCbQuery();
  await markCurrent(ctx, "fire");
});

bot.action("MARK_STAR", async ctx => {
  await ctx.answerCbQuery();
  await markCurrent(ctx, "star");
});

bot.on("text", async ctx => {
  const u = await getUser(ctx.from.id);

  if (!u) return;

  const text = ctx.message.text.trim();

  if (!u.birth_date) {

    const m = text.match(
      /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/
    );

    if (!m) {
      return ctx.reply(
        "Нужна дата в формате ДД.ММ.ГГГГ"
      );
    }

    const d =
      `${m[3]}-${String(m[2]).padStart(2, "0")}-${String(m[1]).padStart(2, "0")}`;

    const date =
      new Date(d + "T00:00:00Z");

    if (
      Number.isNaN(date.getTime()) ||
      date > new Date()
    ) {
      return ctx.reply(
        "Проверь дату рождения."
      );
    }

    await db(
      `UPDATE life119_users
       SET birth_date=$1, started_at=NOW()
       WHERE telegram_id=$2`,
      [d, ctx.from.id]
    );

    const week = getWeekNumber(d);

    const img = await makeMap(
      ctx.from.id,
      week
    );

    await ctx.reply(
      "Готово. Это твоя карта жизни на 119 лет."
    );

    return ctx.replyWithPhoto(
      { source: img },
      {
        caption:
          `Прожито: ${livedWeeks(d)} недель. Текущая неделя: №${week}.`,
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "❓ Первый вопрос",
              "QUESTION"
            )
          ]
        ])
      }
    );
  }

  const week =
    getWeekNumber(u.birth_date);

  const q =
    QUESTIONS[(week - 1) % QUESTIONS.length];

  await db(
    `INSERT INTO life119_answers
    (telegram_id,week_number,question,answer)
    VALUES ($1,$2,$3,$4)`,
    [
      ctx.from.id,
      week,
      q,
      text
    ]
  );

  await ctx.reply(
    "Сохранил. Вернёмся к этому ответу на следующей неделе.",
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "📊 Моя карта",
          "MAP"
        )
      ]
    ])
  );
});

cron.schedule(
  "0 17 * * 0",
  async () => {
    try {

      const r = await db(
        `SELECT *
         FROM life119_users
         WHERE birth_date IS NOT NULL
         AND notify_enabled=TRUE`
      );

      for (const u of r.rows) {

        const week =
          getWeekNumber(u.birth_date);

        if (
          u.last_notified_week === week
        ) {
          continue;
        }

        await bot.telegram.sendMessage(
          u.telegram_id,
          `Прошла ещё одна неделя. Сейчас твоя неделя №${week}.\n\n${QUESTIONS[(week - 1) % QUESTIONS.length]}`
        );

        await db(
          `UPDATE life119_users
           SET last_notified_week=$1
           WHERE telegram_id=$2`,
          [
            week,
            u.telegram_id
          ]
        );
      }

    } catch (e) {
      console.error(
        "CRON ERROR",
        e
      );
    }

  },
  {
    timezone: "Europe/Moscow"
  }
);

(async () => {

  await initDb();

  await bot.launch();

  console.log(
    "119 years bot started"
  );

})();

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
