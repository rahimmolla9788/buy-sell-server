const config = require("../config");

/**
 * 📲 Send SMS via sendmysms.net (https://sendmysms.net/api.php)
 * 
 * Documentation Parameters:
 *   - user: API Username (e.g. 'rahimmolla')
 *   - key: API Key (e.g. '998b3558c215a19f5a5fd15a5c9f55b2')
 *   - to: Recipient's phone number (e.g. '017xxxxxxxx')
 *   - msg: SMS Message Text
 * 
 * Success Response:
 *   { "status": "OK", "response": "The SMS has been sent successfully" }
 */
const sendSms = async ({ to, message }) => {
  try {
    if (!to || !message) {
      console.warn("[SendMySMS] 'to' and 'message' are required");
      return { ok: false, error: "'to' and 'message' are required" };
    }

    const user = config?.smsUser || process.env.SMS_USER || "rahimmolla";
    const key = config?.smsKey || process.env.SMS_KEY || "998b3558c215a19f5a5fd15a5c9f55b2";

    if (!user || !key) {
      console.warn("[SendMySMS] Missing user or key in configuration");
      return { ok: false, error: "Missing SMS credentials (user or key)" };
    }

    // Format recipient phone number to standard 11 digits (01XXXXXXXXX)
    let cleanTo = String(to).replace(/\D/g, "");
    if (cleanTo.startsWith("880") && cleanTo.length === 13) {
      cleanTo = cleanTo.slice(2);
    } else if (cleanTo.length === 10 && cleanTo.startsWith("1")) {
      cleanTo = "0" + cleanTo;
    }

    const params = new URLSearchParams({
      user,
      key,
      to: cleanTo,
      msg: message,
    });

    const url = `https://sendmysms.net/api.php?${params.toString()}`;
    console.log(`[SendMySMS] Sending SMS to ${cleanTo}...`);

    const response = await fetch(url, {
      method: "GET",
    });

    const responseText = await response.text().catch(() => "");
    let responseData = null;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = { raw: responseText };
    }

    console.log(`[SendMySMS] Response (HTTP ${response.status}):`, responseData);

    const isSuccess = response.ok && (responseData?.status === "OK" || responseData?.status === "SUCCESS");

    return {
      ok: isSuccess,
      status: response.status,
      data: responseData,
      rawResponse: response,
      error: isSuccess ? null : (responseData?.response || "SMS sending failed"),
    };
  } catch (error) {
    console.error("[SendMySMS Error]:", error.message || error);
    return { ok: false, error: error.message || error };
  }
};

module.exports = { sendSms };
