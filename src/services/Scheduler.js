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

  static getRandomTime(minMinutes, maxMinutes) {
    Notifier.log(`[DEBUG] Вызов getRandomTime с minMinutes=${minMinutes}, maxMinutes=${maxMinutes}`);
    const minMs = minMinutes * 60 * 1000;
    Notifier.log(`[DEBUG] Вычислено minMs=${minMs}`);
    const maxMs = maxMinutes * 60 * 1000;
    Notifier.log(`[DEBUG] Вычислено maxMs=${maxMs}`);
    const randomDelay = randomInt(minMs, maxMs + 1);
    Notifier.log(`[DEBUG] Вычислено randomDelay=${randomDelay}`);
    Notifier.log(`[DEBUG] Случайное время задержки: ${randomDelay} мс (от ${minMinutes} до ${maxMinutes} минут)`);
    return randomDelay;
  }

  static shouldSkipPost() {
    Notifier.log("[DEBUG] Вызов shouldSkipPost");
    const skip = randomInt(0, 100) < 10;
    Notifier.log(`[DEBUG] Результат проверки пропуска поста: ${skip ? "Пропускаем" : "Отправляем"}`);
    return skip;
  }

  static getTimeInterval() {
    Notifier.log("[DEBUG] Вызов getTimeInterval");
    const timezoneOffset = process.env.TIMEZONE_OFFSET ? parseInt(process.env.TIMEZONE_OFFSET) : 0;
    Notifier.log(`[DEBUG] Получен TIMEZONE_OFFSET: ${timezoneOffset}`);
    const currentTime = Date.now();
    Notifier.log(`[DEBUG] Текущее время (timestamp): ${currentTime}`);
    const localTime = new Date(currentTime + timezoneOffset * 3600000);
    Notifier.log(`[DEBUG] Локальное время с учетом TIMEZONE_OFFSET: ${localTime.toISOString()}`);
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
    Notifier.log(`[DEBUG] Интервалы: minInterval=${minInterval} мин, maxInterval=${maxInterval} мин`);
    let postDoc;
    try {
      postDoc = await PostModel.findById("singleton");
      Notifier.log(`[DEBUG] Документ из базы данных: ${JSON.stringify(postDoc)}`);
    } catch (dbError) {
      await Notifier.error(dbError, { module: "Scheduler.computeNextPostTime", stage: "fetch document" });
      postDoc = null;
    }
    let lastTime = postDoc && postDoc.lastPost ? postDoc.lastPost : 0;
    Notifier.log(`[DEBUG] lastTime=${lastTime}`);
    let nextPost = postDoc && postDoc.nextPost ? postDoc.nextPost : 0;
    Notifier.log(`[DEBUG] nextPost=${nextPost}`);
    const now = Date.now();
    Notifier.log(`[DEBUG] Текущее время now=${now}`);
    if (nextPost && nextPost > now) {
      Notifier.log("[INFO] Используем запланированное время для следующего поста.");
      return nextPost;
    }
    let delay = 0;
    if (lastTime) {
      const elapsedMinutes = (now - lastTime) / 60000;
      Notifier.log(`[DEBUG] Прошло времени с последнего поста: ${elapsedMinutes.toFixed(2)} минут`);
      if (elapsedMinutes < minInterval) {
        delay = (minInterval - elapsedMinutes) * 60000;
        Notifier.log(`[INFO] Недостаточно времени прошло с последнего поста (${elapsedMinutes.toFixed(2)} мин). Планируем через ${(delay / 60000).toFixed(2)} мин.`);
      } else {
        delay = Scheduler.getRandomTime(minInterval, maxInterval);
        Notifier.log(`[DEBUG] Задержка после последнего поста: ${delay} мс`);
      }
    } else {
      delay = Scheduler.getRandomTime(minInterval, maxInterval);
      Notifier.log("[INFO] Нет предыдущих записей. Планируем первый пост.");
    }
    nextPost = now + delay;
    Notifier.log(`[DEBUG] Расчет nextPost=${new Date(nextPost).toISOString()}`);
    try {
      await PostModel.findByIdAndUpdate(
        "singleton",
        { lastPost: lastTime, nextPost },
        { upsert: true }
      );
      Notifier.log("[DEBUG] Документ успешно обновлен в базе данных.");
    } catch (updateError) {
      await Notifier.error(updateError, { module: "Scheduler.computeNextPostTime", stage: "update document" });
    }
    Notifier.log(`[DEBUG] Следующий пост запланирован на: ${new Date(nextPost).toISOString()}`);
    return nextPost;
  }

  async generateTextFromPrompt(promptPath) {
    Notifier.log(`[DEBUG] Вызов generateTextFromPrompt с promptPath=${promptPath}`);
    let resultText = "";
    try {
      Notifier.log(`[INFO] Чтение промпта из файла: ${promptPath}`);
      const prompt = await fs.readFile(promptPath, "utf-8");
      Notifier.log(`[DEBUG] Прочитанный промпт: ${prompt}`);
      const result = await this.model.generateContentStream(prompt);
      Notifier.log("[DEBUG] Результат генерации контента получен.");
      if (!result || !result.stream) {
        Notifier.log("[ERROR] Результат генерации не содержит stream.");
        return "";
      }
      for await (const chunk of result.stream) {
        const chunkText = chunk.text();
        Notifier.log(`[DEBUG] Обработан CHUNK: ${chunkText}`);
        resultText += chunkText;
      }
      Notifier.log("[INFO] Генерация текста завершена. Итоговый текст: " + resultText);
      return resultText;
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.generateTextFromPrompt", promptPath });
      return "";
    }
  }

  async postQuoteToTelegram(channelId) {
    Notifier.log(`[DEBUG] Вызов postQuoteToTelegram с channelId=${channelId}`);
    try {
      Notifier.log("[INFO] Начало генерации цитаты для Telegram.");
      const quote = await this.generateTextFromPrompt("./prompt.txt");
      Notifier.log(`[DEBUG] Сгенерированная цитата: ${quote}`);
      if (!quote) {
        await Notifier.error("[ERROR] Не удалось сгенерировать цитату.", { channelId });
        return;
      }
      Notifier.log(`[DEBUG] Отправка сообщения в Telegram. channelId=${channelId}, message=💔 - ${quote}`);
      await this.bot.telegram.sendMessage(channelId, `💔 - ${quote}`);
      Notifier.log("[INFO] ✅ Цитата успешно отправлена в Telegram канал");
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.postQuoteToTelegram", channelId });
    }
  }

  async schedulePost(channelId) {
    Notifier.log(`[DEBUG] Вызов schedulePost с channelId=${channelId}`);
    try {
      Notifier.log("[INFO] Начало планирования следующего поста.");
      const nextPostTime = await Scheduler.computeNextPostTime();
      Notifier.log(`[DEBUG] Вычисленное время следующего поста: ${new Date(nextPostTime).toISOString()}`);
      const now = Date.now();
      Notifier.log(`[DEBUG] Текущее время: ${now}`);
      const delay = Math.max(nextPostTime - now, 0);
      Notifier.log(`[INFO] Планирование следующего поста через ${Math.round(delay / 60000)} минут (задержка ${delay} мс)`);
      this.timeoutId = setTimeout(async () => {
        Notifier.log("[DEBUG] Запуск таймаута для публикации поста");
        try {
          if (Scheduler.shouldSkipPost()) {
            Notifier.log("[INFO] 😴 Пост пропущен (симуляция человеческой небрежности)");
          } else {
            Notifier.log("[DEBUG] Начало процесса публикации поста");
            await this.postQuoteToTelegram(channelId);
            Notifier.log("[DEBUG] Обновление базы данных после публикации поста");
            await PostModel.findByIdAndUpdate(
              "singleton",
              { lastPost: Date.now(), nextPost: 0 },
              { upsert: true }
            );
            Notifier.log("[INFO] Время последнего поста обновлено в базе данных.");
          }
        } catch (error) {
          await Notifier.error(error, { module: "Scheduler.schedulePost inner", channelId });
        }
        Notifier.log("[DEBUG] Рекурсивный вызов schedulePost для следующей публикации");
        this.schedulePost(channelId);
      }, delay);
      Notifier.log("[DEBUG] Таймер установлен.");
    } catch (error) {
      await Notifier.error(error, { module: "Scheduler.schedulePost", channelId });
      const fallbackDelay = Scheduler.getRandomTime(10, 15);
      Notifier.warn(`[WARN] Ошибка планирования поста. Попытка через ${Math.round(fallbackDelay / 60000)} минут.`);
      this.timeoutId = setTimeout(() => {
        Notifier.log("[DEBUG] Запуск таймаута fallback для повторного планирования поста");
        this.schedulePost(channelId);
      }, fallbackDelay);
    }
  }
}

module.exports = Scheduler;