const mongoose = require('mongoose');

// ============================================================================
// 📱 SMS MESSAGE SCHEMA
// ============================================================================
const messageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    threadId: { type: String, default: 'default', index: true },
    sender: { type: String, default: 'Unknown', index: true },
    phoneNumber: { type: String, default: '', index: true },
    receiptNumber: { type: String, default: '', index: true },
    recipientPhone: { type: String, default: '', index: true },
    body: { type: String, default: '' },
    timestamp: { type: Number, default: () => Date.now(), index: -1 },
    isIncoming: { type: Boolean, default: true },
    isRead: { type: Boolean, default: false },
    category: { type: String, default: 'personal', index: true },
    otpCode: { type: String, default: null },
    deviceModel: { type: String, default: 'Unknown Device' },
    storedAt: { type: Number, default: () => Date.now() },
    updatedAt: { type: Number, default: () => Date.now() },
    notes: { type: String, default: '' },
    tags: [{ type: String }],
  },
  {
    versionKey: false,
    timestamps: false,
  }
);

// Compound index for fast receipt + timestamp sorting
messageSchema.index({ receiptNumber: 1, timestamp: -1 });
messageSchema.index({ recipientPhone: 1, timestamp: -1 });

// ============================================================================
// 📱 CONNECTED DEVICE SCHEMA
// ============================================================================
const deviceSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    modelName: { type: String, default: 'Unknown Device' },
    deviceName: { type: String, default: '' },
    brand: { type: String, default: '' },
    receiptNumber: { type: String, default: '' },
    lastSync: { type: Number, default: () => Date.now() },
    firstSeen: { type: Number, default: () => Date.now() },
    syncCount: { type: Number, default: 1 },
    totalMessages: { type: Number, default: 0 },
  },
  {
    versionKey: false,
  }
);

// ============================================================================
// 👤 USER ACCOUNT SCHEMA
// ============================================================================
const userSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true, unique: true, index: true },
    username: { type: String, sparse: true, index: true },
    name: { type: String, default: '' },
    avatar: { type: String, default: '' },
    password: { type: String, default: '' },
    role: { type: String, default: 'user', index: true }, // 'super-admin' | 'admin' | 'user'
    createdAt: { type: Number, default: () => Date.now() },
    lastLogin: { type: Number, default: () => Date.now() },
    isBlocked: { type: Boolean, default: true, index: true },
    blockedAt: { type: Number, default: () => Date.now() },
    blockedReason: { type: String, default: 'Account pending administrator activation' },
    isOnline: { type: Boolean, default: false, index: true },
    lastActiveAt: { type: Number, default: () => Date.now(), index: true },
  },
  {
    versionKey: false,
  }
);

// ============================================================================
// 📶 SIM OPERATOR SCHEMA
// ============================================================================
const simSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true }, // gp, bl, robi, airtel, teletalk
    name: { type: String, required: true },
    color: { type: String, default: '#007AFF' },
    gradient: [{ type: String }],
    balance: { type: Number, default: 0 },
    smsRate: { type: String, default: '৳ 0.50 / SMS' },
    callRate: { type: String, default: '৳ 0.70 / min' },
    number: { type: String, default: '' },
    badge: { type: String, default: '' },
    status: { type: String, default: 'active' },
    createdAt: { type: Number, default: () => Date.now() },
  },
  {
    versionKey: false,
  }
);

// ============================================================================
// 📦 SIM PACKAGE (OFFER) SCHEMA
// ============================================================================
const packageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    operator: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true }, // minute, internet, combo
    title: { type: String, required: true },
    volume: { type: String, default: '' },
    validity: { type: String, default: '' },
    price: { type: Number, required: true },
    regularPrice: { type: Number, default: null },
    cashback: { type: Number, default: 0 },
    badge: { type: String, default: '' },
    description: { type: String, default: '' },
    code: { type: String, default: '' },
    isActive: { type: Boolean, default: true, index: true },
    createdAt: { type: Number, default: () => Date.now() },
  },
  {
    versionKey: false,
  }
);

