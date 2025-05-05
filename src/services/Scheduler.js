const fs = require("fs/promises");
const { randomInt } = require("crypto");
const PostModel = require("../models/Post");
const Notifier = require("../utils/Notifier");

class Scheduler {
  #timeoutId = null;
  #channelId = null;
  #nextPostTime = null;

  /**
   * @param {object} model — генератор контента
   * @param {object} bot — экземпляр Telegram-бота
   */
  constructor(model, bot) {
    this.model = model;
    this.bot = bot;
    this.lastSuccessfulPostTime = Date.now();
  }

  // ——— Утилиты логирования ———
  static logDebug(message) {
    Notifier.log(`[DEBUG] ${message}`);
  }

  static logInfo(message) {
    Notifier.log(`[INFO] ${message}`);
  }

  static async logError(moduleName, error) {
    await Notifier.error(error, { module: moduleName });
  }

  // ——— Валидация ID канала ———
  static ensureChannelId(channelId) {
    if (!channelId || typeof channelId !== "string" || !channelId.trim()) {
      throw new Error("channelId не задан или недействителен");
    }
  }

  // ——— Получение текущего времени в зоне Asia/Almaty ———
  static getCurrentTimeAlmaty() {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Almaty",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    // формат en-CA: YYYY‑MM‑DD, HH:MM:SS
    const [datePart, timePart] = fmt.format(now).split(", ");
    return new Date(`${datePart}T${timePart}`);
  }

  // ——— Генерация случайной задержки в миллисекундах между min и max минутами ———
  static async getRandomDelay(minMinutes = 0, maxMinutes = 0) {
    try {
      if (minMinutes < 0 || maxMinutes < 0) {
        Scheduler.logDebug("minMinutes или maxMinutes < 0 — приводим к 0");
        minMinutes = Math.max(0, minMinutes);
        maxMinutes = Math.max(0, maxMinutes);
      }
      if (minMinutes > maxMinutes) {
        Scheduler.logDebug(
          `minMinutes > maxMinutes — меняем местами (${minMinutes}↔${maxMinutes})`
        );
        [minMinutes, maxMinutes] = [maxMinutes, minMinutes];
      }
      const minMs = minMinutes * 60_000;
      const maxMs = maxMinutes * 60_000;
      const delay = randomInt(minMs, maxMs + 1);
      Scheduler.logDebug(`Случайная задержка: ${delay} мс`);
      return delay;
    } catch (err) {
      await Scheduler.logError("Scheduler.getRandomDelay", err);
      return 0;
    }
  }

  // ——— Шанс пропустить пост (10%) ———
  static shouldSkipPost() {
    try {
      const skip = randomInt(0, 100) < 10;
      Scheduler.logDebug(`shouldSkipPost → ${skip}`);
      return skip;
    } catch (err) {
      Notifier.error(err, { module: "Scheduler.shouldSkipPost" });
      return false;
    }
  }

  // ——— Определение интервала (min, max) в минутах по часам Алматы ———
  static async getTimeInterval() {
    try {
      const nowALM = Scheduler.getCurrentTimeAlmaty();
      const h = nowALM.getHours();
      Scheduler.logDebug(`Almaty time ${nowALM.toISOString()} (hour=${h})`);
      if (h >= 8 && h < 16) return [5, 45];
      if (h >= 16 && h < 18) return [20, 90];
      if (h >= 18 && h < 23) return [45, 120];
      return [5, 45];
    } catch (err) {
      await Scheduler.logError("Scheduler.getTimeInterval", err);
      return [5, 45];
    }
  }

  // ——— Обновление документа в БД (upsert) ———
  static async updatePostRecord(lastPost, nextPost) {
    try {
      await PostModel.findByIdAndUpdate(
        "singleton",
        { lastPost, nextPost },
        { upsert: true }
      );
      Scheduler.logDebug(`PostRecord updated: last=${lastPost}, next=${nextPost}`);
    } catch (err) {
      await Scheduler.logError("Scheduler.updatePostRecord", err);
    }
  }

  // ——— Извлечение текста из чанка стрима ———
  static extractChunkText(chunk) {
    if (typeof chunk.text === "function") return chunk.text();
    if (typeof chunk.text === "string") return chunk.text;
    throw new Error("Chunk без текстового поля или метода text()");
  }

  // ——— Вычисление времени следующего поста (unix ms) ———
  static async computeNextPostTime() {
    try {
      const doc = await PostModel.findById("singleton");
      const last = doc?.lastPost ?? 0;
      let next = doc?.nextPost ?? 0;
      const now = Date.now();

      Scheduler.logDebug(`computeNextPostTime now=${now}, last=${last}, next=${next}`);

      if (next > now) {
        Scheduler.logInfo("Используем ранее запланированное время");
        return next;
      }

      const [min, max] = await Scheduler.getTimeInterval();
      const delay = await Scheduler.getRandomDelay(min, max);
      next = now + delay;

      await Scheduler.updatePostRecord(last, next);
      Scheduler.logDebug(`New nextPostTime=${new Date(next).toISOString()}`);
      return next;
    } catch (err) {
      await Scheduler.logError("Scheduler.computeNextPostTime", err);
      throw err;
    }
  }

