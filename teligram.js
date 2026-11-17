require("dotenv").config();
const { Telegraf } = require("telegraf");

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8761493978:AAH94Rer5k9zAAc3arZY1i2dun-_gOaE3WY';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || '7847132943';

const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

async function notify(text) {
    const message = typeof text === 'string' ? text : JSON.stringify(text, null, 2);

    try {
        if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
            console.warn("Notification skipped: Telegram credentials missing");
            return { success: false, reason: 'missing_credentials' };
        }

        const res = await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            message
        );

        console.log("Order notification sent to Telegram! Message ID:", res?.message_id);
        return { success: true, messageId: res?.message_id };
    } catch (error) {
        console.error("Notification failed:", error.message);
        throw error;
    }
}

module.exports = { notify, bot };