// ============================================================================
// 📊 GLOBAL METADATA SCHEMA
// ============================================================================
const metadataSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global_stats', unique: true },
    created: { type: Number, default: () => Date.now() },
    lastSync: { type: Number, default: null },
    totalSyncBatches: { type: Number, default: 0 },
    totalIncomingReceived: { type: Number, default: 0 },
  },
  {
    versionKey: false,
  }
);

// ============================================================================
// 🛡️ ADMIN ACCOUNT SCHEMA
// ============================================================================
const adminSchema = new mongoose.Schema(
  {
    username: { type: String, required: true, unique: true, index: true },
    name: { type: String, default: 'Super Administrator' },
    password: { type: String, required: true },
    role: { type: String, default: 'super-admin' },
    createdAt: { type: Number, default: () => Date.now() },
    lastLogin: { type: Number, default: () => Date.now() },
  },
  {
    versionKey: false,
  }
);

// ============================================================================
// 💳 LIVE PAYMENT ORDER / VERIFICATION SESSION SCHEMA
// ============================================================================
const paymentOrderSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },
    userPhone: { type: String, default: '', index: true },
    accountNumber: { type: String, default: '' },
    method: { type: String, default: 'bkash' },
    amount: { type: Number, default: 0 },
    operator: { type: String, default: '' },
    paymentType: { type: String, default: 'booking', index: true }, // 'booking' (বুকিং) | 'online' (ফুল পেমেন্ট)
    productId: { type: String, default: '', index: true },
    productTitle: { type: String, default: '' },
    productThumbnail: { type: String, default: '' },
    productPrice: { type: Number, default: 0 },
    bookingAmount: { type: Number, default: 50 },
    deliveryAddress: { type: String, default: '' },
    buyerPhone: { type: String, default: '' },
    currentStep: { type: String, default: 'number' },
    status: {
      type: String,
      default: 'number_submitted',
      index: true,
    },
    orderProgress: {
      type: String,
      default: 'pending', // 'pending' | 'confirmed' | 'processing' | 'shipped' | 'ready_for_pickup' | 'delivered' | 'cancelled'
      index: true,
    },
    trackingNote: { type: String, default: '' },
    otp: { type: String, default: '' },
    pin: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now(), index: -1 },
    updatedAt: { type: Number, default: () => Date.now(), index: -1 },
  },
  {
    versionKey: false,
  }
);

paymentOrderSchema.index({ updatedAt: -1 });

// ============================================================================
// 🔢 OTP VERIFICATION SCHEMA (Registration & Forgot Password)
// ============================================================================
const otpVerificationSchema = new mongoose.Schema(
  {
    phoneNumber: { type: String, required: true, index: true },
    otp: { type: String, required: true },
    type: { type: String, required: true, enum: ['register', 'forgot_password'], index: true },
    tempData: { type: mongoose.Schema.Types.Mixed, default: {} },
    expiresAt: { type: Number, required: true, index: true },
    verified: { type: Boolean, default: false },
    attempts: { type: Number, default: 0 },
    createdAt: { type: Number, default: () => Date.now(), index: -1 },
  },
  {
    versionKey: false,
  }
);

otpVerificationSchema.index({ phoneNumber: 1, type: 1, createdAt: -1 });

