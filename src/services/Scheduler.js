const fs = require("fs/promises");
const { randomInt } = require("crypto");
const PostModel = require("../models/Post");
const Notifier = require("../utils/Notifier");

class Scheduler {
  constructor(model, bot) {
    this.model = model;
    this.bot = bot;
    this.timeoutId = null;
    // Время последнего срабатывания планировщика
    this.lastScheduledTime = Date.now();
  }

  cancelSchedule() {
    try {
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        Notifier.log("[INFO] Запланированный таймер остановлен.");
        this.timeoutId = null;
      }
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.cancelSchedule" });
    } finally {
      Notifier.log("[DEBUG] Метод cancelSchedule завершён.");
    }
  }

  static getRandomTime(minMinutes, maxMinutes) {
    try {
      if (minMinutes > maxMinutes) {
        Notifier.warn(
          `[WARN] minMinutes (${minMinutes}) больше maxMinutes (${maxMinutes}). Значения изменены местами.`,
        );
        [minMinutes, maxMinutes] = [maxMinutes, minMinutes];
      }
      const minMs = minMinutes * 60 * 1000;
      const maxMs = maxMinutes * 60 * 1000;
      const randomDelay = randomInt(minMs, maxMs + 1);
      Notifier.log(
        `[DEBUG] Случайное время задержки: ${randomDelay} мс (от ${minMinutes} до ${maxMinutes} минут)`,
      );
      return randomDelay;
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.getRandomTime" });
      return 10 * 60 * 1000;
    } finally {
      Notifier.log("[DEBUG] Метод getRandomTime завершён.");
    }
  }

  static shouldSkipPost() {
    try {
      const skip = randomInt(0, 100) < 10;
      Notifier.log(
        `[DEBUG] Проверка пропуска поста: ${skip ? "Пропускаем" : "Отправляем"}`,
      );
      return skip;
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.shouldSkipPost" });
      return false;
    } finally {
      Notifier.log("[DEBUG] Метод shouldSkipPost завершён.");
    }
  }

  static getTimeInterval() {
    try {
      const parsedOffset = parseInt(process.env.TIMEZONE_OFFSET, 10);
      const timezoneOffset = isNaN(parsedOffset) ? 0 : parsedOffset;
      const currentTime = new Date(Date.now() + timezoneOffset * 3600000);
      Notifier.log(
        `[DEBUG] Текущее время с учетом TZ: ${currentTime.toISOString()}`,
      );
      const hour = currentTime.getHours();
      if (hour >= 8 && hour < 16) return [1, 45];
      if (hour >= 16 && hour < 18) return [20, 90];
      if (hour >= 18 && hour < 23) return [45, 120];
      return [120, 300];
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.getTimeInterval" });
      return [120, 300];
    } finally {
      Notifier.log("[DEBUG] Метод getTimeInterval завершён.");
    }
  }

  static async computeNextPostTime() {
    let nextPost = 0;
    try {
      const [minInterval, maxInterval] = Scheduler.getTimeInterval();
      const postDoc = await PostModel.findById("singleton");
      let lastTime = postDoc?.lastPost || 0;
      nextPost = postDoc?.nextPost || 0;
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
            `[INFO] Недостаточно времени прошло с последнего поста (${elapsedMinutes.toFixed(
              2,
            )} мин). Планируем через ${(delay / 60000).toFixed(2)} мин.`,
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
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.computeNextPostTime" });
      const fallbackDelay = Scheduler.getRandomTime(10, 15);
      Notifier.warn(
        `[WARN] Ошибка вычисления следующего поста. Используем fallback через ${Math.round(
          fallbackDelay / 60000,
        )} минут.`,
      );
      return Date.now() + fallbackDelay;
    } finally {
      Notifier.log("[DEBUG] Метод computeNextPostTime завершён.");
    }
  }

  async generateTextFromPrompt(promptPath) {
    let resultText = "";
    try {
      Notifier.log(`[INFO] Чтение промпта из файла: ${promptPath}`);
      const prompt = await fs.readFile(promptPath, "utf-8");
      const result = await this.model.generateContentStream(prompt);
      if (
        !result?.stream ||
        typeof result.stream[Symbol.asyncIterator] !== "function"
      ) {
        throw new Error(
          "Неверный формат результата генерации: отсутствует асинхронный итератор stream",
        );
      }
      for await (const chunk of result.stream) {
        if (typeof chunk.text !== "function") {
          throw new Error("Неверный формат чанка: отсутствует функция text()");
        }
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
    } finally {
      Notifier.log("[DEBUG] Метод generateTextFromPrompt завершён.");
    }
  }

  async postQuoteToTelegram(channelId) {
    try {
      if (!channelId) {
        throw new Error("channelId не задан или недействителен");
      }
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
    } finally {
      Notifier.log("[DEBUG] Метод postQuoteToTelegram завершён.");
    }
  }

  async schedulePost(channelId) {
    try {
      if (!channelId) {
        throw new Error("channelId не задан или недействителен");
      }
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
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
        } finally {
          // Обновляем время последнего срабатывания планировщика
          this.lastScheduledTime = Date.now();
          Notifier.log("[DEBUG] Завершение выполнения отложенного поста.");
          this.schedulePost(channelId);
        }
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
    } finally {
      Notifier.log("[DEBUG] Метод schedulePost завершён.");
    }
  }

  checkHealth() {
    try {
      const now = Date.now();
      const threshold = 10 * 60 * 1000; // 10 минут
      if (now - this.lastScheduledTime > threshold) {
        Notifier.warn(
          `[WARN] Планировщик не срабатывал более 10 минут. Последний запуск: ${new Date(this.lastScheduledTime).toISOString()}`,
        );
      } else {
        Notifier.log(
          `[INFO] Планировщик работает нормально. Последний запуск: ${new Date(this.lastScheduledTime).toISOString()}`,
        );
      }
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.checkHealth" });
    } finally {
      Notifier.log("[DEBUG] Завершение метода checkHealth.");
    }
  }
}

module.exports = Scheduler;
