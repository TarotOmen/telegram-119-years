const express = require('express');
const cron = require('node-cron');
const { Telegraf, Markup } = require('telegraf');
const { Pool } = require('pg');
const sharp = require('sharp');
const questions = require('./questions');

const BOT_TOKEN = process.env.BOT_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = Number(process.env.PORT || 10000);

const PUBLIC_URL = 'https://telegram-119-years.onrender.com';
const WEBHOOK_PATH = '/telegram-webhook-119-years-7f3c';

if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set');
}

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

const app = express();

app.use(express.json({ limit: '1mb' }));

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

const bot = new Telegraf(BOT_TOKEN);

// ==================================================
// HELPERS
// ==================================================

function pad(n) {
  return String(n).padStart(2, '0');
}

function parseDob(value) {
  const s = String(value || '').trim();

  let d = null;
  let m;

  m = s.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/);

  if (m) {
    d = new Date(
      Date.UTC(
        Number(m[3]),
        Number(m[2]) - 1,
        Number(m[1])
      )
    );
  }

  if (!d || Number.isNaN(d.getTime())) {
    m = s.match(/^(\d{4})[.\/-](\d{1,2})[.\/-](\d{1,2})$/);

    if (m) {
      d = new Date(
        Date.UTC(
          Number(m[1]),
          Number(m[2]) - 1,
          Number(m[3])
        )
      );
    }
  }

  if (!d || Number.isNaN(d.getTime())) {
    return null;
  }

  if (d.getUTCFullYear() < 1900) {
    return null;
  }

  if (d > new Date()) {
    return null;
  }

  return `${d.getUTCFullYear()}-${pad(
    d.getUTCMonth() + 1
  )}-${pad(d.getUTCDate())}`;
}

function dateOnly(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  const s = String(value);

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return s.slice(0, 10);
  }

  return parseDob(s);
}

function daysBetween(startDateString, endDate = new Date()) {
  const [y, m, d] =
    startDateString.split('-').map(Number);

  const start =
    Date.UTC(y, m - 1, d);

  const end =
    Date.UTC(
      endDate.getFullYear(),
      endDate.getMonth(),
      endDate.getDate()
    );

  return Math.max(
    0,
    Math.floor(
      (end - start) / 86400000
    )
  );
}

function getStats(dob) {
  const days = daysBetween(dob);
  const weeks = Math.floor(days / 7);
  const hours = days * 24;

  const now = new Date();

  const yearStart =
    Date.UTC(
      now.getFullYear(),
      0,
      1
    );

  const today =
    Date.UTC(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );

  const yearDays =
    Math.floor(
      (today - yearStart) / 86400000
    );

  const yearWeek =
    Math.floor(yearDays / 7) + 1;

  return {
    days,
    weeks,
    hours,
    yearWeek,
    totalWeeks: 119 * 52,
  };
}

// ==================================================
// KEYBOARDS
// ==================================================

function userKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '❓ Вопрос недели',
        'QUESTION_WEEK'
      ),
    ],
  ]);
}

function questionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '🔥 Важная неделя',
        'MARK_FIRE'
      ),
      Markup.button.callback(
        '⭐ Отметить',
        'MARK_STAR'
      ),
    ],
  ]);
}

