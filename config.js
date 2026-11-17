require("dotenv").config();

const config = {
  port: process.env.PORT || 5000,
  smsUser: process.env.SMS_USER || "rahimmolla",
  smsKey: process.env.SMS_KEY || process.env.SMS_API_KEY || "998b3558c215a19f5a5fd15a5c9f55b2",
  smsSenderId: process.env.SMS_SENDER_ID || "",
  mongoUri: process.env.MONGODB_URI || "",
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
  telegramAdminId: process.env.ADMIN_CHAT_ID || "",
};

module.exports = config;