  // ——— Генерация текста из промпта (stream) ———
  async generateTextFromPrompt(promptPath) {
    try {
      Scheduler.logInfo(`Читаем промпт: ${promptPath}`);
      const prompt = await fs.readFile(promptPath, "utf-8");
      const result = await this.model.generateContentStream(prompt);

      if (!result?.stream?.[Symbol.asyncIterator]) {
        throw new Error("stream нет или не асинхронный итератор");
      }

      let text = "";
      for await (const chunk of result.stream) {
        const t = Scheduler.extractChunkText(chunk);
        await this.bot.telegram.sendMessage(6153453766, `New chunk: ${t}`, {
          parse_mode: "HTML"
        });
        text += t;
      }
      Scheduler.logInfo("Генерация текста завершена");
      return text;
    } catch (err) {
      await Scheduler.logError("Scheduler.generateTextFromPrompt", err);
      return "";
    }
  }

  // ——— Отправка сообщения в Telegram ———
  async postQuoteToTelegram(channelId) {
    try {
      Scheduler.ensureChannelId(channelId);
      Scheduler.logInfo("Генерируем цитату для Telegram");
      const quote = await this.generateTextFromPrompt("./prompt.txt");
      if (!quote) throw new Error("Пустая цитата");
      await this.bot.telegram.sendMessage(channelId, quote, { parse_mode: "HTML" });
      Scheduler.logInfo("Цитата отправлена ✅");
    } catch (err) {
      await Scheduler.logError("Scheduler.postQuoteToTelegram", err);
      throw err;
    }
  }

  // ——— Обработчик одного запланированного поста ———
  async _handleScheduledPost() {
    try {
      if (Scheduler.shouldSkipPost()) {
        Scheduler.logInfo("😴 Пропускаем пост");
      } else {
        await this.postQuoteToTelegram(this.#channelId);
        await Scheduler.updatePostRecord(Date.now(), 0);
        Scheduler.logInfo("lastPost обновлён в БД");
      }
      this.lastSuccessfulPostTime = Date.now();
    } catch (err) {
      await Scheduler.logError("Scheduler._handleScheduledPost", err);
    }
  }

  /**
   * Запланировать цикл постинга
   * @param {string} channelId
   */
  async schedulePost(channelId) {
    try {
      Scheduler.ensureChannelId(channelId);
      this.#channelId = channelId;

      if (this.#timeoutId) clearTimeout(this.#timeoutId);

      this.#nextPostTime = await Scheduler.computeNextPostTime();
      const delay = Math.max(this.#nextPostTime - Date.now(), 0);

      Scheduler.logInfo(`Следующий пост через ${Math.round(delay / 60000)} мин.`);
      this.#timeoutId = setTimeout(async () => {
        await this._handleScheduledPost();
        // после выполнения планируем заново
        await this.schedulePost(channelId);
      }, delay);
    } catch (err) {
      await Scheduler.logError("Scheduler.schedulePost", err);
    }
  }

  /**
   * Принудительная отправка и перезапуск расписания
   * @param {string} channelId
   */
  async forcePost(channelId) {
    try {
      Scheduler.ensureChannelId(channelId);
      await Scheduler.updatePostRecord(Date.now(), 0);
      Scheduler.logInfo("Счётчик сброшен");
      await this.postQuoteToTelegram(channelId);
      this.lastSuccessfulPostTime = Date.now();
      Scheduler.logInfo("Принудительная отправка выполнена");
      await this.schedulePost(channelId);
    } catch (err) {
      await Scheduler.logError("Scheduler.forcePost", err);
    }
  }

  /**
   * Проверить «здоровье» планировщика и попытаться восстановить, если сбой
   * @returns {boolean} — true, если всё в порядке
   */
  async checkHealth() {
    const now = Date.now();
    const grace = 10 * 60_000; // 10 мин
    let healthy = true;

    if (
      this.#nextPostTime &&
      now > this.#nextPostTime + grace &&
      this.lastSuccessfulPostTime < this.#nextPostTime
    ) {
      Scheduler.logInfo("планировщик отстаёт от расписания");
      healthy = false;
    } else if (
      !this.#nextPostTime &&
      now - this.lastSuccessfulPostTime > grace
    ) {
      Scheduler.logInfo("цитата не отправлялась более 10 мин");
      healthy = false;
    }

    if (!healthy) {
      Scheduler.logInfo("пробуем автоперезапуск");
      clearTimeout(this.#timeoutId);
      if (this.#channelId) {
        await this.schedulePost(this.#channelId);
        Scheduler.logInfo("перезапущен автоматически");
      } else {
        Scheduler.logInfo("нет channelId — перезапустить нельзя");
      }
    } else {
      Scheduler.logDebug(
        `здоровье OK; next=${new Date(this.#nextPostTime).toISOString()}, lastOK=${new Date(
          this.lastSuccessfulPostTime
        ).toISOString()}`
      );
    }

    return healthy;
  }

  /** Отменить текущее расписание */
  cancelSchedule() {
    if (this.#timeoutId) {
      clearTimeout(this.#timeoutId);
      this.#timeoutId = null;
      Scheduler.logInfo("таймер отменён");
    }
  }
}

module.exports = Scheduler;
