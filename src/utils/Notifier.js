const { Markup } = require("telegraf");

class Notifier {
  static lastTelegramLogTime = 0;
  static TELEGRAM_LOG_INTERVAL = 2000; // 2 секунды
  static lastError = "";
  static savedErrors = [];
  static MAX_SAVED_ERRORS = 100;
  static originalConsole = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };

  // Эти поля будут назначены после инициализации бота
  static adminBot = null;
  static ADMIN_TELEGRAM = null;

  static async sendTelegramLog(prefix, message, extraOptions = {}) {
    const now = Date.now();
    if (now - Notifier.lastTelegramLogTime < Notifier.TELEGRAM_LOG_INTERVAL)
      return;
    Notifier.lastTelegramLogTime = now;
    if (
      typeof Notifier.adminBot?.telegram?.sendMessage === "function"
    ) {
      try {
        await Notifier.adminBot.telegram.sendMessage(
          Notifier.ADMIN_TELEGRAM,
          `[${prefix}] ${message}`,
          extraOptions,
        );
      } catch (err) {
        Notifier.originalConsole.error(
          `[ERROR] Ошибка отправки ${prefix} лога:`,
          err,
        );
      }
    }
  }

  static log(...args) {
    Notifier.originalConsole.log(...args);
    Notifier.sendTelegramLog("LOG", args.join(" "));
  }

  static warn(...args) {
    Notifier.originalConsole.warn(...args);
    Notifier.sendTelegramLog("WARN", args.join(" "));
  }

  static async error(...args) {
    Notifier.originalConsole.error(...args);
    const errorMsg = args
      .map((arg) => (arg instanceof Error ? arg.stack : arg))
      .join(" ");
    const timestamp = new Date().toISOString();
    const errorText = `[${timestamp}] Ошибка: ${errorMsg}`;
    Notifier.lastError = errorText;
    Notifier.savedErrors.push(errorText);
    if (Notifier.savedErrors.length > Notifier.MAX_SAVED_ERRORS) {
      Notifier.savedErrors.shift();
    }
    const inlineKeyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback("Игнорировать", "ignore_error"),
        Markup.button.callback("Перезапустить", "restart_app"),
      ],
      [
        Markup.button.callback("Детали", "error_details"),
        Markup.button.callback("Сохранить ошибку", "save_error"),
      ],
      [
        Markup.button.callback("Отключить оповещения", "toggle_alerts"),
        Markup.button.callback("Диагностика", "run_diagnostics"),
      ],
      [Markup.button.callback("Остановить приложение", "shutdown_app")],
    ]).reply_markup;
    await Notifier.sendTelegramLog("ERROR", errorText, {
      reply_markup: inlineKeyboard,
    });
  }

  static overrideConsole() {
    console.log = Notifier.log;
    console.warn = Notifier.warn;
    console.error = (...args) => {
      Notifier.error(...args);
    };
    Notifier.originalConsole.log("[DEBUG] Переопределение console завершено.");
  }
}

Notifier.overrideConsole();

module.exports = Notifier;
