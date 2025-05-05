const express = require("express");
const helmet = require("helmet");
const fs = require("fs/promises");
const { webhookPath, env } = require("./config");
const Notifier = require("./utils/Notifier");
const Database = require("./services/Database");
const Scheduler = require("./services/Scheduler");
const setupBot = require("./bot/bot");
const { GoogleGenAI } = require("@google/genai");
const mongoose = require("mongoose");

class App {
  constructor() {
    this.lastCheckTime = Date.now();
    this.app = express();
    this.server = null;
    this.scheduler = null;
    this.schedulerHealthInterval = null;
    this.model = null;
    this.bot = null;
    this.sendCommandRegistered = false;
  }

  // Логирование начала/конца метода
  static logStart(methodName) {
    Notifier.log(`[DEBUG] Начало ${methodName}`);
  }

  static logEnd(methodName) {
    Notifier.log(`[DEBUG] Метод ${methodName} завершён.`);
  }

  static async safeExecute(methodName, fn) {
    App.logStart(methodName);
    try {
      return await fn();
    } catch (error) {
      await Notifier.error(error, { module: methodName });
      throw error;
    } finally {
      App.logEnd(methodName);
    }
  }

  // Инициализация генеративной модели
  async initializeModel() {
    return App.safeExecute("App.initializeModel", async () => {
      Notifier.log("[INFO] Инициализация генеративной модели...");
      if (!env.GEMINI_KEY) {
        throw new Error("Отсутствует ключ GEMINI_KEY в конфигурации.");
      }
      this.model = new GoogleGenAI({ apiKey: env.GEMINI_KEY });
      Notifier.log("[INFO] Генеративная модель успешно инициализирована.");
    });
  }

  // Настройка health- и force‑эндпоинтов
  setupHealthEndpoint() {
    this.app.get("/", async (req, res) => {
      try {
        if (Date.now() - this.lastCheckTime < 15 * 60 * 1000) {
          return res.status(200).send("OK");
        }
        if (this.scheduler) {
          const health = await this.scheduler.checkHealth();
          return res.status(200).send(health ? "OK" : "Service Unavailable");
        }
        return res.status(500).send("Scheduler is not initialized");
      } catch (error) {
        await Notifier.error(error, { module: "App.healthCheck" });
        return res.status(500).send("Error in health-check");
      } finally {
        this.lastCheckTime = Date.now();
      }
    });
  }

  setupForceEndpoint() {
    this.app.get("/force", async (req, res) => {
      try {
        await this.scheduler.forcePost(env.TELEGRAM_CHANNEL_ID);
        return res.status(200).send("OK");
      } catch (error) {
        await Notifier.error(error, { module: "App.forceEndpoint" });
        return res.status(500).send("Error in force endpoint");
      }
    });
  }

  // Инициализация Express
  async initializeExpress() {
    return App.safeExecute("App.initializeExpress", async () => {
      this.app.use(express.json());
      this.app.use(helmet());
      this.setupHealthEndpoint();
      this.setupForceEndpoint();
      Notifier.log("[INFO] Express настроен с helmet и health-check endpoint.");
    });
  }

  // Инициализация Telegram‑бота
  async initializeBot() {
    return App.safeExecute("App.initializeBot", async () => {
      this.bot = setupBot(this);
      if (!this.bot || typeof this.bot.webhookCallback !== "function") {
        throw new Error("Бот не инициализирован корректно.");
      }
      this.app.use(this.bot.webhookCallback(webhookPath));
      Notifier.log("[INFO] Telegraf бот инициализирован и подключен к Express.");
    });
  }

  // Запуск сервера
  async startServer() {
    return App.safeExecute("App.startServer", async () => {
      Notifier.log("[INFO] Запуск инициализации приложения...");
      await Database.connect();
      await this.initializeModel();
      await this.initializeExpress();
      await this.initializeBot();

      const PORT = env.PORT || 3000;
      this.server = this.app.listen(PORT, this.onServerListening.bind(this));
    });
  }

  // Обработчик события "сервер запущен"
  async onServerListening() {
    Notifier.log(`🚀 Express сервер запущен на порту ${env.PORT || 3000}`);
    await this.ensureTelegramConfig();
    this.initializeScheduler();
    this.registerSendCommand();
  }

