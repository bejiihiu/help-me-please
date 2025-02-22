const mongoose = require("mongoose");
const Notifier = require("../utils/Notifier");

class Database {
  static async connect() {
    try {
      await mongoose.connect(process.env.MONGO_URI);
      Notifier.log("[INFO] ✅ Подключено к MongoDB");
    } catch (error) {
      await Notifier.error(error, { module: "Database.connect" });
      throw error;
    }
  }
}

module.exports = Database;
