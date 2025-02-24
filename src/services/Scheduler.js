const fs = require("fs/promises");
const { randomInt } = require("crypto");
const PostModel = require("../models/Post");
const Notifier = require("../utils/Notifier");

class Scheduler {
  constructor(model, bot) {
    this.model = model;
    this.bot = bot;
    this.timeoutId = null;
    this.lastScheduledTime = Date.now();
    this.lastSuccessfulPostTime = Date.now();
    this.channelId = null;
    this.nextPostTime = null;
  }

  // Вспомогательные методы для логирования и обработки ошибок
  static logStart(methodName) {
    Notifier.log(`[DEBUG] Начало ${methodName}`);
  }

  static logEnd(methodName) {
    Notifier.log(`[DEBUG] Метод ${methodName} завершён.`);
  }

  static async safeExecute(methodName, fn) {
    Scheduler.logStart(methodName);
    try {
      return await fn();
    } catch (error) {
      await Notifier.error(error, { module: methodName });
      throw error;
    } finally {
      Scheduler.logEnd(methodName);
    }
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

  // Проверка корректности channelId
  static validateChannelId(channelId) {
    if (!channelId || typeof channelId !== "string" || channelId.trim() === "") {
      throw new Error("channelId не задан или недействителен");
    }
  }

  // Возвращает текущее время для Алматы (Asia/Almaty)
  static getCurrentTimeAlmaty() {
    return new Date(
      new Date().toLocaleString("en-US", { timeZone: "Asia/Almaty" })
    );
  }

  static getRandomTime(minMinutes, maxMinutes) {
    return Scheduler.safeExecute("Scheduler.getRandomTime", async () => {
      if (minMinutes < 0 || maxMinutes < 0) {
        Notifier.warn("[WARN] minMinutes или maxMinutes меньше 0. Приводим к 0.");
        minMinutes = Math.max(minMinutes, 0);
        maxMinutes = Math.max(maxMinutes, 0);
      }
      if (minMinutes > maxMinutes) {
        Notifier.warn(
          `[WARN] minMinutes (${minMinutes}) больше maxMinutes (${maxMinutes}). Значения изменены местами.`
        );
        [minMinutes, maxMinutes] = [maxMinutes, minMinutes];
      }
      const minMs = minMinutes * 60 * 1000;
      const maxMs = maxMinutes * 60 * 1000;
      const randomDelay = randomInt(minMs, maxMs + 1);
      Notifier.log(
        `[DEBUG] Случайное время задержки: ${randomDelay} мс (от ${minMinutes} до ${maxMinutes} минут)`
      );
      return randomDelay;
    });
  }

  static shouldSkipPost() {
    try {
      const skip = randomInt(0, 100) < 10;
      Notifier.log(
        `[DEBUG] Проверка пропуска поста: ${skip ? "Пропускаем" : "Отправляем"}`
      );
      return skip;
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.shouldSkipPost" });
      return false;
    } finally {
      Notifier.log("[DEBUG] Метод shouldSkipPost завершён.");
    }
  }

  // Определение интервала в минутах на основе текущего времени Алматы (Asia/Almaty)
  static getTimeInterval() {
    return Scheduler.safeExecute("Scheduler.getTimeInterval", async () => {
      const currentTime = Scheduler.getCurrentTimeAlmaty();
      const hour = currentTime.getHours();
      Notifier.log(
        `[DEBUG] Текущее время для Алматы (Asia/Almaty): ${currentTime.toISOString()}, час: ${hour}`
      );
      if (hour >= 8 && hour < 16) return [5, 45];
      if (hour >= 16 && hour < 18) return [20, 90];
      if (hour >= 18 && hour < 23) return [45, 120];
      return [5, 45];
    });
  }

  // Обновляет запись поста в базе
  static async updatePostRecord(lastPost, nextPost) {
    return Scheduler.safeExecute("Scheduler.updatePostRecord", async () => {
      await PostModel.findByIdAndUpdate(
        "singleton",
        { lastPost, nextPost },
        { upsert: true }
      );
      Notifier.log(
        `[DEBUG] Обновлена запись поста: lastPost=${lastPost}, nextPost=${nextPost}`
      );
    });
  }

  // Извлекает текст из чанка
  static extractChunkText(chunk) {
    if (typeof chunk.text === "function") {
      return chunk.text();
    } else if (typeof chunk.text === "string") {
      return chunk.text;
    } else {
      throw new Error(
        "Неверный формат чанка: отсутствует функция text() или строка text"
      );
    }
  }

  // Микрофункция для вычисления задержки на следующий пост
  static async calculateDelay(lastTime) {
    const now = Date.now();
    const [minInterval, maxInterval] = await Scheduler.getTimeInterval();
    if (lastTime) {
      const elapsedMinutes = (now - lastTime) / 60000;
      if (elapsedMinutes < minInterval) {
        const delay = (minInterval - elapsedMinutes) * 60000;
        Notifier.log(
          `[INFO] Недостаточно времени прошло с последнего поста (${elapsedMinutes.toFixed(
            2
          )} мин). Планируем через ${(delay / 60000).toFixed(2)} мин.`
        );
        return delay;
      } else {
        return Scheduler.getRandomTime(minInterval, maxInterval);
      }
    } else {
      Notifier.log("[INFO] Нет предыдущих записей. Планируем первый пост.");
      return Scheduler.getRandomTime(minInterval, maxInterval);
    }
  }

  // Вычисление времени следующего поста
  static async computeNextPostTime() {
    return Scheduler.safeExecute("Scheduler.computeNextPostTime", async () => {
      const postDoc = await PostModel.findById("singleton");
      const lastTime = postDoc?.lastPost || 0;
      let nextPost = postDoc?.nextPost || 0;
      const now = Date.now();
      Notifier.log(
        `[DEBUG] Текущее время: ${now}, Последний пост: ${lastTime}, Следующий пост: ${nextPost}`
      );
      if (nextPost && nextPost > now) {
        Notifier.log("[INFO] Используем запланированное время для следующего поста.");
        return nextPost;
      }
      const delay = await Scheduler.calculateDelay(lastTime);
      nextPost = now + delay;
      await Scheduler.updatePostRecord(lastTime, nextPost);
      Notifier.log(
        `[DEBUG] Следующий пост запланирован на: ${new Date(nextPost).toISOString()}`
      );
      return nextPost;
    });
  }

  async generateTextFromPrompt(promptPath) {
    return Scheduler.safeExecute("Scheduler.generateTextFromPrompt", async () => {
      Notifier.log(`[INFO] Чтение промпта из файла: ${promptPath}`);
      const prompt = await fs.readFile(promptPath, "utf-8");
      const result = await this.model.generateContentStream(prompt);
      if (
        !result?.stream ||
        typeof result.stream[Symbol.asyncIterator] !== "function"
      ) {
        throw new Error(
          "Неверный формат результата генерации: отсутствует асинхронный итератор stream"
        );
      }
      let resultText = "";
      for await (const chunk of result.stream) {
        const chunkText = Scheduler.extractChunkText(chunk);
        resultText += chunkText;
        Notifier.log("[DEBUG] Получен CHUNK:", chunkText);
      }
      Notifier.log("[INFO] Генерация текста завершена.");
      return resultText;
    });
  }

  async postQuoteToTelegram(channelId) {
    return Scheduler.safeExecute("Scheduler.postQuoteToTelegram", async () => {
      Scheduler.validateChannelId(channelId);
      Notifier.log("[INFO] Начало генерации цитаты для Telegram.");
      const quote = await this.generateTextFromPrompt("./prompt.txt");
      if (!quote) {
        throw new Error("[ERROR] Не удалось сгенерировать цитату.");
      }
      await this.bot.telegram.sendMessage(channelId, `💔 - ${quote}`);
      Notifier.log("[INFO] ✅ Цитата успешно отправлена в Telegram канал");
    });
  }

  // Приватный метод для обработки запланированного поста
  async _handleScheduledPost() {
    return Scheduler.safeExecute("Scheduler._handleScheduledPost", async () => {
      if (Scheduler.shouldSkipPost()) {
        Notifier.log("[INFO] 😴 Пост пропущен (симуляция человеческой небрежности)");
      } else {
        await this.postQuoteToTelegram(this.channelId);
        await Scheduler.updatePostRecord(Date.now(), 0);
        Notifier.log("[INFO] Время последнего поста обновлено в базе данных.");
      }
      this.lastSuccessfulPostTime = Date.now();
    });
  }

  async schedulePost(channelId) {
    return Scheduler.safeExecute("Scheduler.schedulePost", async () => {
      Scheduler.validateChannelId(channelId);
      this.channelId = channelId;
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      const nextPostTime = await Scheduler.computeNextPostTime();
      this.nextPostTime = nextPostTime;
      const delay = Math.max(nextPostTime - Date.now(), 0);
      Notifier.log(
        `[INFO] Планирование следующего поста через ${Math.round(delay / 60000)} минут`
      );
      this.timeoutId = setTimeout(async () => {
        try {
          await this._handleScheduledPost();
        } catch (error) {
          await Notifier.error(error, { module: "Scheduler.schedulePost inner" });
        } finally {
          this.lastScheduledTime = Date.now();
          Notifier.log("[DEBUG] Завершение выполнения отложенного поста.");
          await this.schedulePost(channelId);
        }
      }, delay);
    });
  }

  async forcePost(channelId) {
    return Scheduler.safeExecute("Scheduler.forcePost", async () => {
      Scheduler.validateChannelId(channelId);
      await Scheduler.updatePostRecord(Date.now(), 0);
      Notifier.log("[INFO] Счётчик сброшен. Запись поста обновлена.");
      await this.postQuoteToTelegram(channelId);
      this.lastSuccessfulPostTime = Date.now();
      Notifier.log("[INFO] Принудительная отправка поста выполнена.");
      await this.schedulePost(channelId);
    });
  }

  async checkHealth() {
    return Scheduler.safeExecute("Scheduler.checkHealth", async () => {
      const now = Date.now();
      const threshold = 10 * 60 * 1000; // 10 минут
      let healthy = true;
      if (
        this.nextPostTime &&
        now > this.nextPostTime + threshold &&
        this.lastSuccessfulPostTime < this.nextPostTime
      ) {
        Notifier.warn(
          `[WARN] Планировщик отстаёт от расписания: запланированное время ${new Date(
            this.nextPostTime
          ).toISOString()} прошло, а цитата не отправлена.`
        );
        healthy = false;
      } else if (!this.nextPostTime && now - this.lastSuccessfulPostTime > threshold) {
        Notifier.warn(
          `[WARN] Цитата не отправлялась более ${threshold / 60000} минут.`
        );
        healthy = false;
      }
      if (!healthy) {
        Notifier.warn(
          `[WARN] Обнаружены проблемы со здоровьем планировщика. Попытка автоматического восстановления.`
        );
        this.cancelSchedule();
        if (this.channelId) {
          await this.schedulePost(this.channelId);
          Notifier.log("[INFO] Планировщик перезапущен автоматически.");
        } else {
          Notifier.warn(
            "[WARN] channelId не задан, невозможно перезапустить планировщик автоматически."
          );
        }
      } else {
        Notifier.log(
          `[INFO] Планировщик работает нормально. Запланированное время: ${
            this.nextPostTime ? new Date(this.nextPostTime).toISOString() : "не задано"
          }, последняя успешная обработка: ${new Date(this.lastSuccessfulPostTime).toISOString()}`
        );
      }
      return healthy;
    });
  }
}

module.exports = Scheduler;