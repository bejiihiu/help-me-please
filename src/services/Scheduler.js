const fs = require("fs/promises");
const { randomInt } = require("crypto");
const PostModel = require("../models/Post");
const Notifier = require("../utils/Notifier");

class Scheduler {
  constructor(model, bot) {
    Notifier.log("[DEBUG] Вызов конструктора Scheduler");
    this.model = model;
    Notifier.log("[DEBUG] Модель сохранена:", model);
    this.bot = bot;
    Notifier.log("[DEBUG] Бот сохранён:", bot);
    this.timeoutId = null;
    Notifier.log("[DEBUG] timeoutId инициализирован как null");
  }

  // Метод для остановки запланированного таймера
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
<<<<<<< HEAD
    Notifier.log(
      `[DEBUG] Вызов getRandomTime с minMinutes=${minMinutes}, maxMinutes=${maxMinutes}`,
    );
    const minMs = minMinutes * 60 * 1000;
    Notifier.log(`[DEBUG] Вычислено minMs=${minMs}`);
    const maxMs = maxMinutes * 60 * 1000;
    Notifier.log(`[DEBUG] Вычислено maxMs=${maxMs}`);
    const randomDelay = randomInt(minMs, maxMs + 1);
    Notifier.log(`[DEBUG] Вычислено randomDelay=${randomDelay}`);
    Notifier.log(
      `[DEBUG] Случайное время задержки: ${randomDelay} мс (от ${minMinutes} до ${maxMinutes} минут)`,
    );
    return randomDelay;
  }

  static shouldSkipPost() {
    Notifier.log("[DEBUG] Вызов shouldSkipPost");
    const skip = randomInt(0, 100) < 10;
    Notifier.log(
      `[DEBUG] Результат проверки пропуска поста: ${skip ? "Пропускаем" : "Отправляем"}`,
    );
    return skip;
  }

  static getTimeInterval() {
    Notifier.log("[DEBUG] Вызов getTimeInterval");
    const timezoneOffset = process.env.TIMEZONE_OFFSET
      ? parseInt(process.env.TIMEZONE_OFFSET)
      : 0;
    Notifier.log(`[DEBUG] Получен TIMEZONE_OFFSET: ${timezoneOffset}`);
    const currentTime = Date.now();
    Notifier.log(`[DEBUG] Текущее время (timestamp): ${currentTime}`);
    const localTime = new Date(currentTime + timezoneOffset * 3600000);
    Notifier.log(
      `[DEBUG] Локальное время с учетом TIMEZONE_OFFSET: ${localTime.toISOString()}`,
    );
    const hour = localTime.getHours();
    Notifier.log(`[DEBUG] Час: ${hour}`);
    if (hour >= 8 && hour < 12) {
      Notifier.log("[DEBUG] Выбраны интервалы [1, 45] минут");
      return [1, 45];
    }
    if (hour >= 12 && hour < 18) {
      Notifier.log("[DEBUG] Выбраны интервалы [20, 90] минут");
      return [20, 90];
    }
    if (hour >= 18 && hour < 23) {
      Notifier.log("[DEBUG] Выбраны интервалы [45, 120] минут");
      return [45, 120];
    }
    Notifier.log("[DEBUG] Выбраны интервалы [120, 300] минут");
    return [120, 300];
  }

  static async computeNextPostTime() {
    Notifier.log("[DEBUG] Вызов computeNextPostTime");
    const [minInterval, maxInterval] = Scheduler.getTimeInterval();
    Notifier.log(
      `[DEBUG] Интервалы: minInterval=${minInterval} мин, maxInterval=${maxInterval} мин`,
    );
    let postDoc;
    try {
      postDoc = await PostModel.findById("singleton");
      Notifier.log(
        `[DEBUG] Документ из базы данных: ${JSON.stringify(postDoc)}`,
      );
    } catch (dbError) {
      await Notifier.error(dbError, {
        module: "Scheduler.computeNextPostTime",
        stage: "fetch document",
      });
      postDoc = null;
    }
    let lastTime = postDoc && postDoc.lastPost ? postDoc.lastPost : 0;
    Notifier.log(`[DEBUG] lastTime=${lastTime}`);
    let nextPost = postDoc && postDoc.nextPost ? postDoc.nextPost : 0;
    Notifier.log(`[DEBUG] nextPost=${nextPost}`);
    const now = Date.now();
    Notifier.log(`[DEBUG] Текущее время now=${now}`);
    if (nextPost && nextPost > now) {
=======
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
      // Если произошла ошибка, возвращаем fallback (10 минут)
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
      return false; // По умолчанию не пропускать пост
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
      if (hour >= 8 && hour < 12) return [1, 45];
      if (hour >= 12 && hour < 18) return [20, 90];
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
>>>>>>> d589b5d (Fix scheduler)
      Notifier.log(
        `[DEBUG] Текущее время: ${now}, Последний пост: ${lastTime}, Следующий пост: ${nextPost}`,
      );
<<<<<<< HEAD
      return nextPost;
    }
    let delay = 0;
    if (lastTime) {
      const elapsedMinutes = (now - lastTime) / 60000;
      Notifier.log(
        `[DEBUG] Прошло времени с последнего поста: ${elapsedMinutes.toFixed(2)} минут`,
      );
      if (elapsedMinutes < minInterval) {
        delay = (minInterval - elapsedMinutes) * 60000;
=======
      if (nextPost && nextPost > now) {
>>>>>>> d589b5d (Fix scheduler)
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
<<<<<<< HEAD
        Notifier.log(`[DEBUG] Задержка после последнего поста: ${delay} мс`);
=======
        Notifier.log("[INFO] Нет предыдущих записей. Планируем первый пост.");
>>>>>>> d589b5d (Fix scheduler)
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
<<<<<<< HEAD
    nextPost = now + delay;
    Notifier.log(`[DEBUG] Расчет nextPost=${new Date(nextPost).toISOString()}`);
    try {
      await PostModel.findByIdAndUpdate(
        "singleton",
        { lastPost: lastTime, nextPost },
        { upsert: true },
      );
      Notifier.log("[DEBUG] Документ успешно обновлен в базе данных.");
    } catch (updateError) {
      await Notifier.error(updateError, {
        module: "Scheduler.computeNextPostTime",
        stage: "update document",
      });
    }
    Notifier.log(
      `[DEBUG] Следующий пост запланирован на: ${new Date(nextPost).toISOString()}`,
    );
    return nextPost;
=======
>>>>>>> d589b5d (Fix scheduler)
  }

  async generateTextFromPrompt(promptPath) {
    Notifier.log(
      `[DEBUG] Вызов generateTextFromPrompt с promptPath=${promptPath}`,
    );
    let resultText = "";
    try {
      Notifier.log(`[INFO] Чтение промпта из файла: ${promptPath}`);
      const prompt = await fs.readFile(promptPath, "utf-8");
      Notifier.log(`[DEBUG] Прочитанный промпт: ${prompt}`);
      const result = await this.model.generateContentStream(prompt);
<<<<<<< HEAD
      Notifier.log("[DEBUG] Результат генерации контента получен.");
      if (!result || !result.stream) {
        Notifier.log("[ERROR] Результат генерации не содержит stream.");
        return "";
=======
      if (
        !result?.stream ||
        typeof result.stream[Symbol.asyncIterator] !== "function"
      ) {
        throw new Error(
          "Неверный формат результата генерации: отсутствует асинхронный итератор stream",
        );
>>>>>>> d589b5d (Fix scheduler)
      }
      for await (const chunk of result.stream) {
        if (typeof chunk.text !== "function") {
          throw new Error("Неверный формат чанка: отсутствует функция text()");
        }
        const chunkText = chunk.text();
        Notifier.log(`[DEBUG] Обработан CHUNK: ${chunkText}`);
        resultText += chunkText;
      }
      Notifier.log(
        "[INFO] Генерация текста завершена. Итоговый текст: " + resultText,
      );
      return resultText;
    } catch (error) {
      await Notifier.error(error, {
        module: "Scheduler.generateTextFromPrompt",
        promptPath,
      });
      return "";
    } finally {
      Notifier.log("[DEBUG] Метод generateTextFromPrompt завершён.");
    }
  }

  async postQuoteToTelegram(channelId) {
    Notifier.log(`[DEBUG] Вызов postQuoteToTelegram с channelId=${channelId}`);
    try {
      if (!channelId) {
        throw new Error("channelId не задан или недействителен");
      }
      Notifier.log("[INFO] Начало генерации цитаты для Telegram.");
      const quote = await this.generateTextFromPrompt("./prompt.txt");
      Notifier.log(`[DEBUG] Сгенерированная цитата: ${quote}`);
      if (!quote) {
        await Notifier.error("[ERROR] Не удалось сгенерировать цитату.", {
          channelId,
        });
        return;
      }
      Notifier.log(
        `[DEBUG] Отправка сообщения в Telegram. channelId=${channelId}, message=💔 - ${quote}`,
      );
      await this.bot.telegram.sendMessage(channelId, `💔 - ${quote}`);
      Notifier.log("[INFO] ✅ Цитата успешно отправлена в Telegram канал");
    } catch (error) {
<<<<<<< HEAD
      await Notifier.error(error, {
        module: "Scheduler.postQuoteToTelegram",
        channelId,
      });
=======
      await Notifier.error(error, { module: "Scheduler.postQuoteToTelegram" });
    } finally {
      Notifier.log("[DEBUG] Метод postQuoteToTelegram завершён.");
>>>>>>> d589b5d (Fix scheduler)
    }
  }

  async schedulePost(channelId) {
    Notifier.log(`[DEBUG] Вызов schedulePost с channelId=${channelId}`);
    try {
<<<<<<< HEAD
      Notifier.log("[INFO] Начало планирования следующего поста.");
=======
      if (!channelId) {
        throw new Error("channelId не задан или недействителен");
      }
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
>>>>>>> d589b5d (Fix scheduler)
      const nextPostTime = await Scheduler.computeNextPostTime();
      Notifier.log(
        `[DEBUG] Вычисленное время следующего поста: ${new Date(nextPostTime).toISOString()}`,
      );
      const now = Date.now();
      Notifier.log(`[DEBUG] Текущее время: ${now}`);
      const delay = Math.max(nextPostTime - now, 0);
      Notifier.log(
        `[INFO] Планирование следующего поста через ${Math.round(delay / 60000)} минут (задержка ${delay} мс)`,
      );

      this.timeoutId = setTimeout(async () => {
        Notifier.log("[DEBUG] Запуск таймаута для публикации поста");
        try {
          if (Scheduler.shouldSkipPost()) {
            Notifier.log(
              "[INFO] 😴 Пост пропущен (симуляция человеческой небрежности)",
            );
          } else {
            Notifier.log("[DEBUG] Начало процесса публикации поста");
            await this.postQuoteToTelegram(channelId);
            Notifier.log(
              "[DEBUG] Обновление базы данных после публикации поста",
            );
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
            channelId,
          });
        } finally {
          Notifier.log("[DEBUG] Завершение выполнения отложенного поста.");
          // Рекурсивно планируем следующий пост после выполнения текущего
          this.schedulePost(channelId);
        }
<<<<<<< HEAD
        Notifier.log(
          "[DEBUG] Рекурсивный вызов schedulePost для следующей публикации",
        );
        this.schedulePost(channelId);
=======
>>>>>>> d589b5d (Fix scheduler)
      }, delay);
      Notifier.log("[DEBUG] Таймер установлен.");
    } catch (error) {
      await Notifier.error(error, {
        module: "Scheduler.schedulePost",
        channelId,
      });
      const fallbackDelay = Scheduler.getRandomTime(10, 15);
      Notifier.warn(
        `[WARN] Ошибка планирования поста. Попытка через ${Math.round(fallbackDelay / 60000)} минут.`,
      );
<<<<<<< HEAD
      this.timeoutId = setTimeout(() => {
        Notifier.log(
          "[DEBUG] Запуск таймаута fallback для повторного планирования поста",
        );
        this.schedulePost(channelId);
      }, fallbackDelay);
=======
      this.timeoutId = setTimeout(
        () => this.schedulePost(channelId),
        fallbackDelay,
      );
    } finally {
      Notifier.log("[DEBUG] Метод schedulePost завершён.");
>>>>>>> d589b5d (Fix scheduler)
    }
  }
}

module.exports = Scheduler;
