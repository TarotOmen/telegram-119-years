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
      started_at TIMESTAMPTZ,
      notify_enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_notified_week INTEGER,
      pending_review_week INTEGER,
      current_question_id INTEGER,
      current_question_week INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

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

  await db(`ALTER TABLE life119_answers ADD COLUMN IF NOT EXISTS question_id INTEGER`);

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

  console.log(`119 tables ready; questions: ${QUESTIONS.length}`);
}


/* =========================================================
   DATE HANDLING
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

  if (Number.isNaN(date.getTime())) return null;
  if (date > new Date()) return null;

  // Проверяем невозможные даты:
  // 31.02.1980, 32.01.1980 и т.д.
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
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      year: value.getUTCFullYear(),
      month: value.getUTCMonth() + 1,
      day: value.getUTCDate()
    };
  }

  const raw = String(value ?? "").trim();

  // PostgreSQL DATE:
  // YYYY-MM-DD
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

  // DD.MM.YYYY
  // DD-MM-YYYY
  // DD/MM/YYYY
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
  const parsed = normalizeBirthDate(birthDate);

  if (
    !parsed ||
    !Number.isInteger(parsed.year) ||
    !Number.isInteger(parsed.month) ||
    !Number.isInteger(parsed.day)
  ) {
    return NaN;
  }

  const ms = Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day
  );

  const check = new Date(ms);

  if (
    check.getUTCFullYear() !== parsed.year ||
    check.getUTCMonth() + 1 !== parsed.month ||
    check.getUTCDate() !== parsed.day
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
    Math.floor(elapsedDays(birthDate) / 7)
  );
}


function currentWeek(birthDate) {
  return Math.min(
    TOTAL_WEEKS,
    livedWeeks(birthDate) + 1
  );
}


function currentYearWeek(birthDate) {
  return (
    (currentWeek(birthDate) - 1) % 52
  ) + 1;
}


function stats(birthDate) {
  const days = elapsedDays(birthDate);
  const weeks = Math.floor(days / 7);

  return {
    weeks,
    days,
    hours: days * 24,
    week: Math.min(TOTAL_WEEKS, weeks + 1),
    yearWeek: ((weeks % 52) + 1)
  };
}


/* =========================================================
   DATABASE / USER
   ========================================================= */

async function getUser(telegramId) {
  const result = await db(
    "SELECT * FROM life119_users WHERE telegram_id=$1",
    [telegramId]
  );

  return result.rows[0];
}


async function ensureUser(ctx) {
  let user = await getUser(ctx.from.id);

  if (!user) {
    await db(
      `
      INSERT INTO life119_users
        (telegram_id, first_name)
      VALUES
        ($1, $2)
      ON CONFLICT (telegram_id) DO NOTHING
      `,
      [
        ctx.from.id,
        ctx.from.first_name || ""
      ]
    );

    user = await getUser(ctx.from.id);
  }

  return user;
}


/* =========================================================
   TEXT
   ========================================================= */

function summaryText(birthDate) {
  const s = stats(birthDate);

  return (
    `Прожито недель: ${s.weeks}\n` +
    `Прожито дней: ${s.days}\n` +
    `Прожито часов: ${s.hours}\n` +
    `Идёт ${s.yearWeek} неделя текущего года.`
  );
}


/* =========================================================
   LIFE MAP
   ========================================================= */

