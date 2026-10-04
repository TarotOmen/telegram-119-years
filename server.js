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

app.get("/", (_, res) => {
  res.send("119 лет bot is running");
});

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("HTTP server on " + PORT);
});

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

function normalizeBirthDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;

    return new Date(Date.UTC(
      value.getUTCFullYear(),
      value.getUTCMonth(),
      value.getUTCDate()
    ));
  }

  const text = String(value).trim();

  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (match) {
    return new Date(Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3])
    ));
  }

  const parsed = new Date(text);

  if (Number.isNaN(parsed.getTime())) return null;

  return new Date(Date.UTC(
    parsed.getUTCFullYear(),
    parsed.getUTCMonth(),
    parsed.getUTCDate()
  ));
}

function livedWeeks(birthDate) {
  const birth = normalizeBirthDate(birthDate);

  if (!birth) return 0;

  return Math.max(
    0,
    Math.floor(
      (Date.now() - birth.getTime()) / 604800000
    )
  );
}

function getWeekNumber(birthDate) {
  return Math.min(
    TOTAL_WEEKS,
    livedWeeks(birthDate) + 1
  );
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

async function getUser(telegramId) {
  const r = await db(
    "SELECT * FROM life119_users WHERE telegram_id=$1",
    [telegramId]
  );

  return r.rows[0];
}


/* =========================================================
   НОВАЯ КАРТА 119 ЛЕТ
   ========================================================= */

async function makeMap(userId, currentWeek) {

  const r = await db(
    "SELECT week_number, mark FROM life119_marks WHERE telegram_id=$1",
    [userId]
  );

  const marks = new Map(
    r.rows.map(row => [
      Number(row.week_number),
      row.mark
    ])
  );

  /*
    52 недели в строке.
    119 строк = 119 лет.

    Размер специально увеличен по сравнению
    со старой версией, чтобы кружки были видны.
  */

  const cell = 11;
  const gap = 2;

  const yearWidth = 44;
  const left = 58;
  const right = 24;
  const top = 100;
  const bottom = 40;

  const gridWidth =
    52 * cell +
    51 * gap;

  const width =
    left +
    gridWidth +
    right;

  const rowHeight =
    cell + gap;

  const height =
    top +
    119 * rowHeight +
    bottom;

  const currentYear =
    Math.floor((currentWeek - 1) / 52) + 1;

  const currentWeekInYear =
    ((currentWeek - 1) % 52) + 1;

  const progressPercent =
    Math.min(
      100,
      Math.round(
        (currentWeek / TOTAL_WEEKS) * 100
      )
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
      fill="#0b0d12"
    />

    <text
      x="${left}"
      y="30"
      fill="#ffffff"
      font-family="Arial"
      font-size="24"
      font-weight="700"
    >
      119 лет
    </text>

    <text
      x="${left}"
      y="52"
      fill="#9da3ae"
      font-family="Arial"
      font-size="13"
    >
      твоя жизнь в неделях
    </text>

    <text
      x="${left}"
      y="78"
      fill="#ffffff"
      font-family="Arial"
      font-size="15"
    >
      ${currentWeek} недель прожито
    </text>

    <text
      x="${left + 175}"
      y="78"
      fill="#777e89"
      font-family="Arial"
      font-size="13"
    >
      ${progressPercent}% из 119 лет
    </text>

    <text
      x="${width - right}"
      y="30"
      text-anchor="end"
      fill="#ffffff"
      font-family="Arial"
      font-size="15"
    >
      ${currentYear} год
    </text>

    <text
      x="${width - right}"
      y="52"
      text-anchor="end"
      fill="#9da3ae"
      font-family="Arial"
      font-size="12"
    >
      неделя ${currentWeekInYear}
    </text>
  `;

  /*
    Небольшая сетка недель сверху.
  */

  for (let col = 0; col < 52; col++) {

    const x =
      left +
      col * (cell + gap) +
      cell / 2;

    if (
      col === 0 ||
      col === 12 ||
      col === 25 ||
      col === 38 ||
      col === 51
    ) {
      svg += `
        <text
          x="${x}"
          y="${top - 12}"
          text-anchor="middle"
          fill="#59616d"
          font-family="Arial"
          font-size="9"
        >
          ${col + 1}
        </text>
      `;
    }
  }

  /*
    119 лет.
  */

  for (let year = 0; year < 119; year++) {

    const rowY =
      top +
      year * rowHeight;

    const yearNumber =
      year + 1;

    /*
      Каждые 10 лет делаем чуть более заметную
      горизонтальную линию.
    */

    if (
      year === 0 ||
      year % 10 === 0
    ) {
      svg += `
        <line
          x1="${left - 8}"
          y1="${rowY - 4}"
          x2="${left + gridWidth}"
          y2="${rowY - 4}"
          stroke="#252b35"
          stroke-width="1"
        />
      `;
    }

    /*
      Номер года.
    */

    if (
      year === 0 ||
      year % 5 === 0 ||
      year === currentYear - 1
    ) {
      svg += `
        <text
          x="${yearWidth}"
          y="${rowY + 9}"
          text-anchor="end"
          fill="${
            year === currentYear - 1
              ? "#ffffff"
              : "#69717d"
          }"
          font-family="Arial"
          font-size="${
            year === currentYear - 1
              ? "11"
              : "9"
          }"
          font-weight="${
            year === currentYear - 1
              ? "700"
              : "400"
          }"
        >
          ${yearNumber}
        </text>
      `;
    }

    /*
      52 недели года.
    */

    for (let week = 0; week < 52; week++) {

      const weekNumber =
        year * 52 +
        week +
        1;

      const cx =
        left +
        week * (cell + gap) +
        cell / 2;

      const cy =
        rowY +
        cell / 2;

      const mark =
        marks.get(weekNumber);

      let fill;

      if (weekNumber < currentWeek) {
        fill = "#d84a4a";
      } else if (weekNumber === currentWeek) {
        fill = "#f4bd45";
      } else {
        fill = "#252b34";
      }

      /*
        Обычный кружок.
      */

      svg += `
        <circle
          cx="${cx}"
          cy="${cy}"
          r="${cell / 2}"
          fill="${fill}"
        />
      `;

      /*
        Звезда.
      */

      if (mark === "star") {

        const r1 = 5.5;
        const r2 = 2.5;

        let points = "";

        for (let i = 0; i < 10; i++) {

          const angle =
            -Math.PI / 2 +
            i * Math.PI / 5;

          const radius =
            i % 2 === 0
              ? r1
              : r2;

          const px =
            cx +
            Math.cos(angle) * radius;

          const py =
            cy +
            Math.sin(angle) * radius;

          points +=
            `${px},${py} `;
        }

        svg += `
          <polygon
            points="${points}"
            fill="#ffffff"
          />
        `;
      }

      /*
        Огненная отметка.

        Делаем её графикой, а не emoji,
        чтобы Telegram/Sharp не зависели
        от наличия шрифта emoji.
      */

      if (mark === "fire") {

        svg += `
          <circle
            cx="${cx}"
            cy="${cy}"
            r="5.5"
            fill="#ff6b35"
          />

          <path
            d="
              M ${cx} ${cy + 4.5}
              C ${cx - 4} ${cy + 1}
                ${cx - 3} ${cy - 2}
                ${cx} ${cy - 5}
              C ${cx + 1} ${cy - 2}
                ${cx + 4} ${cy - 1}
                ${cx + 3} ${cy + 3}
              C ${cx + 2} ${cy + 5}
                ${cx + 1} ${cy + 5}
                ${cx} ${cy + 4.5}
              Z
            "
            fill="#ffd34e"
          />
        `;
      }

      /*
        Текущая неделя получает внешний контур.
      */

      if (weekNumber === currentWeek) {

        svg += `
          <circle
            cx="${cx}"
            cy="${cy}"
            r="${cell / 2 + 2}"
            fill="none"
            stroke="#ffffff"
            stroke-width="1.5"
          />
        `;
      }
    }
  }

  /*
    Легенда.
  */

  const legendY =
    top +
    119 * rowHeight +
    22;

  svg += `
    <circle
      cx="${left}"
      cy="${legendY}"
      r="5"
      fill="#d84a4a"
    />

    <text
      x="${left + 12}"
      y="${legendY + 4}"
      fill="#9da3ae"
      font-family="Arial"
      font-size="11"
    >
      прожито
    </text>

    <circle
      cx="${left + 82}"
      cy="${legendY}"
      r="5"
      fill="#f4bd45"
    />

    <text
      x="${left + 94}"
      y="${legendY + 4}"
      fill="#9da3ae"
      font-family="Arial"
      font-size="11"
    >
      сейчас
    </text>

    <circle
      cx="${left + 145}"
      cy="${legendY}"
      r="5"
      fill="#252b34"
    />

    <text
      x="${left + 157}"
      y="${legendY + 4}"
      fill="#9da3ae"
      font-family="Arial"
      font-size="11"
    >
      впереди
    </text>

    <text
      x="${left + 230}"
      y="${legendY + 4}"
      fill="#ff7138"
      font-family="Arial"
      font-size="12"
      font-weight="700"
    >
      🔥
    </text>

    <text
      x="${left + 248}"
      y="${legendY + 4}"
      fill="#9da3ae"
      font-family="Arial"
      font-size="11"
    >
      важная
    </text>

    <text
      x="${left + 315}"
      y="${legendY + 4}"
      fill="#ffffff"
      font-family="Arial"
      font-size="12"
      font-weight="700"
    >
      ★
    </text>

    <text
      x="${left + 330}"
      y="${legendY + 4}"
      fill="#9da3ae"
      font-family="Arial"
      font-size="11"
    >
      отмеченная
    </text>

  </svg>
  `;

  return sharp(
    Buffer.from(svg)
  )
    .png()
    .toBuffer();
}


/* =========================================================
   ВОПРОС НЕДЕЛИ
   ========================================================= */

async function sendQuestion(ctx) {

  const u =
    await getUser(ctx.from.id);

  if (!u || !u.birth_date) {
    return ctx.reply(
      "Сначала напиши дату рождения через /start."
    );
  }

  const week =
    getWeekNumber(u.birth_date);

  const q =
    QUESTIONS[
      (week - 1) %
      QUESTIONS.length
    ];

  return ctx.reply(
    `Неделя №${week}

