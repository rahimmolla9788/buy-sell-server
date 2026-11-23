const twilio = require('twilio');

/**
 * Format phone numbers to E.164 for Twilio SMS
 * E.g. "01712345678" -> "+8801712345678"
 * E.g. "8801712345678" -> "+8801712345678"
 * E.g. "+8801712345678" -> "+8801712345678"
 */
function formatE164(phone) {
  if (!phone) return '';
  const str = String(phone).trim();
  const digits = str.replace(/\D/g, '');
  if (digits.startsWith('880') && digits.length === 13) {
    return `+${digits}`;
  }
  if (digits.startsWith('01') && digits.length === 11) {
    return `+88${digits}`;
  }
  if (digits.length === 10 && digits.startsWith('1')) {
    return `+880${digits}`;
  }
  if (str.startsWith('+')) {
    return str;
  }
  return `+${digits}`;
}

class TwilioService {
  constructor() {
    this._client = null;
  }

  getClient() {
    const accountSid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
    const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();

    if (!accountSid || !authToken || accountSid.includes('your_twilio') || authToken.includes('your_twilio')) {
      return null;
    }

    if (!this._client) {
      try {
        this._client = twilio(accountSid, authToken);
      } catch (err) {
        console.error('[Twilio] Initialization error:', err.message);
        return null;
      }
    }
    return this._client;
  }

  /**
   * Send OTP SMS via Twilio
   * @param {string} phoneNumber 
   * @param {string} otp 
   * @param {'register' | 'forgot_password'} type 
   * @returns {Promise<{ success: boolean, sid?: string, mocked?: boolean, error?: string, devOtp?: string }>}
   */
  async sendOtpSms(phoneNumber, otp, type = 'register') {
    const formattedTo = formatE164(phoneNumber);
    const purposeText = type === 'register' ? 'অ্যাকাউন্ট রেজিস্ট্রেশন' : 'পাসওয়ার্ড রিসেট';
    const messageBody = `[Easy Recharge] আপনার ${purposeText} ভেরিফিকেশন কোড (OTP) হলো: ${otp}। এটি ৫ মিনিট কার্যকর থাকবে। গোপন রাখুন।`;

    const client = this.getClient();
    const fromNumber = (process.env.TWILIO_PHONE_NUMBER || '').trim();

    if (client && fromNumber && !fromNumber.includes('your_twilio')) {
      try {
        console.log(`[Twilio SMS] Sending ${type} OTP to ${formattedTo}...`);
        const msg = await client.messages.create({
          body: messageBody,
          from: fromNumber,
          to: formattedTo,
        });

        // Twilio queues immediately, then marks failed within 1.2s if account limit / Error 30454
        await new Promise((r) => setTimeout(r, 1200));
        let fetched = msg;
        try {
          fetched = await client.messages(msg.sid).fetch();
        } catch {}

        if (fetched.status === 'failed' || fetched.errorCode) {
          console.warn(`[Twilio SMS] Message ${msg.sid} failed with errorCode: ${fetched.errorCode}`);
          return {
            success: true,
            mocked: true,
            devOtp: otp,
            warning: `Twilio delivery failed (Error ${fetched.errorCode}). Account message limit exceeded.`,
          };
        }

        console.log(`[Twilio SMS] SMS delivered/queued successfully! SID: ${msg.sid}, Status: ${fetched.status}`);
        return { success: true, sid: msg.sid };
      } catch (err) {
        console.error(`[Twilio SMS] Failed to send SMS to ${formattedTo}:`, err.message);
        console.warn(`\n======================================================`);
        console.warn(`[Twilio SMS FALLBACK] Delivery failed via Twilio: ${err.message}`);
        console.warn(`Recipient: ${formattedTo} (${phoneNumber})`);
        console.warn(`OTP Code:  ${otp} (Type: ${type})`);
        console.warn(`======================================================\n`);
        return {
          success: true,
          mocked: true,
          devOtp: otp,
          warning: `Twilio delivery failed: ${err.message}. Using development fallback.`,
        };
      }
    } else {
      console.warn(`\n======================================================`);
      console.warn(`[Twilio SMS DEV MODE] Twilio credentials not set in .env`);
      console.warn(`Recipient: ${formattedTo} (${phoneNumber})`);
      console.warn(`Purpose:   ${purposeText}`);
      console.warn(`OTP Code:  ${otp}`);
      console.warn(`Note: Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER in .env`);
      console.warn(`======================================================\n`);
      return {
        success: true,
        mocked: true,
        devOtp: otp,
        message: 'Twilio credentials not configured. OTP printed to server log.',
      };
    }
  }
}

module.exports = new TwilioService();
