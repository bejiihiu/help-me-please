const express = require("express");
const helmet = require("helmet");
const fs = require("fs/promises");
const { webhookPath, env } = require("./config");
const Notifier = require("./utils/Notifier");
const Database = require("./services/Database");
const Scheduler = require("./services/Scheduler");
const setupBot = require("./bot/bot");
const { GoogleGenerativeAI } = require("@google/generative-ai");

class App {
  constructor() {
    this.app = express();
    this.server = null;
    this.scheduler = null;
    this.model = null;
    this.bot = null;
  }

  async initializeModel() {
    try {
      Notifier.log("[INFO] Инициализация генеративной модели...");
      const systemInstruction = await fs.readFile("system.txt", "utf-8");
      const genAI = new GoogleGenerativeAI(env.GEMINI_KEY);
      this.model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash-thinking-exp-01-21",
        generationConfig: {
          temperature: 0.9,
          topP: 0.9,
          topK: 40,
          candidateCount: 1,
          responseLogprobs: false,
        },
        systemInstruction,
      });
      Notifier.log("[INFO] Генеративная модель успешно инициализирована.");
    } catch (error) {
      await Notifier.error(error, { module: "App.initializeModel" });
      throw error;
    }
  }

  async initializeExpress() {
    this.app.use(express.json());
    this.app.use(helmet());
    this.app.get("/", (req, res) => res.send("OK"));
    Notifier.log("[INFO] Express настроен с helmet и health-check endpoint.");
  }

  async initializeBot() {
    this.bot = setupBot(this);
    this.app.use(this.bot.webhookCallback(webhookPath));
    Notifier.log("[INFO] Telegraf бот инициализирован и подключен к Express.");
  }

  async startServer() {
    try {
      Notifier.log("[INFO] Запуск инициализации приложения...");
      await Database.connect();
      await this.initializeModel();
      await this.initializeExpress();
      await this.initializeBot();

      const PORT = env.PORT || 3000;
      this.server = this.app.listen(PORT, async () => {
        Notifier.log(`🚀 Express сервер запущен на порту ${PORT}`);
        this.scheduler = new Scheduler(this.model, this.bot);
        await this.scheduler.postQuoteToTelegram(env.TELEGRAM_CHANNEL_ID);
        this.scheduler.schedulePost(env.TELEGRAM_CHANNEL_ID);
      });

      const shutdown = () => {
        Notifier.log(
          "[INFO] Получен сигнал завершения. Закрываем сервер и соединения...",
        );
        if (this.scheduler && this.scheduler.timeoutId) {
          clearTimeout(this.scheduler.timeoutId);
        }
        if (this.server) {
          this.server.close(() => {
            require("mongoose").connection.close(false, () => {
              Notifier.log("[INFO] Соединение с MongoDB закрыто.");
              process.exit(0);
            });
          });
        }
      };
      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);
    } catch (error) {
      await Notifier.error(error, { module: "App.startServer" });
      Notifier.error(
        "[ERROR] Ошибка инициализации, повторный запуск через 15 секунд...",
      );
      setTimeout(() => this.startServer(), 15000);
    }
  }

  restart() {
    Notifier.log("[INFO] Перезапуск приложения...");
    if (this.bot) {
      this.bot.stop("restart");
      Notifier.log("[INFO] Telegraf бот остановлен для перезапуска.");
    }
    if (this.server) {
      this.server.close(() => {
        require("mongoose").connection.close(false, async () => {
          Notifier.log("[INFO] Соединения закрыты. Перезапуск...");
          await this.startServer();
        });
      });
    } else {
      this.startServer();
    }
  }

  shutdown() {
    Notifier.warn("[WARN] Остановка приложения...");
    if (this.bot) {
      this.bot.stop("shutdown");
      Notifier.log("[INFO] Telegraf бот остановлен.");
    }
    if (this.server) {
      this.server.close(() => {
        require("mongoose").connection.close(false, () => {
          Notifier.log("[INFO] Соединения закрыты.");
          process.exit(0);
        });
      });
    } else {
      process.exit(0);
    }
  }
}

// Глобальная обработка ошибок
process.on("unhandledRejection", (reason) => {
  Notifier.error(reason, { module: "global unhandledRejection" });
  Notifier.error("[ERROR] Необработанное отклонение. Похуй.");
});
process.on("uncaughtException", (error) => {
  Notifier.error(error, { module: "global uncaughtException" });
  Notifier.error("[ERROR] Необработанное исключение. Не завершаем работу.");
});

module.exports = App;
