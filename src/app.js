const express = require("express");
const helmet = require("helmet");
const fs = require("fs/promises");
const { webhookPath, env } = require("./config");
const Notifier = require("./utils/Notifier");
const Database = require("./services/Database");
const Scheduler = require("./services/Scheduler");
const setupBot = require("./bot/bot");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const mongoose = require("mongoose");

class App {
  constructor() {
    this.lastCheckTime = Date.now();
    this.app = express();
    this.server = null;
    this.scheduler = null;
    this.schedulerHealthInterval = null; // Интервал проверки планировщика (пока не используется)
    this.model = null;
    this.bot = null;
    this.sendCommandRegistered = false; // Флаг для регистрации команды /send
  }

  async initializeModel() {
    try {
      Notifier.log("[INFO] Инициализация генеративной модели...");
      if (!env.GEMINI_KEY) {
        throw new Error("Отсутствует ключ GEMINI_KEY в конфигурации.");
      }
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
    } finally {
      Notifier.log("[DEBUG] Завершение initializeModel.");
    }
  }

  async initializeExpress() {
    try {
      this.app.use(express.json());
      this.app.use(helmet());
      // Сделаем обработчик health-check асинхронным и корректно обрабатывающим ошибки
      this.app.get("/", async (req, res) => {
        try {
          if (Date.now() - this.lastCheckTime < 15 * 60 * 1000)
            return res.status(200).send("OK");
          if (this.scheduler) {
            const health = await this.scheduler.checkHealth();
            if (health) {
              return res.status(200).send("OK");
            }
            return res.status(503).send("Service Unavailable");
          }
          return res.status(500).send("Scheduler is not initialized");
        } catch (error) {
          await Notifier.error(error, { module: "App.healthCheck" });
          return res.status(500).send("Error in health-check");
        } finally {
          this.lastCheckTime = Date.now();
        }
      });
      Notifier.log("[INFO] Express настроен с helmet и health-check endpoint.");
    } catch (error) {
      await Notifier.error(error, { module: "App.initializeExpress" });
      throw error;
    } finally {
      Notifier.log("[DEBUG] Завершение initializeExpress.");
    }
  }

  async initializeBot() {
    try {
      this.bot = setupBot(this);
      if (!this.bot || typeof this.bot.webhookCallback !== "function") {
        throw new Error("Бот не инициализирован корректно.");
      }
      this.app.use(this.bot.webhookCallback(webhookPath));
      Notifier.log(
        "[INFO] Telegraf бот инициализирован и подключен к Express."
      );
    } catch (error) {
      await Notifier.error(error, { module: "App.initializeBot" });
      throw error;
    } finally {
      Notifier.log("[DEBUG] Завершение initializeBot.");
    }
  }

  async startServer() {
    try {
      Notifier.log("[INFO] Запуск инициализации приложения...");
      await Database.connect();
      await this.initializeModel();
      await this.initializeExpress();
      await this.initializeBot();

      const PORT = env.PORT || 3000;
      this.server = this.app.listen(PORT, () => {
        // Оборачиваем асинхронный код в IIFE для обработки ошибок
        (async () => {
          try {
            Notifier.log(`🚀 Express сервер запущен на порту ${PORT}`);
            if (!env.TELEGRAM_CHANNEL_ID) {
              throw new Error("Отсутствует TELEGRAM_CHANNEL_ID в конфигурации.");
            }
            // Если уже существует планировщик, отменяем его перед созданием нового
            if (this.scheduler) {
              this.scheduler.cancelSchedule();
            }
            this.scheduler = new Scheduler(this.model, this.bot);
            // Отправляем первый пост и запускаем цикл планирования
            await this.scheduler.postQuoteToTelegram(env.TELEGRAM_CHANNEL_ID);
            // Регистрируем команду /send только один раз
            if (!this.sendCommandRegistered) {
              this.bot.command("send", async (ctx) => {
                try {
                  await this.scheduler.postQuoteToTelegram(env.TELEGRAM_CHANNEL_ID);
                  ctx.reply("Пост отправлен");
                } catch (error) {
                  await Notifier.error(error, {
                    module: "App.startServer.command.send",
                  });
                } finally {
                  Notifier.log("[DEBUG] Завершение command.send.");
                }
              });
              this.sendCommandRegistered = true;
            }
            this.scheduler.schedulePost(env.TELEGRAM_CHANNEL_ID);
          } catch (error) {
            await Notifier.error(error, { module: "App.startServer.listenCallback" });
          } finally {
            Notifier.log("[DEBUG] Завершение колбэка app.listen.");
          }
        })();
      });
    } catch (error) {
      await Notifier.error(error, { module: "App.startServer" });
      Notifier.error(
        "[ERROR] Ошибка инициализации, повторный запуск через 15 секунд..."
      );
      setTimeout(() => this.startServer(), 15000);
    } finally {
      Notifier.log("[DEBUG] Завершение startServer.");
    }
  }

  async restart() {
    try {
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
      if (this.server) {
        await new Promise((resolve, reject) => {
          this.server.close((err) => {
            if (err) {
              Notifier.error(err, { module: "App.restart.serverClose" });
              return reject(err);
            }
            return resolve();
          });
        });
        await new Promise((resolve, reject) => {
          mongoose.connection.close(false, (err) => {
            if (err) {
              Notifier.error(err, { module: "App.restart.mongooseClose" });
              return reject(err);
            }
            return resolve();
          });
        });
        Notifier.log("[INFO] Соединения закрыты. Перезапуск...");
        await this.startServer();
      } else {
        await this.startServer();
      }
    } catch (error) {
      await Notifier.error(error, { module: "App.restart" });
    } finally {
      Notifier.log("[DEBUG] Завершение метода restart.");
    }
  }

  shutdown() {
    console.log("Ignoring shutdown signal.");
  }

  async shutdowns() {
    try {
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
      if (this.server) {
        await new Promise((resolve, reject) => {
          this.server.close((err) => {
            if (err) {
              Notifier.error(err, { module: "App.shutdowns.serverClose" });
              return reject(err);
            }
            return resolve();
          });
        });
        await new Promise((resolve, reject) => {
          mongoose.connection.close(false, (err) => {
            if (err) {
              Notifier.error(err, { module: "App.shutdowns.mongooseClose" });
              return reject(err);
            }
            return resolve();
          });
        });
        Notifier.log("[INFO] Соединения закрыты.");
        process.exit(0);
      } else {
        process.exit(0);
      }
    } catch (error) {
      await Notifier.error(error, { module: "App.shutdowns" });
      process.exit(1);
    } finally {
      Notifier.log("[DEBUG] Завершение shutdowns.");
    }
  }
}

// Глобальная обработка ошибок
process.on("unhandledRejection", (reason) => {
  Notifier.error(reason, { module: "global unhandledRejection" });
  Notifier.error("[ERROR] Необработанное отклонение.");
});
process.on("uncaughtException", (error) => {
  Notifier.error(error, { module: "global uncaughtException" });
  Notifier.error("[ERROR] Необработанное исключение.");
  // Возможный вариант: завершить процесс, если ошибка критическая
  // process.exit(1);
});

module.exports = App;
