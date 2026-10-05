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

function questionKeyboard(weekNumber = null) {
  const fireData =
    weekNumber
      ? `MARK_FIRE_${weekNumber}`
      : 'MARK_FIRE';

  const starData =
    weekNumber
      ? `MARK_STAR_${weekNumber}`
      : 'MARK_STAR';

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        '🔥 Важная неделя',
        fireData
      ),
      Markup.button.callback(
        '⭐ Отметить',
        starData
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
      current_question_week INTEGER,
      current_question_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS username TEXT
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS first_name TEXT
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS dob DATE
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS last_notified_week
        INTEGER NOT NULL DEFAULT 0
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS awaiting_dob
        BOOLEAN NOT NULL DEFAULT FALSE
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS current_question_week
        INTEGER
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS current_question_id
        INTEGER
  `);

  await pool.query(`
    ALTER TABLE life119_users
      ADD COLUMN IF NOT EXISTS created_at
        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);

  await pool.query(`
    ALTER TABLE life119_users
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

  await pool.query(`SELECT 1`);

  console.log('Database initialized successfully');
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
        `Прожито недель: ${stats.weeks} из ${stats.totalWeeks}.`,
        16,
        25,
        16,
        700
      )}

      ${svgText(
        `Прожито дней: ${stats.days}.`,
        16,
        48,
        16,
        700
      )}

      ${svgText(
        `Прожито часов: ${stats.hours}.`,
        16,
        71,
        16,
        700
      )}

      ${svgText(
        `Идёт ${stats.yearWeek} неделя текущего года.`,
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
// QUESTIONS
// ==================================================

async function pickQuestion(telegramId) {
  if (!questions.length) {
    throw new Error(
      'questions.js is empty'
    );
  }

  const usedResult = await pool.query(
    `
      SELECT question_id
      FROM life119_question_history
      WHERE telegram_id = $1
    `,
    [telegramId]
  );

  const used = new Set(
    usedResult.rows.map(
      row => Number(row.question_id)
    )
  );

  let available =
    questions.filter(
      question =>
        !used.has(Number(question.id))
    );

  if (!available.length) {
    await pool.query(
      `
        DELETE FROM life119_question_history
        WHERE telegram_id = $1
      `,
      [telegramId]
    );

    available = [...questions];
  }

  const question =
    available[
      Math.floor(
        Math.random() *
        available.length
      )
    ];

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

  if (!dob) {
    await pool.query(
      `
        UPDATE life119_users
        SET dob = NULL, awaiting_dob = TRUE, updated_at = NOW()
        WHERE telegram_id = $1
      `,
      [ctx.from.id]
    );

    await ctx.reply(
      'Дата рождения в базе битая. Напиши её заново в формате ДД.ММ.ГГГГ.'
    );

    return;
  }

  const stats =
    getStats(dob);

  console.log(
    'MAP: preparing',
    {
      telegramId: ctx.from.id,
      dob,
      weeks: stats.weeks,
    }
  );

  const image =
    await makeMap(
      dob,
      ctx.from.id
    );

  console.log(
    'MAP: image generated',
    {
      telegramId: ctx.from.id,
      bytes: image.length,
    }
  );

  await ctx.replyWithPhoto(
    {
      source: image,
    },
    {
      caption:
        `119 ЛЕТ\n\n` +
        `Прожито недель: ${stats.weeks} из ${stats.totalWeeks}.\n` +
        `Прожито дней: ${stats.days}.\n` +
        `Прожито часов: ${stats.hours}.\n` +
        `Идёт ${stats.yearWeek} неделя текущего года.`,

      ...userKeyboard(),
    }
  );

  console.log(
    'MAP: sent',
    ctx.from.id
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

  if (!dob) {
    await ctx.reply(
      'Сначала укажи дату рождения в формате ДД.ММ.ГГГГ.'
    );
    return;
  }

  const stats =
    getStats(dob);

  const weekNumber =
    weekNumberOverride ||
    Math.max(
      1,
      stats.weeks
    );

  let question;

  const existingQuestionWeek =
    Number(user.current_question_week || 0);

  const existingQuestionId =
    Number(user.current_question_id || 0);

  if (
    existingQuestionWeek === weekNumber &&
    existingQuestionId
  ) {
    question =
      questions.find(
        item =>
          Number(item.id) === existingQuestionId
      );

    if (!question) {
      question =
        await pickQuestion(
          ctx.from.id
        );
    }
  } else {
    question =
      await pickQuestion(
        ctx.from.id
      );
  }

  const previous =
    weekNumber > 1
      ? await getAnswerForWeek(
          ctx.from.id,
          weekNumber - 1
        )
      : null;

  await pool.query(
    `
      UPDATE life119_users
      SET
        current_question_week = $1,
        current_question_id = $2,
        updated_at = NOW()
      WHERE telegram_id = $3
    `,
    [
      weekNumber,
      question.id,
      ctx.from.id,
    ]
  );

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

  await ctx.reply(
    text,
    questionKeyboard(weekNumber)
  );

  console.log(
    'QUESTION: sent',
    {
      telegramId: ctx.from.id,
      weekNumber,
      questionId: question.id,
    }
  );
}

// ==================================================
// MARK
// ==================================================

async function markWeek(
  ctx,
  mark,
  weekNumber = null
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

  const targetWeek =
    Number(
      weekNumber ||
      user.current_question_week ||
      stats.weeks
    );

  if (targetWeek < 1) {
    await ctx.answerCbQuery(
      'Первая неделя ещё не закончилась'
    );
    return;
  }

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
      targetWeek,
      mark,
    ]
  );

  await ctx.answerCbQuery(
    mark === 'fire'
      ? '🔥 Неделя отмечена'
      : '⭐ Неделя отмечена'
  );

  console.log(
    'MARK: saved',
    {
      telegramId: ctx.from.id,
      weekNumber: targetWeek,
      mark,
    }
  );
}

// ==================================================
// ERROR HANDLER
// ==================================================

bot.catch((err, ctx) => {
  console.error(
    'BOT ERROR',
    {
      updateId:
        ctx?.update?.update_id,
      error:
        err?.stack || err,
    }
  );
});

// ==================================================
// START
// ==================================================

bot.start(async (ctx) => {
  console.log(
    'START received',
    {
      updateId:
        ctx.update?.update_id,
      telegramId:
        ctx.from?.id,
    }
  );

  try {
    const existing =
      await getUser(ctx.from.id);

    console.log(
      'START: user loaded',
      {
        telegramId: ctx.from.id,
        exists: Boolean(existing),
        hasDob: Boolean(existing?.dob),
      }
    );

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
      {
        telegramId: ctx.from?.id,
        updateId: ctx.update?.update_id,
        error:
          error?.stack || error,
      }
    );

    try {
      await ctx.reply(
        'Не удалось открыть карту. Попробуй ещё раз.'
      );
    } catch (replyError) {
      console.error(
        '/start ERROR while sending fallback',
        replyError?.stack || replyError
      );
    }
  }
});

// ==================================================
// QUESTION BUTTON
// ==================================================

bot.action(
  'QUESTION_WEEK',
  async (ctx) => {
    console.log(
      'QUESTION_WEEK received',
      {
        updateId:
          ctx.update?.update_id,
        telegramId:
          ctx.from?.id,
      }
    );

    try {
      await ctx.answerCbQuery();

      await sendQuestion(ctx);

    } catch (error) {
      console.error(
        'QUESTION_WEEK ERROR',
        {
          telegramId: ctx.from?.id,
          error:
            error?.stack || error,
        }
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
  /^MARK_FIRE(?:_(\d+))?$/,
  async (ctx) => {
    const match =
      ctx.match;

    const weekNumber =
      match?.[1]
        ? Number(match[1])
        : null;

    console.log(
      'MARK_FIRE received',
      {
        updateId:
          ctx.update?.update_id,
        telegramId:
          ctx.from?.id,
        weekNumber,
      }
    );

    try {
      await markWeek(
        ctx,
        'fire',
        weekNumber
      );

    } catch (error) {
      console.error(
        'MARK_FIRE ERROR',
        {
          telegramId: ctx.from?.id,
          error:
            error?.stack || error,
        }
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
  /^MARK_STAR(?:_(\d+))?$/,
  async (ctx) => {
    const match =
      ctx.match;

    const weekNumber =
      match?.[1]
        ? Number(match[1])
        : null;

    console.log(
      'MARK_STAR received',
      {
        updateId:
          ctx.update?.update_id,
        telegramId:
          ctx.from?.id,
        weekNumber,
      }
    );

    try {
      await markWeek(
        ctx,
        'star',
        weekNumber
      );

    } catch (error) {
      console.error(
        'MARK_STAR ERROR',
        {
          telegramId: ctx.from?.id,
          error:
            error?.stack || error,
        }
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

    console.log(
      'TEXT received',
      {
        updateId:
          ctx.update?.update_id,
        telegramId:
          ctx.from?.id,
        length:
          text.length,
      }
    );

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
              `Прожито недель: ${stats.weeks} из ${stats.totalWeeks}.\n` +
              `Прожито дней: ${stats.days}.\n` +
              `Прожито часов: ${stats.hours}.\n` +
              `Идёт ${stats.yearWeek} неделя текущего года.`,

            ...userKeyboard(),
          }
        );

        console.log(
          'DOB: saved and map sent',
          ctx.from.id
        );

        return;
      }

      // ----------------------------------------------
      // ANSWER
      // ----------------------------------------------

      const currentQuestionWeek =
        Number(
          user.current_question_week
        );

      const currentQuestionId =
        Number(
          user.current_question_id
        );

      if (
        !currentQuestionWeek ||
        !currentQuestionId
      ) {
        await ctx.reply(
          'Сначала открой вопрос недели кнопкой «❓ Вопрос недели».'
        );
        return;
      }

      // Сначала удаляем старый ответ этой недели.
      // Это специально сделано без ON CONFLICT и без
      // зависимости от updated_at, потому что в старой
      // таблице life119_answers этого поля может не быть.
      await pool.query(
        `
          DELETE FROM life119_answers
          WHERE
            telegram_id = $1
            AND week_number = $2
        `,
        [
          ctx.from.id,
          currentQuestionWeek,
        ]
      );

      // Затем записываем актуальный ответ.
      await pool.query(
        `
          INSERT INTO life119_answers
            (
              telegram_id,
              week_number,
              question_id,
              answer,
              created_at
            )
          VALUES
            (
              $1,
              $2,
              $3,
              $4,
              NOW()
            )
        `,
        [
          ctx.from.id,
          currentQuestionWeek,
          currentQuestionId,
          text,
        ]
      );

      console.log(
        'ANSWER: saved',
        {
          telegramId:
            ctx.from.id,
          weekNumber:
            currentQuestionWeek,
          questionId:
            currentQuestionId,
        }
      );

      await ctx.reply(
        'Сохранил. Вернёмся к этому ответу на следующей неделе.'
      );

    } catch (error) {
      console.error(
        'TEXT HANDLER ERROR',
        {
          telegramId: ctx.from?.id,
          error:
            error?.stack || error,
        }
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
  console.log(
    'Hourly weekly check started'
  );

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

  console.log(
    'Weekly users found:',
    result.rows.length
  );

  for (const user of result.rows) {
    try {
      const dob =
        dateOnly(user.dob);

      if (!dob) continue;

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

      await pool.query(
        `
          UPDATE life119_users
          SET
            current_question_week = $1,
            current_question_id = $2,
            updated_at = NOW()
          WHERE telegram_id = $3
        `,
        [
          weekNumber,
          question.id,
          user.telegram_id,
        ]
      );

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

      await bot.telegram.sendMessage(
        user.telegram_id,
        caption,
        questionKeyboard(
          weekNumber
        )
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

      console.log(
        'WEEKLY: sent',
        {
          telegramId:
            user.telegram_id,
          weekNumber,
          questionId:
            question.id,
        }
      );

    } catch (error) {
      console.error(
        'WEEKLY USER ERROR',
        {
          telegramId:
            user.telegram_id,
          error:
            error?.stack || error,
        }
      );
    }
  }

  console.log(
    'Hourly weekly check finished'
  );
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

app.post(
  WEBHOOK_PATH,
  async (req, res) => {
    const update =
      req.body || {};

    console.log(
      'Telegram webhook update received',
      {
        updateId:
          update.update_id,
        type:
          update.message
            ? 'message'
            : update.callback_query
              ? 'callback_query'
              : 'other',
      }
    );

    try {
      await bot.handleUpdate(
        update,
        res
      );

      if (!res.headersSent) {
        res
          .status(200)
          .end();
      }

    } catch (error) {
      console.error(
        'WEBHOOK HANDLE ERROR',
        {
          updateId:
            update.update_id,
          error:
            error?.stack || error,
        }
      );

      if (!res.headersSent) {
        res
          .status(500)
          .send('Webhook error');
      }
    }
  }
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

        const webhookUrl =
          `${PUBLIC_URL}${WEBHOOK_PATH}`;

        await bot.telegram.setWebhook(
          webhookUrl
        );

        const webhookInfo =
          await bot.telegram.getWebhookInfo();

        console.log(
          'Telegram webhook configured',
          {
            url:
              webhookInfo.url,
            pending:
              webhookInfo.pending_update_count,
            lastError:
              webhookInfo.last_error_message || null,
          }
        );

        console.log(
          `Webhook URL: ${webhookUrl}`
        );

      } catch (error) {
        console.error(
          'FATAL STARTUP ERROR',
          error?.stack || error
        );

        process.exit(1);
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
      await weeklyCheck();

    } catch (error) {
      console.error(
        'CRON ERROR',
        error?.stack || error
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
