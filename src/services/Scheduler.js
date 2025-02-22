const fs = require("fs/promises");
const { randomInt } = require("crypto");
const PostModel = require("../models/Post");
const Notifier = require("../utils/Notifier");

class Scheduler {
  constructor(model, bot) {
    this.model = model;
    this.bot = bot;
    this.timeoutId = null;
  }

  static getRandomTime(minMinutes, maxMinutes) {
    const minMs = minMinutes * 60 * 1000;
    const maxMs = maxMinutes * 60 * 1000;
    const randomDelay = randomInt(minMs, maxMs + 1);
    Notifier.log(
      `[DEBUG] Случайное время задержки: ${randomDelay} мс (от ${minMinutes} до ${maxMinutes} минут)`,
    );
    return randomDelay;
  }

  static shouldSkipPost() {
    const skip = randomInt(0, 100) < 10;
    Notifier.log(
      `[DEBUG] Проверка пропуска поста: ${skip ? "Пропускаем" : "Отправляем"}`,
    );
    return skip;
  }

  static getTimeInterval() {
    const timezoneOffset = process.env.TIMEZONE_OFFSET
      ? parseInt(process.env.TIMEZONE_OFFSET)
      : 0;
    const hour = new Date(Date.now() + timezoneOffset * 3600000).getHours();
    if (hour >= 8 && hour < 12) return [1, 45];
    if (hour >= 12 && hour < 18) return [20, 90];
    if (hour >= 18 && hour < 23) return [45, 120];
    return [120, 300];
  }

  static async computeNextPostTime() {
    const [minInterval, maxInterval] = Scheduler.getTimeInterval();
    const postDoc = await PostModel.findById("singleton");
    let lastTime = postDoc?.lastPost || 0;
    let nextPost = postDoc?.nextPost || 0;
    const now = Date.now();
    Notifier.log(
      `[DEBUG] Текущее время: ${now}, Последний пост: ${lastTime}, Следующий пост: ${nextPost}`,
    );
    if (nextPost && nextPost > now) {
      Notifier.log(
        "[INFO] Используем запланированное время для следующего поста.",
      );
      return nextPost;
    }
    let delay = 0;
    if (lastTime) {
      const elapsedMinutes = (now - lastTime) / 60000;
      if (elapsedMinutes < minInterval) {
        delay = (minInterval - elapsedMinutes) * 60000;
        Notifier.log(
          `[INFO] Недостаточно времени прошло с последнего поста (${elapsedMinutes.toFixed(2)} мин). Планируем через ${(delay / 60000).toFixed(2)} мин.`,
        );
      } else {
        delay = Scheduler.getRandomTime(minInterval, maxInterval);
      }
    } else {
      delay = Scheduler.getRandomTime(minInterval, maxInterval);
      Notifier.log("[INFO] Нет предыдущих записей. Планируем первый пост.");
    }
    nextPost = now + delay;
    await PostModel.findByIdAndUpdate(
      "singleton",
      { lastPost: lastTime, nextPost },
      { upsert: true },
    );
    Notifier.log(
      `[DEBUG] Следующий пост запланирован на: ${new Date(nextPost).toISOString()}`,
    );
    return nextPost;
  }

  async generateTextFromPrompt(promptPath) {
    let resultText = "";
    try {
      Notifier.log(`[INFO] Чтение промпта из файла: ${promptPath}`);
      const prompt = await fs.readFile(promptPath, "utf-8");
      const result = await this.model.generateContentStream(prompt);
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        resultText += chunkText;
        Notifier.log("[DEBUG] Получен CHUNK:", chunkText);
      }
      Notifier.log("[INFO] Генерация текста завершена.");
      return resultText;
    } catch (error) {
      await Notifier.error(error, {
        module: "Scheduler.generateTextFromPrompt",
      });
      return "";
    }
  }

  async postQuoteToTelegram(channelId) {
    try {
      Notifier.log("[INFO] Начало генерации цитаты для Telegram.");
      const quote = await this.generateTextFromPrompt("./prompt.txt");
      if (!quote) {
        await Notifier.error("[ERROR] Не удалось сгенерировать цитату.");
        return;
      }
      await this.bot.telegram.sendMessage(channelId, `💔 - ${quote}`);
      Notifier.log("[INFO] ✅ Цитата успешно отправлена в Telegram канал");
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.postQuoteToTelegram" });
    }
  }

  async schedulePost(channelId) {
    try {
      const nextPostTime = await Scheduler.computeNextPostTime();
      const delay = Math.max(nextPostTime - Date.now(), 0);
      Notifier.log(
        `[INFO] Планирование следующего поста через ${Math.round(delay / 60000)} минут`,
      );
      this.timeoutId = setTimeout(async () => {
        try {
          if (Scheduler.shouldSkipPost()) {
            Notifier.log(
              "[INFO] 😴 Пост пропущен (симуляция человеческой небрежности)",
            );
          } else {
            await this.postQuoteToTelegram(channelId);
            await PostModel.findByIdAndUpdate(
              "singleton",
              { lastPost: Date.now(), nextPost: 0 },
              { upsert: true },
            );
            Notifier.log(
              "[INFO] Время последнего поста обновлено в базе данных.",
            );
          }
        } catch (error) {
          await Notifier.error(error, {
            module: "Scheduler.schedulePost inner",
          });
        }
        this.schedulePost(channelId);
      }, delay);
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.schedulePost" });
      const fallbackDelay = Scheduler.getRandomTime(10, 15);
      Notifier.warn(
        `[WARN] Ошибка планирования поста. Попытка через ${Math.round(fallbackDelay / 60000)} минут.`,
      );
      this.timeoutId = setTimeout(
        () => this.schedulePost(channelId),
        fallbackDelay,
      );
    }
  }
}

module.exports = Scheduler;
