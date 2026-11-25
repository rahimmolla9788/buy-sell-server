const config = require("../config");

const sendSms = async ({ to, message }) => {
  if (!to || !message) {
    throw new Error("'to' and 'message' are required to send an SMS");
  }

  const apiKey = config.smsApiKey?.trim();
  const senderId = config.smsSenderId?.trim();
  if (!apiKey || !senderId) {
    throw new Error("SMS Orbis API key and sender ID must be configured");
  }

  const params = new URLSearchParams({
    ApiKey: apiKey,
    SenderID: senderId,
    number: String(to),
    sms: String(message),
  });
  const response = await fetch(`https://portal.smsorbis.com/api/sendSMS?${params}`, {
    method: "GET",
  });

  return response;
};

module.exports = { sendSms };
