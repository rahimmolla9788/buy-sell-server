require("dotenv").config();

const config = {
  port: process.env.PORT || 5000,
  smsApiKey: process.env.SMS_ORBIS_API_KEY || process.env.SMS_API_KEY || "",
  smsSenderId: process.env.SMS_SENDER_ID || "",
  mongoUri: process.env.MONGODB_URI || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramAdminId: process.env.ADMIN_CHAT_ID || "",
};

module.exports = config;