${q}

Напиши ответ одним сообщением — я сохраню его.`,
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


/* =========================================================
   START
   ========================================================= */

bot.start(async ctx => {

  try {

    let u =
      await getUser(ctx.from.id);

    if (!u) {

      await db(
        `
        INSERT INTO life119_users
          (telegram_id, first_name)
        VALUES
          ($1, $2)
        ON CONFLICT (telegram_id)
        DO NOTHING
        `,
        [
          ctx.from.id,
          ctx.from.first_name || ""
        ]
      );

      u =
        await getUser(ctx.from.id);
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

    console.error(
      "START ERROR",
      e
    );

    return ctx.reply(
      "Не удалось запустить бота. Проверь логи Render."
    );
  }
});


/* =========================================================
   MAP
   ========================================================= */

bot.command("map", async ctx => {

  try {

    const u =
      await getUser(ctx.from.id);

    if (!u?.birth_date) {
      return ctx.reply(
        "Сначала /start."
      );
    }

    const week =
      getWeekNumber(
        u.birth_date
      );

    const img =
      await makeMap(
        ctx.from.id,
        week
      );

    return ctx.replyWithPhoto(
      { source: img },
      {
        caption:
          `Прожито недель: ${livedWeeks(u.birth_date)} из ${TOTAL_WEEKS}.\nГод: ${Math.floor((week - 1) / 52) + 1} · неделя: ${((week - 1) % 52) + 1}`,
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

    console.error(
      "MAP ERROR",
      e
    );

    return ctx.reply(
      "Не удалось построить карту."
    );
  }
});


bot.command(
  "question",
  sendQuestion
);


/* =========================================================
   BUTTONS
   ========================================================= */

bot.action("BIRTH", async ctx => {

  await ctx.answerCbQuery();

  await ctx.reply(
    "Напиши дату рождения в формате ДД.ММ.ГГГГ\nНапример: 12.05.1982"
  );
});


bot.action("MAP", async ctx => {

  await ctx.answerCbQuery();

  const u =
    await getUser(ctx.from.id);

  if (!u?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения."
    );
  }

  const week =
    getWeekNumber(
      u.birth_date
    );

  const img =
    await makeMap(
      ctx.from.id,
      week
    );

  await ctx.replyWithPhoto(
    { source: img },
    {
      caption:
        `Прожито недель: ${livedWeeks(u.birth_date)} из ${TOTAL_WEEKS}.\nГод: ${Math.floor((week - 1) / 52) + 1} · неделя: ${((week - 1) % 52) + 1}`,
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


bot.action(
  "QUESTION",
  async ctx => {

    await ctx.answerCbQuery();

    await sendQuestion(ctx);
  }
);


/* =========================================================
   MARKS
   ========================================================= */

async function markCurrent(
  ctx,
  mark
) {

  const u =
    await getUser(ctx.from.id);

  if (!u?.birth_date) {
    return ctx.reply(
      "Сначала введи дату рождения."
    );
  }

  const week =
    getWeekNumber(
      u.birth_date
    );

  await db(
    `
    INSERT INTO life119_marks
      (telegram_id, week_number, mark)
    VALUES
      ($1, $2, $3)

    ON CONFLICT
      (telegram_id, week_number)

    DO UPDATE SET
      mark = EXCLUDED.mark
    `,
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


bot.action(
  "MARK_FIRE",
  async ctx => {

    await ctx.answerCbQuery();

    await markCurrent(
      ctx,
      "fire"
    );
  }
);


bot.action(
  "MARK_STAR",
  async ctx => {

    await ctx.answerCbQuery();

    await markCurrent(
      ctx,
      "star"
    );
  }
);


/* =========================================================
   TEXT
   ========================================================= */

bot.on("text", async ctx => {

  const u =
    await getUser(ctx.from.id);

  if (!u) return;

  const text =
    ctx.message.text.trim();

  /*
    Ввод даты рождения.
  */

  if (!u.birth_date) {

    const m =
      text.match(
        /^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{4})$/
      );

    if (!m) {

      return ctx.reply(
        "Нужна дата в формате ДД.ММ.ГГГГ"
      );
    }

    const day =
      Number(m[1]);

    const month =
      Number(m[2]);

    const year =
      Number(m[3]);

    const date =
      new Date(
        Date.UTC(
          year,
          month - 1,
          day
        )
      );

    /*
      Проверяем, что дата реально существует.
    */

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day ||
      date > new Date()
    ) {

      return ctx.reply(
        "Проверь дату рождения."
      );
    }

    const d =
      `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    await db(
      `
      UPDATE life119_users
      SET
        birth_date = $1,
        started_at = NOW()
      WHERE telegram_id = $2
      `,
      [
        d,
        ctx.from.id
      ]
    );

    const week =
      getWeekNumber(d);

    const img =
      await makeMap(
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
          `Прожито: ${livedWeeks(d)} недель.\nТекущая неделя: №${week}.`,
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
    Любой следующий текст —
    ответ на вопрос недели.
  */

  const week =
    getWeekNumber(
      u.birth_date
    );

  const q =
    QUESTIONS[
      (week - 1) %
      QUESTIONS.length
    ];

  await db(
    `
    INSERT INTO life119_answers
      (telegram_id, week_number, question, answer)
    VALUES
      ($1, $2, $3, $4)
    `,
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


/* =========================================================
   WEEKLY NOTIFICATION
   ========================================================= */

cron.schedule(
  "0 17 * * 0",
  async () => {

    try {

      const r =
        await db(
          `
          SELECT *
          FROM life119_users
          WHERE birth_date IS NOT NULL
          AND notify_enabled = TRUE
          `
        );

      for (
        const u of r.rows
      ) {

        const week =
          getWeekNumber(
            u.birth_date
          );

        if (
          u.last_notified_week === week
        ) {
          continue;
        }

        await bot.telegram.sendMessage(
          u.telegram_id,
          `Прошла ещё одна неделя.
Сейчас твоя неделя №${week}.

${QUESTIONS[(week - 1) % QUESTIONS.length]}`
        );

        await db(
          `
          UPDATE life119_users
          SET last_notified_week = $1
          WHERE telegram_id = $2
          `,
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


/* =========================================================
   START BOT
   ========================================================= */

(async () => {

  try {

    await initDb();

    await bot.launch();

    console.log(
      "119 years bot started"
    );

  } catch (e) {

    console.error(
      "BOT START ERROR",
      e
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
