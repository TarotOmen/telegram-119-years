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

app.get("/", (_, res) => {
  res.send("119 лет bot is running");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("HTTP server on " + PORT);
});

const TOTAL_WEEKS = 119 * 52;
const MS_PER_DAY = 24 * 60 * 60 * 1000;


/* =========================================================
   DATABASE
   ========================================================= */

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
      pending_review_week INTEGER,
      current_question_id INTEGER,
      current_question_week INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS pending_review_week INTEGER;

    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS current_question_id INTEGER;

    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS current_question_week INTEGER;

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

  await db(`
    ALTER TABLE life119_answers
    ADD COLUMN IF NOT EXISTS question_id INTEGER
  `);

  await db(`
    DELETE FROM life119_answers a
    USING life119_answers b
    WHERE a.id < b.id
      AND a.telegram_id = b.telegram_id
      AND a.week_number = b.week_number
  `);

  await db(`
    CREATE UNIQUE INDEX IF NOT EXISTS life119_answers_user_week_idx
    ON life119_answers (telegram_id, week_number)
  `);

  console.log(
    `119 tables ready; questions: ${QUESTIONS.length}`
  );
}


/* =========================================================
   DATE
   ========================================================= */

function parseBirthDate(value) {
  const match = String(value).trim().match(
    /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/
  );

  if (!match) return null;

  const [, dd, mm, yyyy] = match;

  const day = Number(dd);
  const month = Number(mm);
  const year = Number(yyyy);

  const iso =
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  const date = new Date(iso + "T00:00:00Z");

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  if (date > new Date()) {
    return null;
  }

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return iso;
}

function normalizeBirthDate(value) {
  if (
    value instanceof Date &&
    !Number.isNaN(value.getTime())
  ) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate()
    };
  }

  const raw = String(value ?? "").trim();

  let match = raw.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})/
  );

  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3])
    };
  }

  match = raw.match(
    /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/
  );

  if (match) {
    return {
      year: Number(match[3]),
      month: Number(match[2]),
      day: Number(match[1])
    };
  }

  return null;
}

function birthDateMs(birthDate) {
  const p = normalizeBirthDate(birthDate);

  if (
    !p ||
    !Number.isInteger(p.year) ||
    !Number.isInteger(p.month) ||
    !Number.isInteger(p.day)
  ) {
    return NaN;
  }

  const ms = Date.UTC(
    p.year,
    p.month - 1,
    p.day
  );

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
    throw new Error(
      `Invalid birth_date: ${JSON.stringify(birthDate)}`
    );
  }

  return Math.max(
    0,
    Math.floor(
      (Date.now() - birthMs) / MS_PER_DAY
    )
  );
}

function livedWeeks(birthDate) {
  return Math.max(
    0,
    Math.floor(
      elapsedDays(birthDate) / 7
    )
  );
}

function currentWeek(birthDate) {
  return Math.min(
    TOTAL_WEEKS,
    livedWeeks(birthDate) + 1
  );
}

function stats(birthDate) {
  const days = elapsedDays(birthDate);
  const weeks = Math.floor(days / 7);

  return {
    weeks,
    days,
    hours: days * 24,
    week: Math.min(
      TOTAL_WEEKS,
      weeks + 1
    ),
    yearWeek:
      ((weeks % 52) + 1)
  };
}


/* =========================================================
   USERS
   ========================================================= */

async function getUser(telegramId) {
  const result = await db(
    `
    SELECT *
    FROM life119_users
    WHERE telegram_id=$1
    `,
    [telegramId]
  );

  return result.rows[0];
}

async function ensureUser(ctx) {
  let user =
    await getUser(ctx.from.id);

  if (!user) {
    await db(
      `
      INSERT INTO life119_users
        (telegram_id, first_name)
      VALUES
        ($1,$2)
      ON CONFLICT (telegram_id)
      DO NOTHING
      `,
      [
        ctx.from.id,
        ctx.from.first_name || ""
      ]
    );

    user =
      await getUser(ctx.from.id);
  }

  return user;
}


/* =========================================================
   LIFE MAP
   ========================================================= */