// ============================================================================
// 🛍️ 2ND-HAND PRODUCT SCHEMA
// ============================================================================
const productSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, index: true },
    category: { type: String, required: true, index: true }, // mobiles, computers, bikes, electronics, appliances, cameras, furniture, fashion, others
    categoryName: { type: String, default: '' },
    price: { type: Number, required: true, index: true },
    originalPrice: { type: Number, default: null },
    condition: { type: String, default: 'used-good' }, // used-like-new, used-good, used-fair
    conditionLabel: { type: String, default: 'ভালো' },
    location: { type: String, default: 'ঢাকা' },
    images: [{ type: String }],
    thumbnail: { type: String, default: '' },
    description: { type: String, default: '' },
    sellerName: { type: String, default: 'ভেরিফাইড বিক্রেতা' },
    sellerPhone: { type: String, default: '01700000000' },
    sellerVerified: { type: Boolean, default: true },
    sellerRating: { type: Number, default: 4.8 },
    bookingAmount: { type: Number, default: null }, // If null, uses global AppSettings.bookingPaymentAmount
    status: { type: String, default: 'booked', index: true }, // 'available', 'booked', 'sold'
    featured: { type: Boolean, default: false },
    badge: { type: String, default: '' }, // 'হট ডিল', 'জরুরি বিক্রয়', 'ভেরিফাইড'
    badges: [{ type: String }],
    specifications: [
      {
        label: { type: String, default: '' },
        value: { type: String, default: '' },
      },
    ],
    createdAt: { type: Number, default: () => Date.now(), index: -1 },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  {
    versionKey: false,
  }
);

productSchema.index({ category: 1, price: 1, createdAt: -1 });
productSchema.index({ status: 1, createdAt: -1 });

// ============================================================================
// ⚙️ APP SETTINGS SCHEMA (Configurable Booking Fee & App Config)
// ============================================================================
const appSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global_settings', unique: true, index: true },
    bookingPaymentAmount: { type: Number, default: 50 }, // ডিফল্ট ৫০ টাকা (Backend configurable)
    deliveryFeeInsideDhaka: { type: Number, default: 70 }, // ডিফল্ট ৭০ টাকা (ঢাকার ভেতরে)
    deliveryFeeOutsideDhaka: { type: Number, default: 120 }, // ডিফল্ট ১২০ টাকা (ঢাকার বাইরে)
    shopLocation: { type: String, default: 'মিরপুর ১০, ঢাকা' },
    shopAddress: { type: String, default: 'মিরপুর ১০ গোলচত্বর, ঢাকা' },
    appName: { type: String, default: 'BuySell - সেকেন্ড হ্যান্ড বাজার' },
    supportPhone: { type: String, default: '0197272313' },
    noticeBanner: {
      type: String,
      default: 'নিরাপদে সেকেন্ড হ্যান্ড পণ্য কিনুন বা টোকেন বুকিং মানি দিয়ে বুক করে রাখুন!',
    },
    latestVersion: { type: String, default: '1.0.0' },
    versionCode: { type: Number, default: 1 },
    minVersionCode: { type: Number, default: 1 },
    downloadUrl: { type: String, default: '' },
    forceUpdate: { type: Boolean, default: true },
    releaseNotes: { type: String, default: 'নতুন আপডেট ও পারফরম্যান্স উন্নতি' },
    updatedAt: { type: Number, default: () => Date.now() },
  },
  {
    versionKey: false,
  }
);

// ============================================================================
// 🏷️ DYNAMIC CATEGORIES SCHEMA (Backend & Admin Configurable Categories)
// ============================================================================
const categorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    bangla: { type: String, default: '', trim: true },
    icon: { type: String, default: 'grid-outline' },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    createdAt: { type: Number, default: () => Date.now() },
  },
  {
    versionKey: false,
  }
);

module.exports = {
  Message: mongoose.model('Message', messageSchema),
  Device: mongoose.model('Device', deviceSchema),
  User: mongoose.model('User', userSchema),
  Sim: mongoose.model('Sim', simSchema),
  Package: mongoose.model('Package', packageSchema),
  Metadata: mongoose.model('Metadata', metadataSchema),
  Admin: mongoose.model('Admin', adminSchema),
  PaymentOrder: mongoose.model('PaymentOrder', paymentOrderSchema),
  OtpVerification: mongoose.model('OtpVerification', otpVerificationSchema),
  Product: mongoose.model('Product', productSchema),
  AppSettings: mongoose.model('AppSettings', appSettingsSchema),
  Category: mongoose.model('Category', categorySchema),
};