// ==================================================
// DATABASE
// ==================================================

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS life119_users (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT UNIQUE NOT NULL,
      username TEXT,
      first_name TEXT,
      dob DATE,
      last_notified_week INTEGER NOT NULL DEFAULT 0,
      awaiting_dob BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS last_notified_week
        INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS awaiting_dob
        BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS updated_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS life119_answers (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL,
      week_number INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      answer TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      UNIQUE (telegram_id, week_number)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS life119_question_history (
      telegram_id BIGINT NOT NULL,
      question_id INTEGER NOT NULL,
      used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        telegram_id,
        question_id
      )
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS life119_marks (
      telegram_id BIGINT NOT NULL,
      week_number INTEGER NOT NULL,
      mark TEXT NOT NULL
        CHECK (mark IN ('star', 'fire')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

      PRIMARY KEY (
        telegram_id,
        week_number,
        mark
      )
    )
  `);
}

async function getUser(telegramId) {
  const result = await pool.query(
    `
      SELECT *
      FROM life119_users
      WHERE telegram_id = $1
    `,
    [telegramId]
  );

  return result.rows[0] || null;
}

async function upsertUser(ctx, extra = {}) {
  const from = ctx.from;

  const result = await pool.query(
    `
      INSERT INTO life119_users
        (
          telegram_id,
          username,
          first_name,
          dob,
          awaiting_dob,
          updated_at
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          COALESCE($5, FALSE),
          NOW()
        )

      ON CONFLICT (telegram_id)
      DO UPDATE SET
        username = EXCLUDED.username,
        first_name = EXCLUDED.first_name,

        dob = COALESCE(
          EXCLUDED.dob,
          life119_users.dob
        ),

        awaiting_dob = COALESCE(
          $5,
          life119_users.awaiting_dob
        ),

        updated_at = NOW()

      RETURNING *
    `,
    [
      from.id,
      from.username || null,
      from.first_name || null,
      extra.dob || null,
      extra.awaiting_dob ?? null,
    ]
  );

  return result.rows[0];
}

// ==================================================
// MAP
// ==================================================

function svgText(
  text,
  x,
  y,
  size,
  weight = 400,
  anchor = 'start'
) {
  const escaped = String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  return `
    <text
      x="${x}"
      y="${y}"
      font-family="Arial, sans-serif"
      font-size="${size}px"
      font-weight="${weight}"
      text-anchor="${anchor}"
      fill="#111"
    >${escaped}</text>
  `;
}

async function makeMap(dob, telegramId) {
  const stats = getStats(dob);

  const marksResult = await pool.query(
    `
      SELECT week_number, mark
      FROM life119_marks
      WHERE telegram_id = $1
    `,
    [telegramId]
  );

  const marks = new Map();

  for (const row of marksResult.rows) {
    if (!marks.has(row.week_number)) {
      marks.set(
        row.week_number,
        new Set()
      );
    }

    marks
      .get(row.week_number)
      .add(row.mark);
  }

  const cols = 52;
  const rows = 119;

  const cell = 11;
  const radius = 4.1;

  const left = 16;
  const top = 108;

  const width =
    left * 2 +
    cols * cell;

  const height =
    top +
    rows * cell +
    18;

  let circles = '';

  for (
    let year = 0;
    year < rows;
    year++
  ) {
    for (
      let week = 0;
      week < cols;
      week++
    ) {
      const index =
        year * cols +
        week +
        1;

      const lived =
        index <= stats.weeks;

      const cx =
        left +
        week * cell +
        cell / 2;

      const cy =
        top +
        year * cell +
        cell / 2;

      const fill =
        lived
          ? '#d63b3b'
          : '#d7d7d7';

      const markSet =
        marks.get(index);

      circles += `
        <circle
          cx="${cx}"
          cy="${cy}"
          r="${radius}"
          fill="${fill}"
        />
      `;

      if (markSet?.has('fire')) {
        circles += `
          <circle
            cx="${cx}"
            cy="${cy}"
            r="2"
            fill="#ff8a00"
          />
        `;
      } else if (markSet?.has('star')) {
        circles += `
          <circle
            cx="${cx}"
            cy="${cy}"
            r="2"
            fill="#ffd21f"
          />
        `;
      }
    }
  }

  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}"
    >

      <rect
        width="100%"
        height="100%"
        fill="white"
      />

      ${svgText(
        `Прожито недель: ${stats.weeks}`,
        16,
        25,
        16,
        700
      )}

      ${svgText(
        `Прожито дней: ${stats.days}`,
        16,
        48,
        16,
        700
      )}

      ${svgText(
        `Прожито часов: ${stats.hours}`,
        16,
        71,
        16,
        700
      )}

      ${svgText(
        `Идёт ${stats.yearWeek} неделя текущего года`,
        16,
        94,
        15,
        600
      )}

      ${circles}

    </svg>
  `;

  return sharp(
    Buffer.from(svg)
  )
    .jpeg({
      quality: 88,
      chromaSubsampling: '4:4:4',
    })
    .toBuffer();
}

// ==================================================
// WEEK IMAGE
// ==================================================

async function makeWeekImage(
  weekNumber,
  dob
) {
  const stats = getStats(dob);

  const width = 900;
  const height = 500;

  const year =
    Math.floor(
      (weekNumber - 1) / 52
    ) + 1;

  const weekInYear =
    ((weekNumber - 1) % 52) + 1;

  const svg = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="${width}"
      height="${height}"
      viewBox="0 0 ${width} ${height}"
    >

      <rect
        width="100%"
        height="100%"
        fill="white"
      />

      <circle
        cx="450"
        cy="175"
        r="82"
        fill="#d63b3b"
      />

      ${svgText(
        `НЕДЕЛЯ ${weekNumber}`,
        450,
        305,
        38,
        700,
        'middle'
      )}

      ${svgText(
        `год жизни ${year}  •  неделя ${weekInYear}`,
        450,
        350,
        24,
        500,
        'middle'
      )}

      ${svgText(
        `Всего прожито: ${stats.weeks} недель`,
        450,
        400,
        21,
        400,
        'middle'
      )}

    </svg>
  `;

  return sharp(
    Buffer.from(svg)
  )
    .jpeg({
      quality: 88,
      chromaSubsampling: '4:4:4',
    })
    .toBuffer();
}

// ==================================================
// QUESTIONS
// ==================================================

async function pickQuestion(telegramId) {
  if (!questions.length) {
    throw new Error(
      'questions.js is empty'
    );
  }

  let result = await pool.query(
    `
      SELECT
        q.id,
        q.category,
        q.text

      FROM jsonb_to_recordset(
        $1::jsonb
      ) AS q(
        id INTEGER,
        category TEXT,
        text TEXT
      )

      WHERE NOT EXISTS (
        SELECT 1
        FROM life119_question_history h
        WHERE
          h.telegram_id = $2
          AND h.question_id = q.id
      )

      ORDER BY random()
      LIMIT 1
    `,
    [
      JSON.stringify(questions),
      telegramId,
    ]
  );

  if (!result.rows[0]) {
    await pool.query(
      `
        DELETE FROM life119_question_history
        WHERE telegram_id = $1
      `,
      [telegramId]
    );

    result = await pool.query(
      `
        SELECT
          q.id,
          q.category,
          q.text

        FROM jsonb_to_recordset(
          $1::jsonb
        ) AS q(
          id INTEGER,
          category TEXT,
          text TEXT
        )

        ORDER BY random()
        LIMIT 1
      `,
      [JSON.stringify(questions)]
    );
  }

  const question =
    result.rows[0];

  await pool.query(
    `
      INSERT INTO life119_question_history
        (
          telegram_id,
          question_id
        )
      VALUES
        ($1, $2)

      ON CONFLICT DO NOTHING
    `,
    [
      telegramId,
      question.id,
    ]
  );

  return question;
}

// ==================================================
// ANSWERS
// ==================================================

async function getAnswerForWeek(
  telegramId,
  weekNumber
) {
  const result = await pool.query(
    `
      SELECT
        answer,
        question_id,
        created_at

      FROM life119_answers

      WHERE
        telegram_id = $1
        AND week_number = $2
    `,
    [
      telegramId,
      weekNumber,
    ]
  );

  return result.rows[0] || null;
}

// ==================================================
// SEND MAP
// ==================================================

async function sendMap(ctx) {
  const user =
    await getUser(ctx.from.id);

  if (!user?.dob) {
    await ctx.reply(
      'Сначала укажи дату рождения в формате ДД.ММ.ГГГГ.'
    );
    return;
  }

  const dob =
    dateOnly(user.dob);

  const stats =
    getStats(dob);

  const image =
    await makeMap(
      dob,
      ctx.from.id
    );

  await ctx.replyWithPhoto(
    {
      source: image,
    },
    {
      caption:
        `119 ЛЕТ\n\n` +
        `Прожито недель: ${stats.weeks}\n` +
        `Прожито дней: ${stats.days}\n` +
        `Прожито часов: ${stats.hours}`,

      ...userKeyboard(),
    }
  );
}

// ==================================================
// SEND QUESTION
// ==================================================

async function sendQuestion(
  ctx,
  weekNumberOverride = null
) {
  const user =
    await getUser(ctx.from.id);

  if (!user?.dob) {
    await ctx.reply(
      'Сначала укажи дату рождения в формате ДД.ММ.ГГГГ.'
    );
    return;
  }

  const dob =
    dateOnly(user.dob);

  const stats =
    getStats(dob);

  const weekNumber =
    weekNumberOverride ||
    Math.max(
      1,
      stats.weeks + 1
    );

  const question =
    await pickQuestion(
      ctx.from.id
    );

  const previous =
    weekNumber > 1
      ? await getAnswerForWeek(
          ctx.from.id,
          weekNumber - 1
        )
      : null;

  let text =
    `Неделя №${weekNumber}\n\n` +
    `${question.text}\n\n` +
    `Напиши ответ одним сообщением — я сохраню его.`;

  if (previous?.answer) {
    const short =
      previous.answer.length > 220
        ? previous.answer.slice(0, 217) + '…'
        : previous.answer;

    text +=
      `\n\nТвой ответ прошлой недели:` +
      `\n«${short}»`;
  }

  await ctx.replyWithPhoto(
    {
      source:
        await makeWeekImage(
          weekNumber,
          dob
        ),
    },
    {
      caption: text,
      ...questionKeyboard(),
    }
  );
}

// ==================================================
// MARK
// ==================================================

async function markWeek(
  ctx,
  mark
) {
  const user =
    await getUser(ctx.from.id);

  if (!user?.dob) {
    await ctx.answerCbQuery(
      'Сначала укажи дату рождения'
    );
    return;
  }

  const stats =
    getStats(
      dateOnly(user.dob)
    );

  if (stats.weeks < 1) {
    await ctx.answerCbQuery(
      'Первая неделя ещё не закончилась'
    );
    return;
  }

  const weekNumber =
    stats.weeks;

  await pool.query(
    `
      INSERT INTO life119_marks
        (
          telegram_id,
          week_number,
          mark
        )
      VALUES
        ($1, $2, $3)

      ON CONFLICT DO NOTHING
    `,
    [
      ctx.from.id,
      weekNumber,
      mark,
    ]
  );

  await ctx.answerCbQuery(
    mark === 'fire'
      ? '🔥 Неделя отмечена'
      : '⭐ Неделя отмечена'
  );
}

// ==================================================
// ERROR HANDLER
// ==================================================

bot.catch((err, ctx) => {
  console.error(
    'BOT ERROR',
    ctx?.update?.update_id,
    err
  );
});

// ==================================================
// START
// ==================================================

bot.start(async (ctx) => {
  try {
    const existing =
      await getUser(ctx.from.id);

    if (existing?.dob) {
      await upsertUser(ctx);
      await sendMap(ctx);
      return;
    }

    await upsertUser(
      ctx,
      {
        awaiting_dob: true,
      }
    );

    await ctx.reply(
      '119 ЛЕТ\n\n' +
      'Укажи дату рождения в формате ДД.ММ.ГГГГ.\n\n' +
      'Я покажу карту твоей жизни из 119 лет и недель.'
    );

  } catch (error) {
    console.error(
      '/start ERROR',
      error
    );

    try {
      await ctx.reply(
        'Не удалось открыть карту. Попробуй ещё раз.'
      );
    } catch (_) {}
  }
});

// ==================================================
// QUESTION BUTTON
// ==================================================

bot.action(
  'QUESTION_WEEK',
  async (ctx) => {
    try {
      await ctx.answerCbQuery();

      await sendQuestion(ctx);

    } catch (error) {
      console.error(
        'QUESTION_WEEK ERROR',
        error
      );

      try {
        await ctx.reply(
          'Не удалось получить вопрос. Попробуй ещё раз.'
        );
      } catch (_) {}
    }
  }
);

// ==================================================
// FIRE BUTTON
// ==================================================

bot.action(
  'MARK_FIRE',
  async (ctx) => {
    try {
      await markWeek(
        ctx,
        'fire'
      );

    } catch (error) {
      console.error(
        'MARK_FIRE ERROR',
        error
      );

      try {
        await ctx.answerCbQuery(
          'Ошибка сохранения'
        );
      } catch (_) {}
    }
  }
);

// ==================================================
// STAR BUTTON
// ==================================================

bot.action(
  'MARK_STAR',
  async (ctx) => {
    try {
      await markWeek(
        ctx,
        'star'
      );

    } catch (error) {
      console.error(
        'MARK_STAR ERROR',
        error
      );

      try {
        await ctx.answerCbQuery(
          'Ошибка сохранения'
        );
      } catch (_) {}
    }
  }
);

// ==================================================
// TEXT
// ==================================================

bot.on(
  'text',
  async (ctx) => {
    const text =
      String(
        ctx.message.text || ''
      ).trim();

    if (!text) return;

    if (text.startsWith('/')) {
      return;
    }

    try {
      let user =
        await getUser(
          ctx.from.id
        );

      if (!user) {
        user =
          await upsertUser(
            ctx,
            {
              awaiting_dob: true,
            }
          );
      }

      // ----------------------------------------------
      // DATE OF BIRTH
      // ----------------------------------------------

      if (
        !user.dob ||
        user.awaiting_dob
      ) {
        const dob =
          parseDob(text);

        if (!dob) {
          await ctx.reply(
            'Не понял дату. Напиши её так: 12.03.1983'
          );
          return;
        }

        await pool.query(
          `
            UPDATE life119_users
            SET
              dob = $1,
              awaiting_dob = FALSE,
              updated_at = NOW()

            WHERE telegram_id = $2
          `,
          [
            dob,
            ctx.from.id,
          ]
        );

        const stats =
          getStats(dob);

        const image =
          await makeMap(
            dob,
            ctx.from.id
          );

        await ctx.replyWithPhoto(
          {
            source: image,
          },
          {
            caption:
              `119 ЛЕТ\n\n` +
              `Прожито недель: ${stats.weeks}\n` +
              `Прожито дней: ${stats.days}\n` +
              `Прожито часов: ${stats.hours}`,

            ...userKeyboard(),
          }
        );

        return;
      }

      // ----------------------------------------------
      // ANSWER
      // ----------------------------------------------

      const stats =
        getStats(
          dateOnly(user.dob)
        );

      const weekNumber =
        Math.max(
          1,
          stats.weeks
        );

      const history =
        await pool.query(
          `
            SELECT question_id
            FROM life119_question_history

            WHERE telegram_id = $1

            ORDER BY used_at DESC
            LIMIT 1
          `,
          [ctx.from.id]
        );

      const questionId =
        history.rows[0]?.question_id || 0;

      await pool.query(
        `
          INSERT INTO life119_answers
            (
              telegram_id,
              week_number,
              question_id,
              answer,
              created_at,
              updated_at
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              NOW(),
              NOW()
            )

          ON CONFLICT
            (telegram_id, week_number)

          DO UPDATE SET
            answer = EXCLUDED.answer,
            question_id = EXCLUDED.question_id,
            updated_at = NOW()
        `,
        [
          ctx.from.id,
          weekNumber,
          questionId,
          text,
        ]
      );

      await ctx.reply(
        'Сохранил. Вернёмся к этому ответу на следующей неделе.'
      );

    } catch (error) {
      console.error(
        'TEXT HANDLER ERROR',
        error
      );

      try {
        await ctx.reply(
          'Не удалось сохранить ответ. Попробуй ещё раз.'
        );
      } catch (_) {}
    }
  }
);

// ==================================================
// WEEKLY NOTIFICATION
// ==================================================

async function weeklyCheck() {
  const result =
    await pool.query(
      `
        SELECT
          telegram_id,
          dob,
          last_notified_week

        FROM life119_users

        WHERE dob IS NOT NULL
      `
    );

  for (const user of result.rows) {
    try {
      const dob =
        dateOnly(user.dob);

      const stats =
        getStats(dob);

      if (stats.weeks < 1) {
        continue;
      }

      if (
        stats.weeks <=
        Number(
          user.last_notified_week || 0
        )
      ) {
        continue;
      }

      const weekNumber =
        stats.weeks;

      const question =
        await pickQuestion(
          user.telegram_id
        );

      const previous =
        weekNumber > 1
          ? await getAnswerForWeek(
              user.telegram_id,
              weekNumber - 1
            )
          : null;

      let caption =
        `Неделя №${weekNumber}\n\n` +
        `${question.text}\n\n` +
        `Напиши ответ одним сообщением — я сохраню его.`;

      if (previous?.answer) {
        const short =
          previous.answer.length > 220
            ? previous.answer.slice(0, 217) + '…'
            : previous.answer;

        caption +=
          `\n\nТвой ответ прошлой недели:` +
          `\n«${short}»`;
      }

      await bot.telegram.sendPhoto(
        user.telegram_id,
        {
          source:
            await makeWeekImage(
              weekNumber,
              dob
            ),
        },
        {
          caption,
          reply_markup:
            questionKeyboard()
              .reply_markup,
        }
      );

      await pool.query(
        `
          UPDATE life119_users

          SET
            last_notified_week = $1,
            updated_at = NOW()

          WHERE telegram_id = $2
        `,
        [
          weekNumber,
          user.telegram_id,
        ]
      );

    } catch (error) {
      console.error(
        'WEEKLY USER ERROR',
        user.telegram_id,
        error
      );
    }
  }
}

// ==================================================
// HTTP
// ==================================================

app.get(
  '/',
  (_req, res) => {
    res
      .status(200)
      .send(
        '119 years bot is running'
      );
  }
);

app.get(
  '/health',
  (_req, res) => {
    res
      .status(200)
      .json({
        ok: true,
        service:
          'telegram-119-years',
      });
  }
);

// ==================================================
// TELEGRAM WEBHOOK
// ==================================================
//
// ВАЖНО:
// Здесь НЕ используется:
//
// app.use(WEBHOOK_PATH, ...)
//
// потому что Telegraf должен получить
// полный URL path запроса.
//
// Webhook подключается напрямую,
// а перед ним только логируем входящий update.
//

app.use(
  (req, _res, next) => {
    if (req.path === WEBHOOK_PATH) {
      console.log(
        'Telegram webhook update received'
      );
    }

    next();
  }
);

app.use(
  bot.webhookCallback(
    WEBHOOK_PATH
  )
);

// ==================================================
// START SERVER
// ==================================================

const server =
  app.listen(
    PORT,
    '0.0.0.0',
    async () => {
      console.log(
        `HTTP server listening on ${PORT}`
      );

      try {
        await initDb();

        console.log(
          'Database initialized'
        );

        const webhookUrl =
          `${PUBLIC_URL}${WEBHOOK_PATH}`;

        await bot.telegram.setWebhook(
          webhookUrl
        );

        console.log(
          `Telegram webhook set: ${webhookUrl}`
        );

      } catch (error) {
        console.error(
          'STARTUP ERROR',
          error
        );
      }
    }
  );

// ==================================================
// HOURLY CHECK
// ==================================================

cron.schedule(
  '0 * * * *',
  async () => {
    try {
      console.log(
        'Hourly weekly check started'
      );

      await weeklyCheck();

      console.log(
        'Hourly weekly check finished'
      );

    } catch (error) {
      console.error(
        'CRON ERROR',
        error
      );
    }
  },
  {
    timezone:
      'Europe/Moscow',
  }
);

// ==================================================
// SHUTDOWN
// ==================================================

process.once(
  'SIGINT',
  () => {
    server.close(
      () => process.exit(0)
    );
  }
);

process.once(
  'SIGTERM',
  () => {
    server.close(
      () => process.exit(0)
    );
  }
);
