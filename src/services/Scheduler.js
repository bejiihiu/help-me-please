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
    // Время последней успешной обработки (отправка или корректный пропуск)
    this.lastSuccessfulPostTime = Date.now();
    // Сохраняем channelId для автоматического восстановления
    this.channelId = null;
    // Время следующего запланированного поста
    this.nextPostTime = null;
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

  // Возвращает текущее время для Алматы (GMT+5)
  static getCurrentTimeAlmaty() {
    return new Date(Date.now() + 5 * 3600000);
  }

  static getRandomTime(minMinutes, maxMinutes) {
    try {
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
      Notifier.log(`[DEBUG] Проверка пропуска поста: ${skip ? "Пропускаем" : "Отправляем"}`);
      return skip;
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.shouldSkipPost" });
      return false;
    } finally {
      Notifier.log("[DEBUG] Метод shouldSkipPost завершён.");
    }
  }

  // Определение интервала в минутах на основе текущего времени Алматы (GMT+5)
  static getTimeInterval() {
    try {
      const currentTime = Scheduler.getCurrentTimeAlmaty();
      Notifier.log(`[DEBUG] Текущее время для Алматы (GMT+5): ${currentTime.toISOString()}`);
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

  // Обновляет запись поста в базе
  static async updatePostRecord(lastPost, nextPost) {
    try {
      await PostModel.findByIdAndUpdate("singleton", { lastPost, nextPost }, { upsert: true });
      Notifier.log(`[DEBUG] Обновлена запись поста: lastPost=${lastPost}, nextPost=${nextPost}`);
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.updatePostRecord" });
    }
  }

  // Извлекает текст из чанка
  static extractChunkText(chunk) {
    if (typeof chunk.text === "function") {
      return chunk.text();
    } else if (typeof chunk.text === "string") {
      return chunk.text;
    } else {
      throw new Error("Неверный формат чанка: отсутствует функция text() или строка text");
    }
  }

  static async computeNextPostTime() {
    let nextPost = 0;
    try {
      const [minInterval, maxInterval] = Scheduler.getTimeInterval();
      const postDoc = await PostModel.findById("singleton");
      const lastTime = postDoc?.lastPost || 0;
      nextPost = postDoc?.nextPost || 0;
      const now = Date.now();
      Notifier.log(`[DEBUG] Текущее время: ${now}, Последний пост: ${lastTime}, Следующий пост: ${nextPost}`);
      if (nextPost && nextPost > now) {
        Notifier.log("[INFO] Используем запланированное время для следующего поста.");
        return nextPost;
      }
      let delay = 0;
      if (lastTime) {
        const elapsedMinutes = (now - lastTime) / 60000;
        if (elapsedMinutes < minInterval) {
          delay = (minInterval - elapsedMinutes) * 60000;
          Notifier.log(
            `[INFO] Недостаточно времени прошло с последнего поста (${elapsedMinutes.toFixed(
              2
            )} мин). Планируем через ${(delay / 60000).toFixed(2)} мин.`
          );
        } else {
          delay = Scheduler.getRandomTime(minInterval, maxInterval);
        }
      } else {
        delay = Scheduler.getRandomTime(minInterval, maxInterval);
        Notifier.log("[INFO] Нет предыдущих записей. Планируем первый пост.");
      }
      nextPost = now + delay;
      await Scheduler.updatePostRecord(lastTime, nextPost);
      Notifier.log(`[DEBUG] Следующий пост запланирован на: ${new Date(nextPost).toISOString()}`);
      return nextPost;
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.computeNextPostTime" });
      const fallbackDelay = Scheduler.getRandomTime(10, 15);
      Notifier.warn(
        `[WARN] Ошибка вычисления следующего поста. Используем fallback через ${Math.round(
          fallbackDelay / 60000
        )} минут.`
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
      if (!result?.stream || typeof result.stream[Symbol.asyncIterator] !== "function") {
        throw new Error("Неверный формат результата генерации: отсутствует асинхронный итератор stream");
      }
      for await (const chunk of result.stream) {
        const chunkText = Scheduler.extractChunkText(chunk);
        resultText += chunkText;
        Notifier.log("[DEBUG] Получен CHUNK:", chunkText);
      }
      Notifier.log("[INFO] Генерация текста завершена.");
      return resultText;
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.generateTextFromPrompt" });
      return "";
    } finally {
      Notifier.log("[DEBUG] Метод generateTextFromPrompt завершён.");
    }
  }

  async postQuoteToTelegram(channelId) {
    try {
      Scheduler.validateChannelId(channelId);
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
      Scheduler.validateChannelId(channelId);
      this.channelId = channelId;
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      const nextPostTime = await Scheduler.computeNextPostTime();
      this.nextPostTime = nextPostTime;
      const delay = Math.max(nextPostTime - Date.now(), 0);
      Notifier.log(`[INFO] Планирование следующего поста через ${Math.round(delay / 60000)} минут`);
      this.timeoutId = setTimeout(async () => {
        try {
          let handled = false;
          if (Scheduler.shouldSkipPost()) {
            Notifier.log("[INFO] 😴 Пост пропущен (симуляция человеческой небрежности)");
            handled = true;
          } else {
            await this.postQuoteToTelegram(channelId);
            await Scheduler.updatePostRecord(Date.now(), 0);
            Notifier.log("[INFO] Время последнего поста обновлено в базе данных.");
            handled = true;
          }
          if (handled) {
            this.lastSuccessfulPostTime = Date.now();
          }
        } catch (error) {
          await Notifier.error(error, { module: "Scheduler.schedulePost inner" });
        } finally {
          this.lastScheduledTime = Date.now();
          Notifier.log("[DEBUG] Завершение выполнения отложенного поста.");
          this.schedulePost(channelId);
        }
      }, delay);
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.schedulePost" });
      const fallbackDelay = Scheduler.getRandomTime(10, 15);
      Notifier.warn(
        `[WARN] Ошибка планирования поста. Попытка через ${Math.round(fallbackDelay / 60000)} минут.`
      );
      this.timeoutId = setTimeout(() => this.schedulePost(channelId), fallbackDelay);
    } finally {
      Notifier.log("[DEBUG] Метод schedulePost завершён.");
    }
  }

  checkHealth() {
    try {
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
          this.schedulePost(this.channelId);
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
    } catch (error) {
      Notifier.error(error, { module: "Scheduler.checkHealth" });
      return false;
    } finally {
      Notifier.log("[DEBUG] Завершение метода checkHealth.");
    }
  }
}

module.exports = Scheduler;