async function makeMap(userId, birthDate) {
  const s = stats(birthDate);

  const result = await db(
    `
    SELECT week_number, mark
    FROM life119_marks
    WHERE telegram_id=$1
    `,
    [userId]
  );

  const marks = new Map(
    result.rows.map(row => [
      Number(row.week_number),
      row.mark
    ])
  );

  const width = 1080;

  const left = 78;
  const right = 35;

  const top = 170;
  const bottom = 115;

  const cols = 52;
  const rows = 119;

  const cell = 14;

  const gapX = 5;
  const gapY = 7;

  const gridW =
    cols * cell +
    (cols - 1) * gapX;

  const height =
    top +
    rows * cell +
    (rows - 1) * gapY +
    bottom;

  const startX =
    left +
    Math.max(
      0,
      (width - left - right - gridW) / 2
    );

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
      x="60"
      y="58"
      fill="#111827"
      font-family="Arial, sans-serif"
      font-size="42"
      font-weight="800"
    >
      119 лет
    </text>

    <text
      x="60"
      y="91"
      fill="#667085"
      font-family="Arial, sans-serif"
      font-size="21"
      font-weight="600"
    >
      твоя жизнь в неделях
    </text>

    <rect
      x="55"
      y="112"
      width="970"
      height="54"
      rx="16"
      fill="#ffffff"
      stroke="#d9dee7"
      stroke-width="2"
    />

    <text
      x="78"
      y="136"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      Прожито недель:
    </text>

    <text
      x="240"
      y="149"
      fill="#111827"
      font-family="Arial, sans-serif"
      font-size="28"
      font-weight="800"
    >
      ${s.weeks}
    </text>

    <line
      x1="395"
      y1="123"
      x2="395"
      y2="155"
      stroke="#d9dee7"
      stroke-width="2"
    />

    <text
      x="425"
      y="136"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      Прожито дней:
    </text>

    <text
      x="548"
      y="149"
      fill="#111827"
      font-family="Arial, sans-serif"
      font-size="25"
      font-weight="800"
    >
      ${s.days}
    </text>

    <text
      x="650"
      y="136"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      Прожито часов:
    </text>

    <text
      x="785"
      y="149"
      fill="#111827"
      font-family="Arial, sans-serif"
      font-size="25"
      font-weight="800"
    >
      ${s.hours}
    </text>

    <text
      x="930"
      y="148"
      text-anchor="end"
      fill="#111827"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      Идёт ${s.yearWeek} неделя
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
        y="190"
        text-anchor="middle"
        fill="#667085"
        font-family="Arial, sans-serif"
        font-size="15"
      >
        ${number}
      </text>
    `;
  }


  for (let row = 0; row < rows; row++) {
    const year = row + 1;

    const y =
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
          x="45"
          y="${y + 5}"
          text-anchor="end"
          fill="#667085"
          font-family="Arial, sans-serif"
          font-size="14"
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

      const completed =
        week <= s.weeks;

      const fill =
        completed
          ? "#ff3b45"
          : "#c8d1dd";

      const cx =
        startX +
        col * (cell + gapX) +
        cell / 2;

      const cy = y;

      const mark =
        marks.get(week);

      svg += `
        <circle
          cx="${cx}"
          cy="${cy}"
          r="${cell / 2}"
          fill="${fill}"
        />
      `;


      if (mark === "star") {
        svg += `
          <text
            x="${cx}"
            y="${cy + 6}"
            text-anchor="middle"
            fill="#ffbf00"
            stroke="#111827"
            stroke-width="1.2"
            paint-order="stroke"
            font-family="Arial, sans-serif"
            font-size="23"
          >
            ★
          </text>
        `;
      }

      else if (mark === "fire") {
        svg += `
          <text
            x="${cx}"
            y="${cy + 6}"
            text-anchor="middle"
            font-size="22"
          >
            🔥
          </text>
        `;
      }
    }
  }


  const ly = height - 66;

  svg += `
    <rect
      x="55"
      y="${ly - 20}"
      width="970"
      height="55"
      rx="16"
      fill="#ffffff"
      stroke="#d9dee7"
      stroke-width="2"
    />

    <circle
      cx="90"
      cy="${ly + 7}"
      r="10"
      fill="#ff3b45"
    />

    <text
      x="112"
      y="${ly + 13}"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      прожито
    </text>

    <circle
      cx="285"
      cy="${ly + 7}"
      r="10"
      fill="#c8d1dd"
    />

    <text
      x="307"
      y="${ly + 13}"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      впереди
    </text>

    <text
      x="505"
      y="${ly + 14}"
      font-size="23"
    >
      🔥
    </text>

    <text
      x="535"
      y="${ly + 13}"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      важная неделя
    </text>

    <text
      x="755"
      y="${ly + 14}"
      fill="#ffbf00"
      stroke="#111827"
      stroke-width="1.1"
      paint-order="stroke"
      font-family="Arial, sans-serif"
      font-size="23"
    >
      ★
    </text>

    <text
      x="785"
      y="${ly + 13}"
      fill="#344054"
      font-family="Arial, sans-serif"
      font-size="16"
    >
      отмеченная неделя
    </text>

  </svg>
  `;

  return sharp(
    Buffer.from(svg)
  ).png().toBuffer();
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

  const col =
    (weekNumber - 1) % 52;

  const progress =
    Math.min(52, col + 1);

  const radius = 22;

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
        ? "#ff3b45"
        : "#c8d1dd";

    svg += `
      <circle
        cx="${x}"
        cy="${y}"
        r="${radius / 2}"
        fill="${fill}"
      />
    `;
  }


  svg += `
    <circle
      cx="${startX + (progress - 1) * 18}"
      cy="${y}"
      r="${radius / 2 + 4}"
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

    <text
      x="85"
      y="525"
      fill="#98a2b3"
      font-family="Arial, sans-serif"
      font-size="18"
    >
      🔥 важная · ⭐ отмеченная
    </text>

  </svg>
  `;

  return sharp(
    Buffer.from(svg)
  ).png().toBuffer();
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
        Number(user?.current_question_id)
    );

  if (
    existing &&
    Number(user.current_question_week) ===
      Number(weekNumber)
  ) {
    return existing;
  }


  const used =
    await db(
      `
      SELECT question_id
      FROM life119_question_history
      WHERE telegram_id=$1
      `,
      [userId]
    );

  const usedSet =
    new Set(
      used.rows.map(
        x => Number(x.question_id)
      )
    );

  let available =
    QUESTIONS.filter(
      q => !usedSet.has(q.id)
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


  const q =
    available[
      Math.floor(
        Math.random() *
        available.length
      )
    ];

  return q;
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


/* =========================================================
   KEYBOARDS
   ========================================================= */

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
    ],
    [
      Markup.button.callback(
        "📊 Моя карта",
        "MAP"
      )
    ]
  ]);
}


/* =========================================================
   QUESTIONS / MAP
   ========================================================= */

async function sendPendingQuestion(
  ctx,
  user,
  weekNumber
) {
  const q =
    await setQuestion(
      ctx.from.id,
      weekNumber
    );

  return ctx.reply(
    `Неделя №${weekNumber}\n\n${q.text}\n\nНапиши ответ одним сообщением — я сохраню его.`,
    questionKeyboard()
  );
}


async function sendQuestion(ctx) {
  const u =
    await ensureUser(ctx);

  if (!u?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения через /start."
    );
  }

  const completed =
    currentWeek(u.birth_date) - 1;

  if (completed < 1) {
    return ctx.reply(
      "Первая неделя ещё не закончилась. Вернись сюда после неё — тогда появится вопрос недели."
    );
  }

  const reviewWeek =
    u.pending_review_week ||
    completed;

  return sendPendingQuestion(
    ctx,
    u,
    reviewWeek
  );
}


async function sendMap(ctx) {
  const u =
    await ensureUser(ctx);

  if (!u?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения через /start."
    );
  }

  const img =
    await makeMap(
      ctx.from.id,
      u.birth_date
    );

  const s =
    stats(u.birth_date);

  return ctx.replyWithPhoto(
    { source: img },
    {
      caption:
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
      const u =
        await ensureUser(ctx);

      if (!u.birth_date) {
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

      return ctx.reply(
        `119 ЛЕТ\n\n${summaryText(
          u.birth_date
        )}`,

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
      console.error(
        "START ERROR",
        e
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
    } catch (e) {
      console.error(
        "MAP ERROR",
        e
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
    } catch (e) {
      console.error(
        "QUESTION ERROR",
        e
      );

      return ctx.reply(
        "Не удалось получить вопрос."
      );
    }
  }
);


/* =========================================================
   CALLBACKS
   ========================================================= */

bot.action(
  "BIRTH",
  async ctx => {
    await ctx.answerCbQuery();

    await ctx.reply(
      "Напиши дату рождения в формате ДД.ММ.ГГГГ\n" +
      "Например: 12.05.1982"
    );
  }
);


bot.action(
  "MAP",
  async ctx => {
    await ctx.answerCbQuery();

    try {
      return await sendMap(ctx);
    } catch (e) {
      console.error(
        "MAP ACTION ERROR",
        e
      );

      return ctx.reply(
        "Не удалось построить карту."
      );
    }
  }
);


bot.action(
  "QUESTION",
  async ctx => {
    await ctx.answerCbQuery();

    try {
      return await sendQuestion(ctx);
    } catch (e) {
      console.error(
        "QUESTION ACTION ERROR",
        e
      );

      return ctx.reply(
        "Не удалось получить вопрос."
      );
    }
  }
);


/* =========================================================
   WEEK MARKS
   ========================================================= */

async function markReviewedWeek(
  ctx,
  mark
) {
  const u =
    await ensureUser(ctx);

  if (!u?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения."
    );
  }

  const completed =
    currentWeek(u.birth_date) - 1;

  if (completed < 1) {
    return ctx.reply(
      "Пока нечего оценивать — первая неделя ещё идёт."
    );
  }

  const week =
    Math.min(
      u.pending_review_week ||
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
      (telegram_id,week_number)

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

  if (mark === "fire") {
    return ctx.reply(
      "🔥 Неделя №" +
      week +
      " отмечена как важная."
    );
  }

  return ctx.reply(
    "⭐ Неделя №" +
    week +
    " отмечена."
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
    } catch (e) {
      console.error(
        "MARK FIRE ERROR",
        e
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
    } catch (e) {
      console.error(
        "MARK STAR ERROR",
        e
      );

      await ctx.reply(
        "Не удалось отметить неделю."
      );
    }
  }
);


/* =========================================================
   TEXT MESSAGES
   ========================================================= */

bot.on(
  "text",
  async ctx => {
    try {
      const u =
        await ensureUser(ctx);

      const text =
        ctx.message.text.trim();


      /*
       * Пользователь ещё не указал дату рождения.
       */
      if (!u.birth_date) {
        const d =
          parseBirthDate(text);

        if (!d) {
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
            d,
            ctx.from.id
          ]
        );

        const fresh =
          await getUser(
            ctx.from.id
          );

        const s =
          stats(d);

        const img =
          await makeMap(
            ctx.from.id,
            d
          );

        await ctx.reply(
          "Готово. Это твоя карта жизни на 119 лет."
        );

        return ctx.replyWithPhoto(
          { source: img },
          {
            caption:
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
       * Ответ на вопрос недели.
       */
      const completed =
        currentWeek(u.birth_date) - 1;

      if (
        u.current_question_id &&
        u.current_question_week &&
        u.current_question_week <=
          completed
      ) {
        const q =
          QUESTIONS.find(
            x =>
              x.id ===
              Number(
                u.current_question_id
              )
          );

        if (q) {
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
              u.current_question_week,
              q.id,
              q.text,
              text
            ]
          );

          return ctx.reply(
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
        }
      }


      return ctx.reply(
        "Сейчас я не жду ответа. Нажми «❓ Вопрос недели», когда появится вопрос."
      );

    } catch (e) {
      console.error(
        "TEXT ERROR",
        e
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

  for (const u of result.rows) {
    const nowWeek =
      currentWeek(
        u.birth_date
      );

    const completedWeek =
      nowWeek - 1;

    if (completedWeek < 1) {
      continue;
    }

    if (
      Number(
        u.last_notified_week || 0
      ) >= completedWeek
    ) {
      continue;
    }

    const yearWeek =
      ((completedWeek - 1) % 52) + 1;

    const q =
      await setQuestion(
        u.telegram_id,
        completedWeek
      );

    const img =
      await makeWeekImage(
        completedWeek,
        yearWeek
      );


    await bot.telegram.sendMessage(
      u.telegram_id,

      `Неделя №${completedWeek} закончилась.\n\n` +
      `Теперь можно её оценить.\n\n` +
      `${q.text}\n\n` +
      `Напиши ответ одним сообщением — я сохраню его.`,

      questionKeyboard()
    );


    await bot.telegram.sendPhoto(
      u.telegram_id,

      { source: img },

      {
        caption:
          `Неделя №${completedWeek}. ` +
          `${yearWeek} неделя текущего года.`
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
        u.telegram_id
      ]
    );
  }
}


/* =========================================================
   CRON
   ========================================================= */

// Проверяем каждый час.
// Для точной доставки на бесплатном Render
// лучше позже вынести этот запуск в Render Cron.

cron.schedule(
  "0 * * * *",

  async () => {
    try {
      await weeklyReview();
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


/* =========================================================
   START BOT
   ========================================================= */

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
