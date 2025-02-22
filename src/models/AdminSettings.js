const mongoose = require("mongoose");

const adminSettingsSchema = new mongoose.Schema({
  _id: { type: String, default: "singleton" },
  alertsEnabled: { type: Boolean, default: true }
});

const AdminSettingsModel = mongoose.model("AdminSettings", adminSettingsSchema);

module.exports = AdminSettingsModel;
