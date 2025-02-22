const dotenv = require("dotenv");
const crypto = require("crypto");

dotenv.config();
console.info("[INFO] Переменные окружения загружены.");

const requiredEnvVars = [
  "GEMINI_KEY",
  "MONGO_URI",
  "BOT_TOKEN",
  "WEBHOOK_URL",
  "TELEGRAM_CHANNEL_ID",
  "ADMIN_TELEGRAM",
];
let missingEnv = false;
requiredEnvVars.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(
      `[ERROR] ❌ Отсутствует обязательная переменная окружения: ${varName}`,
    );
    missingEnv = true;
  }
});
if (missingEnv) {
  console.error("[ERROR] Проверьте переменные окружения. Завершаем работу.");
  process.exit(1);
}

if (!process.env.WEBHOOK_URL.endsWith("/")) {
  process.env.WEBHOOK_URL += "/";
  console.debug("[DEBUG] Добавлен завершающий слэш к WEBHOOK_URL.");
}

const webhookSecret =
  process.env.WEBHOOK_SECRET ||
  crypto
    .createHash("sha256")
    .update(process.env.BOT_TOKEN)
    .digest("hex")
    .slice(0, 20);
const webhookPath = `/bot/${webhookSecret}`;

module.exports = {
  webhookPath,
  ADMIN_TELEGRAM: process.env.ADMIN_TELEGRAM,
  env: process.env,
};