  // Проверка наличия TELEGRAM_CHANNEL_ID
  async ensureTelegramConfig() {
    if (!env.TELEGRAM_CHANNEL_ID) {
      throw new Error("Отсутствует TELEGRAM_CHANNEL_ID в конфигурации.");
    }
  }

  // Настройка и запуск Scheduler
  initializeScheduler() {
    if (this.scheduler) {
      this.scheduler.cancelSchedule();
    }
    this.scheduler = new Scheduler(this.model, this.bot);

    this.scheduler
      .postQuoteToTelegram(env.TELEGRAM_CHANNEL_ID)
      .catch(err =>
        Notifier.error(err, { module: "Scheduler.postQuoteToTelegram" })
      );

    this.scheduler.schedulePost(env.TELEGRAM_CHANNEL_ID);
  }

  // Регистрация команды /send в боте
  registerSendCommand() {
    if (this.sendCommandRegistered) {
      return;
    }
    this.bot.command("send", async ctx => {
      try {
        await this.scheduler.postQuoteToTelegram(env.TELEGRAM_CHANNEL_ID);
        ctx.reply("Пост отправлен");
      } catch (error) {
        await Notifier.error(error, { module: "App.sendCommand" });
      } finally {
        Notifier.log("[DEBUG] Завершение command.send.");
      }
    });
    this.sendCommandRegistered = true;
  }

  // Закрытие серверных соединений и MongoDB
  async closeServices() {
    await new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close(err => {
          if (err) {
            Notifier.error(err, { module: "App.closeServices.serverClose" });
            return reject(err instanceof Error ? err : new Error(err));
          }
          resolve();
        });
      } else {
        resolve();
      }
    });

    await new Promise((resolve, reject) => {
      mongoose.connection.close(false, err => {
        if (err) {
          Notifier.error(err, { module: "App.closeServices.mongooseClose" });
          return reject(err instanceof Error ? err : new Error(err));
        }
        resolve();
      });
    });
  }

  // Перезапуск приложения
  async restart() {
    return App.safeExecute("App.restart", async () => {
      Notifier.log("[INFO] Перезапуск приложения...");
      if (this.scheduler) {
        this.scheduler.cancelSchedule();
      }
      if (this.schedulerHealthInterval) {
        clearInterval(this.schedulerHealthInterval);
        this.schedulerHealthInterval = null;
      }
      if (this.bot) {
        try {
          this.bot.stop("restart");
          Notifier.log("[INFO] Telegraf бот остановлен для перезапуска.");
        } catch (botError) {
          await Notifier.error(botError, { module: "App.restart.botStop" });
        }
      }
      await this.closeServices();
      Notifier.log("[INFO] Соединения закрыты. Перезапуск...");
      await this.startServer();
    });
  }

  // Корректное завершение работы
  async shutdowns() {
    return App.safeExecute("App.shutdowns", async () => {
      Notifier.warn("[WARN] Остановка приложения...");
      if (this.scheduler) {
        this.scheduler.cancelSchedule();
      }
      if (this.schedulerHealthInterval) {
        clearInterval(this.schedulerHealthInterval);
        this.schedulerHealthInterval = null;
      }
      if (this.bot) {
        try {
          this.bot.stop("shutdown");
          Notifier.log("[INFO] Telegraf бот остановлен.");
        } catch (botError) {
          await Notifier.error(botError, { module: "App.shutdowns.botStop" });
        }
      }
      await this.closeServices();
      Notifier.log("[INFO] Соединения закрыты.");
      process.exit(0);
    });
  }

  // Игнорируем прямой сигнал shutdown
  shutdown() {
    console.log("Ignoring shutdown signal.");
  }
}

// Глобальная обработка ошибок
process.on("unhandledRejection", reason => {
  Notifier.error(reason, { module: "global unhandledRejection" });
  Notifier.error("[ERROR] Необработанное отклонение.");
});
process.on("uncaughtException", error => {
  Notifier.error(error, { module: "global uncaughtException" });
  Notifier.error("[ERROR] Необработанное исключение.");
});

module.exports = App;