async function makeMap(
  userId,
  birthDate
) {
  const s =
    stats(birthDate);

  const result =
    await db(
      `
      SELECT week_number, mark
      FROM life119_marks
      WHERE telegram_id=$1
      `,
      [userId]
    );

  const marks =
    new Map(
      result.rows.map(row => [
        Number(row.week_number),
        row.mark
      ])
    );

  const width = 1200;
  const cols = 52;
  const rows = 119;

  const cell = 20;
  const gapX = 3;
  const gapY = 3;

  const left = 45;
  const top = 235;
  const bottom = 90;

  const height =
    top +
    rows * cell +
    (rows - 1) * gapY +
    bottom;

  const startX = left;

  let svg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${height}"
    viewBox="0 0 ${width} ${height}"
  >

    <rect
      width="100%"
      height="100%"
      fill="#ffffff"
    />

    <text
      x="45"
      y="55"
      fill="#101828"
      font-family="Arial, sans-serif"
      font-size="40"
      font-weight="800"
    >
      119 лет
    </text>

    <text
      x="45"
      y="86"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="19"
    >
      52 недели в каждом году
    </text>

    <text
      x="45"
      y="132"
      fill="#101828"
      font-family="Arial, sans-serif"
      font-size="22"
      font-weight="700"
    >
      ${s.weeks}
    </text>

    <text
      x="45"
      y="156"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="15"
    >
      прожито недель
    </text>

    <text
      x="270"
      y="132"
      fill="#101828"
      font-family="Arial, sans-serif"
      font-size="22"
      font-weight="700"
    >
      ${s.days}
    </text>

    <text
      x="270"
      y="156"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="15"
    >
      прожито дней
    </text>

    <text
      x="495"
      y="132"
      fill="#101828"
      font-family="Arial, sans-serif"
      font-size="22"
      font-weight="700"
    >
      ${s.hours}
    </text>

    <text
      x="495"
      y="156"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="15"
    >
      прожито часов
    </text>

    <text
      x="790"
      y="132"
      fill="#101828"
      font-family="Arial, sans-serif"
      font-size="22"
      font-weight="700"
    >
      ${s.yearWeek}
    </text>

    <text
      x="790"
      y="156"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="15"
    >
      неделя текущего года
    </text>

    <line
      x1="45"
      y1="190"
      x2="1155"
      y2="190"
      stroke="#E4E7EC"
      stroke-width="2"
    />

    <text
      x="45"
      y="218"
      fill="#98A2B3"
      font-family="Arial, sans-serif"
      font-size="13"
    >
      ГОД
    </text>
  `;

  const xLabels = [
    1, 5, 10, 15, 20,
    25, 30, 35, 40,
    45, 50
  ];

  for (const number of xLabels) {
    const col = number - 1;

    const x =
      startX +
      col * (cell + gapX) +
      cell / 2;

    svg += `
      <text
        x="${x}"
        y="218"
        text-anchor="middle"
        fill="#98A2B3"
        font-family="Arial, sans-serif"
        font-size="13"
      >
        ${number}
      </text>
    `;
  }

  for (let row = 0; row < rows; row++) {
    const year = row + 1;

    const cy =
      top +
      row * (cell + gapY) +
      cell / 2;

    if (
      year === 1 ||
      year % 5 === 0 ||
      year === 119
    ) {
      svg += `
        <text
          x="35"
          y="${cy + 5}"
          text-anchor="end"
          fill="#667085"
          font-family="Arial, sans-serif"
          font-size="13"
        >
          ${year}
        </text>
      `;
    }

    for (let col = 0; col < cols; col++) {
      const week =
        row * 52 +
        col +
        1;

      const cx =
        startX +
        col * (cell + gapX) +
        cell / 2;

      const completed =
        week <= s.weeks;

      const fill =
        completed
          ? "#FF4D5A"
          : "#D9DEE7";

      svg += `
        <circle
          cx="${cx}"
          cy="${cy}"
          r="${cell / 2}"
          fill="${fill}"
        />
      `;

      const mark =
        marks.get(week);

      if (mark === "star") {
        svg += `
          <circle
            cx="${cx}"
            cy="${cy}"
            r="7"
            fill="#FFC107"
          />
        `;
      }

      if (mark === "fire") {
        svg += `
          <circle
            cx="${cx}"
            cy="${cy}"
            r="7"
            fill="#FF7A00"
          />
        `;
      }
    }
  }

  const legendY =
    height - 48;

  svg += `
    <line
      x1="45"
      y1="${legendY - 25}"
      x2="1155"
      y2="${legendY - 25}"
      stroke="#E4E7EC"
      stroke-width="2"
    />

    <circle
      cx="60"
      cy="${legendY}"
      r="8"
      fill="#FF4D5A"
    />

    <text
      x="78"
      y="${legendY + 5}"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="14"
    >
      прожито
    </text>

    <circle
      cx="185"
      cy="${legendY}"
      r="8"
      fill="#D9DEE7"
    />

    <text
      x="203"
      y="${legendY + 5}"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="14"
    >
      впереди
    </text>

    <circle
      cx="335"
      cy="${legendY}"
      r="8"
      fill="#FFC107"
    />

    <text
      x="353"
      y="${legendY + 5}"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="14"
    >
      отмеченная
    </text>

    <circle
      cx="495"
      cy="${legendY}"
      r="8"
      fill="#FF7A00"
    />

    <text
      x="513"
      y="${legendY + 5}"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="14"
    >
      важная
    </text>

  </svg>
  `;

  // JPEG вместо огромного PNG.
  // Это значительно надёжнее для отправки через Telegram.
  return sharp(
    Buffer.from(svg)
  )
    .jpeg({
      quality: 88,
      chromaSubsampling: "4:4:4"
    })
    .toBuffer();
}


/* =========================================================
   WEEK IMAGE
   ========================================================= */

async function makeWeekImage(
  weekNumber,
  yearWeek
) {
  const width = 1080;
  const height = 620;

  const progress =
    Math.min(
      52,
      ((weekNumber - 1) % 52) + 1
    );

  let svg = `
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width="${width}"
    height="${height}"
  >

    <rect
      width="100%"
      height="100%"
      fill="#ffffff"
    />

    <rect
      x="45"
      y="45"
      width="990"
      height="530"
      rx="30"
      fill="#f8fafc"
      stroke="#d9dee7"
      stroke-width="3"
    />

    <text
      x="85"
      y="125"
      fill="#111827"
      font-family="Arial, sans-serif"
      font-size="34"
      font-weight="800"
    >
      Неделя №${weekNumber}
    </text>

    <text
      x="85"
      y="175"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="23"
    >
      ${yearWeek} неделя текущего года
    </text>

    <text
      x="85"
      y="245"
      fill="#111827"
      font-family="Arial, sans-serif"
      font-size="29"
      font-weight="700"
    >
      Эта неделя уже стала частью твоей жизни.
    </text>

    <text
      x="85"
      y="295"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="21"
    >
      Оцени её, пока она ещё свежа в памяти.
    </text>
  `;

  const startX = 88;
  const y = 390;

  for (let i = 0; i < 52; i++) {
    const x =
      startX +
      i * 18;

    const fill =
      i < progress
        ? "#FF4D5A"
        : "#D9DEE7";

    svg += `
      <circle
        cx="${x}"
        cy="${y}"
        r="10"
        fill="${fill}"
      />
    `;
  }

  svg += `
    <circle
      cx="${startX + (progress - 1) * 18}"
      cy="${y}"
      r="14"
      fill="none"
      stroke="#111827"
      stroke-width="3"
    />

    <text
      x="85"
      y="475"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="19"
    >
      119 лет · 52 недели в году
    </text>

  </svg>
  `;

  return sharp(
    Buffer.from(svg)
  )
    .jpeg({
      quality: 88,
      chromaSubsampling: "4:4:4"
    })
    .toBuffer();
}


/* =========================================================
   QUESTIONS
   ========================================================= */

async function pickQuestion(
  userId,
  weekNumber
) {
  const user =
    await getUser(userId);

  const existing =
    QUESTIONS.find(
      q =>
        q.id ===
        Number(
          user?.current_question_id
        )
    );

  if (
    existing &&
    Number(
      user.current_question_week
    ) === Number(weekNumber)
  ) {
    return existing;
  }

  const result =
    await db(
      `
      SELECT question_id
      FROM life119_question_history
      WHERE telegram_id=$1
      `,
      [userId]
    );

  const used =
    new Set(
      result.rows.map(
        row =>
          Number(row.question_id)
      )
    );

  let available =
    QUESTIONS.filter(
      q => !used.has(q.id)
    );

  if (!available.length) {
    await db(
      `
      DELETE FROM life119_question_history
      WHERE telegram_id=$1
      `,
      [userId]
    );

    available =
      QUESTIONS.slice();
  }

  return available[
    Math.floor(
      Math.random() *
      available.length
    )
  ];
}

async function setQuestion(
  userId,
  weekNumber
) {
  const q =
    await pickQuestion(
      userId,
      weekNumber
    );

  await db(
    `
    UPDATE life119_users
    SET
      current_question_id=$1,
      current_question_week=$2
    WHERE telegram_id=$3
    `,
    [
      q.id,
      weekNumber,
      userId
    ]
  );

  await db(
    `
    INSERT INTO life119_question_history
      (telegram_id, question_id)
    VALUES
      ($1,$2)
    ON CONFLICT DO NOTHING
    `,
    [
      userId,
      q.id
    ]
  );

  return q;
}

function questionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔥 Важная неделя",
        "MARK_FIRE"
      ),
      Markup.button.callback(
        "⭐ Отметить",
        "MARK_STAR"
      )
    ]
  ]);
}

async function sendQuestion(ctx) {
  const user =
    await ensureUser(ctx);

  if (!user?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения через /start."
    );
  }

  const completed =
    currentWeek(
      user.birth_date
    ) - 1;

  if (completed < 1) {
    return ctx.reply(
      "Первая неделя ещё не закончилась. Вернись сюда после неё — тогда появится вопрос недели."
    );
  }

  const reviewWeek =
    user.pending_review_week ||
    completed;

  const q =
    await setQuestion(
      ctx.from.id,
      reviewWeek
    );

  return ctx.reply(
    `Неделя №${reviewWeek}\n\n${q.text}\n\nНапиши ответ одним сообщением — я сохраню его.`,
    questionKeyboard()
  );
}


/* =========================================================
   MAP MESSAGE
   ========================================================= */

async function sendMap(ctx) {
  const user =
    await ensureUser(ctx);

  if (!user?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения через /start."
    );
  }

  const image =
    await makeMap(
      ctx.from.id,
      user.birth_date
    );

  const s =
    stats(user.birth_date);

  return ctx.replyWithPhoto(
    {
      source: image
    },
    {
      caption:
        `119 ЛЕТ\n\n` +
        `Прожито недель: ${s.weeks} из ${TOTAL_WEEKS}.\n` +
        `Прожито дней: ${s.days}.\n` +
        `Прожито часов: ${s.hours}.\n` +
        `Идёт ${s.yearWeek} неделя текущего года.`,

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
}


/* =========================================================
   START
   ========================================================= */

bot.start(
  async ctx => {
    try {
      const user =
        await ensureUser(ctx);

      if (!user.birth_date) {
        return ctx.reply(
          "119 ЛЕТ\n\n" +
          "Твоя жизнь уже идёт. " +
          "Я покажу её в неделях — 119 лет на одной карте.\n\n" +
          "Напиши дату рождения в формате ДД.ММ.ГГГГ.",

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

      // Только одно сообщение:
      // сразу карта с подписью.
      return sendMap(ctx);

    } catch (error) {
      console.error(
        "START ERROR",
        error
      );

      return ctx.reply(
        "Не удалось запустить бота. Проверь логи Render."
      );
    }
  }
);


/* =========================================================
   COMMANDS
   ========================================================= */

bot.command(
  "map",
  async ctx => {
    try {
      return await sendMap(ctx);
    } catch (error) {
      console.error(
        "MAP ERROR",
        error
      );

      return ctx.reply(
        "Не удалось построить карту."
      );
    }
  }
);

bot.command(
  "question",
  async ctx => {
    try {
      return await sendQuestion(ctx);
    } catch (error) {
      console.error(
        "QUESTION ERROR",
        error
      );

      return ctx.reply(
        "Не удалось получить вопрос."
      );
    }
  }
);


/* =========================================================
   BIRTH
   ========================================================= */

bot.action(
  "BIRTH",
  async ctx => {
    await ctx.answerCbQuery();

    return ctx.reply(
      "Напиши дату рождения в формате ДД.ММ.ГГГГ\n" +
      "Например: 12.05.1982"
    );
  }
);


/* =========================================================
   QUESTION BUTTON
   ========================================================= */

bot.action(
  "QUESTION",
  async ctx => {
    await ctx.answerCbQuery();

    try {
      return await sendQuestion(ctx);
    } catch (error) {
      console.error(
        "QUESTION ACTION ERROR",
        error
      );

      return ctx.reply(
        "Не удалось получить вопрос."
      );
    }
  }
);


/* =========================================================
   MARKS
   ========================================================= */

async function markReviewedWeek(
  ctx,
  mark
) {
  const user =
    await ensureUser(ctx);

  if (!user?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения."
    );
  }

  const completed =
    currentWeek(
      user.birth_date
    ) - 1;

  if (completed < 1) {
    return ctx.reply(
      "Пока нечего оценивать — первая неделя ещё идёт."
    );
  }

  const week =
    Math.min(
      user.pending_review_week ||
        completed,
      completed
    );

  await db(
    `
    INSERT INTO life119_marks
      (telegram_id, week_number, mark)
    VALUES
      ($1,$2,$3)
    ON CONFLICT
      (telegram_id, week_number)
    DO UPDATE SET
      mark=EXCLUDED.mark
    `,
    [
      ctx.from.id,
      week,
      mark
    ]
  );

  await db(
    `
    UPDATE life119_users
    SET pending_review_week=NULL
    WHERE telegram_id=$1
    `,
    [ctx.from.id]
  );

  return ctx.reply(
    mark === "fire"
      ? `🔥 Неделя №${week} отмечена как важная.`
      : `⭐ Неделя №${week} отмечена.`
  );
}

bot.action(
  "MARK_FIRE",
  async ctx => {
    await ctx.answerCbQuery();

    try {
      await markReviewedWeek(
        ctx,
        "fire"
      );
    } catch (error) {
      console.error(
        "MARK FIRE ERROR",
        error
      );

      await ctx.reply(
        "Не удалось отметить неделю."
      );
    }
  }
);

bot.action(
  "MARK_STAR",
  async ctx => {
    await ctx.answerCbQuery();

    try {
      await markReviewedWeek(
        ctx,
        "star"
      );
    } catch (error) {
      console.error(
        "MARK STAR ERROR",
        error
      );

      await ctx.reply(
        "Не удалось отметить неделю."
      );
    }
  }
);


/* =========================================================
   TEXT
   ========================================================= */

bot.on(
  "text",
  async ctx => {
    try {
      const user =
        await ensureUser(ctx);

      const text =
        ctx.message.text.trim();

      /*
       * Дата рождения ещё не задана.
       */
      if (!user.birth_date) {
        const birthDate =
          parseBirthDate(text);

        if (!birthDate) {
          return ctx.reply(
            "Нужна корректная дата в формате ДД.ММ.ГГГГ"
          );
        }

        await db(
          `
          UPDATE life119_users
          SET
            birth_date=$1,
            started_at=NOW()
          WHERE telegram_id=$2
          `,
          [
            birthDate,
            ctx.from.id
          ]
        );

        const image =
          await makeMap(
            ctx.from.id,
            birthDate
          );

        const s =
          stats(birthDate);

        // Сразу одна фотография.
        return ctx.replyWithPhoto(
          {
            source: image
          },
          {
            caption:
              `119 ЛЕТ\n\n` +
              `Прожито недель: ${s.weeks} из ${TOTAL_WEEKS}.\n` +
              `Прожито дней: ${s.days}.\n` +
              `Прожито часов: ${s.hours}.\n` +
              `Идёт ${s.yearWeek} неделя текущего года.`,

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

      /*
       * Ответ пользователя на текущий вопрос.
       */
      const completed =
        currentWeek(
          user.birth_date
        ) - 1;

      if (
        user.current_question_id &&
        user.current_question_week &&
        user.current_question_week <=
          completed
      ) {
        const question =
          QUESTIONS.find(
            q =>
              q.id ===
              Number(
                user.current_question_id
              )
          );

        if (question) {
          await db(
            `
            INSERT INTO life119_answers
              (
                telegram_id,
                week_number,
                question_id,
                question,
                answer
              )
            VALUES
              ($1,$2,$3,$4,$5)
            ON CONFLICT
              (telegram_id, week_number)
            DO UPDATE SET
              question_id=EXCLUDED.question_id,
              question=EXCLUDED.question,
              answer=EXCLUDED.answer,
              created_at=NOW()
            `,
            [
              ctx.from.id,
              user.current_question_week,
              question.id,
              question.text,
              text
            ]
          );

          return ctx.reply(
            "Сохранил. Вернёмся к этому ответу на следующей неделе."
          );
        }
      }

      return ctx.reply(
        "Сейчас я не жду ответа. Нажми «❓ Вопрос недели», когда появится вопрос."
      );

    } catch (error) {
      console.error(
        "TEXT ERROR",
        error
      );

      return ctx.reply(
        "Не удалось сохранить сообщение. Проверь логи Render."
      );
    }
  }
);


/* =========================================================
   WEEKLY NOTIFICATION
   ========================================================= */

async function weeklyReview() {
  const result =
    await db(
      `
      SELECT *
      FROM life119_users
      WHERE birth_date IS NOT NULL
        AND notify_enabled=TRUE
      `
    );

  for (const user of result.rows) {
    const nowWeek =
      currentWeek(
        user.birth_date
      );

    const completedWeek =
      nowWeek - 1;

    if (completedWeek < 1) {
      continue;
    }

    if (
      Number(
        user.last_notified_week || 0
      ) >= completedWeek
    ) {
      continue;
    }

    const yearWeek =
      ((completedWeek - 1) % 52) + 1;

    const question =
      await setQuestion(
        user.telegram_id,
        completedWeek
      );

    const image =
      await makeWeekImage(
        completedWeek,
        yearWeek
      );

    /*
     * ВАЖНО:
     * одно Telegram-сообщение.
     *
     * Картинка
     * + подпись с вопросом
     * + кнопки.
     *
     * Отдельного sendMessage здесь НЕТ.
     */
    await bot.telegram.sendPhoto(
      user.telegram_id,
      {
        source: image
      },
      {
        caption:
          `Неделя №${completedWeek} закончилась.\n\n` +
          `${question.text}\n\n` +
          `Напиши ответ одним сообщением — я сохраню его.`,

        ...questionKeyboard()
      }
    );

    await db(
      `
      UPDATE life119_users
      SET
        last_notified_week=$1,
        pending_review_week=$2
      WHERE telegram_id=$3
      `,
      [
        completedWeek,
        completedWeek,
        user.telegram_id
      ]
    );
  }
}


/* =========================================================
   CRON
   ========================================================= */

cron.schedule(
  "0 * * * *",

  async () => {
    try {
      await weeklyReview();
    } catch (error) {
      console.error(
        "CRON ERROR",
        error
      );
    }
  },

  {
    timezone: "Europe/Moscow"
  }
);


/* =========================================================
   START
   ========================================================= */

(async () => {
  try {
    await initDb();

    await bot.launch();

    console.log(
      "119 years bot started"
    );
  } catch (error) {
    console.error(
      "FATAL START ERROR",
      error
    );

    process.exit(1);
  }
})();

process.once(
  "SIGINT",
  () => bot.stop("SIGINT")
);

process.once(
  "SIGTERM",
  () => bot.stop("SIGTERM")
);
