const { Telegraf } = require("telegraf");
const { webhookPath, ADMIN_TELEGRAM, env } = require("../config");
const Notifier = require("../utils/Notifier");
const mongoose = require("mongoose");

// Простая функция проверки администратора
const isAdmin = (ctx) => {
  if (!ctx.from || String(ctx.from.id) !== String(ADMIN_TELEGRAM)) {
    ctx.answerCbQuery("Нет доступа").catch(() => {});
    return false;
  }
  return true;
};

function setupBot(appInstance) {
  const bot = new Telegraf(env.BOT_TOKEN);
  Notifier.adminBot = bot;
  Notifier.ADMIN_TELEGRAM = ADMIN_TELEGRAM;

  // Устанавливаем webhook
  const webhookUrl = `${env.WEBHOOK_URL.slice(0, -1)}${webhookPath}`;
  bot.telegram
    .setWebhook(webhookUrl)
    .then(() =>
      Notifier.log(`[INFO] Webhook установлен по адресу: ${webhookUrl}`),
    )
    .catch((err) => Notifier.error(err, { module: "bot.setup" }));

  // Команда помощи
  bot.command("help", async (ctx) => {
    await ctx.reply(
      "Привет! Я бот для цитат.\n\n" +
        "Просто отправь мне сообщение – я опубликую его в канале.\n" +
        "Если нужны дополнительные функции или помощь, обратись к администратору.",
    );
  });

  // Обработка inline-действий администратора
  bot.on("callback_query", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const action = ctx.callbackQuery.data;
    switch (action) {
      case "ignore_error":
        await ctx.answerCbQuery("Ошибка проигнорирована");
        Notifier.log("[INFO] Админ проигнорировал ошибку.");
        break;
      case "restart_app":
        await ctx.answerCbQuery("Перезапуск приложения...");
        Notifier.log("[INFO] Запрошен перезапуск приложения администратором.");
        appInstance.restart();
        break;
      case "error_details":
        await ctx.answerCbQuery("Детали ошибки отправлены");
        await ctx.reply(Notifier.lastError || "Нет доступных деталей ошибки.");
        Notifier.log("[DEBUG] Запрошены детали ошибки.");
        break;
      case "save_error":
        if (Notifier.lastError) {
          await ctx.answerCbQuery("Ошибка сохранена");
          await ctx.reply(`Сохранено ошибок: ${Notifier.savedErrors.length}`);
          Notifier.log("[INFO] Ошибка сохранена администратором.");
        } else {
          await ctx.answerCbQuery("Нет ошибки для сохранения");
        }
        break;
      case "toggle_alerts": {
        // Пример простого переключения оповещений через модель
        const AdminSettingsModel = require("../models/AdminSettings");
        let settings = await AdminSettingsModel.findById("singleton");
        if (!settings) {
          settings = new AdminSettingsModel({
            _id: "singleton",
            alertsEnabled: true,
          });
        }
        settings.alertsEnabled = !settings.alertsEnabled;
        await settings.save();
        await ctx.answerCbQuery(
          `Оповещения ${settings.alertsEnabled ? "включены" : "отключены"}`,
        );
        Notifier.log("[INFO] Переключение оповещений.");
        break;
      }
      case "run_diagnostics": {
        const uptime = process.uptime();
        const memoryUsage = process.memoryUsage();
        const mongoState = mongoose.connection.readyState;
        const diag = `Диагностика:
Уptime: ${Math.round(uptime)} секунд
MongoDB: ${mongoState} (0 = отключено, 1 = подключено)
Memory: ${JSON.stringify(memoryUsage, null, 2)}`;
        await ctx.answerCbQuery("Диагностика выполнена");
        await ctx.reply(diag);
        Notifier.log("[INFO] Диагностика выполнена.");
        break;
      }
      case "shutdown_app":
        await ctx.answerCbQuery("Остановка приложения...");
        await ctx.reply(
          "Приложение будет остановлено по запросу администратора.",
        );
        Notifier.warn("[WARN] Запрошена остановка приложения администратором.");
        appInstance.shutdown();
        break;
      default:
        await ctx.answerCbQuery("Неизвестное действие");
        break;
    }
  });

  // Обработка текстовых сообщений от пользователей
  bot.on("text", async (ctx) => {
    if (!ctx.message || !ctx.message.text) return;
    if (ctx.message.text.startsWith("/")) return;
    Notifier.log(
      "[INFO] Получено сообщение от пользователя:",
      ctx.message.text,
    );
    if (ctx.chat.type === "private") {
      let text = ctx.message.text;
      if (ctx.from && ctx.from.username) {
        text += `\n\n@${ctx.from.username}`;
      }
      try {
        await bot.telegram.sendMessage(env.TELEGRAM_CHANNEL_ID, text);
        await ctx.reply("Спасибо! Ваша цитата отправлена в канал.");
        Notifier.log("[INFO] Цитата от пользователя отправлена в канал.");
      } catch (error) {
        await ctx.reply("Упс, произошла ошибка. Попробуйте позже.");
        await Notifier.error(error, { module: "UserFeedback" });
      }
    }
  });

  bot.catch((err, ctx) => {
    Notifier.error(err, { module: "bot", ctx });
  });

  return bot;
}

module.exports = setupBot;
