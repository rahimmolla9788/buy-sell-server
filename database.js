const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Message, Device, User, Sim, Package, Metadata, Admin, PaymentOrder, OtpVerification, Product, AppSettings } = require('./models');
const config = require('./config');
const { sendSms } = require('./utils/sms');
const twilioService = require('./twilio-service');

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'sms_database.json');

function cleanDigits(str) {
  if (!str) return '';
  return String(str).replace(/\D/g, '');
}

function normalizePhone(str) {
  if (!str) return '';
  const trimmed = String(str).trim();
  if (trimmed.toLowerCase() === 'super-admin') return 'super-admin';
  const digits = cleanDigits(trimmed);
  if (!digits) return trimmed;
  // Canonicalize Bangladeshi mobile numbers to standard 11 digits (01XXXXXXXXX)
  if (digits.startsWith('880') && digits.length === 13) {
    return '0' + digits.slice(3);
  }
  if (digits.length === 10 && digits.startsWith('1')) {
    return '0' + digits;
  }
  if (digits.length === 11 && digits.startsWith('01')) {
    return digits;
  }
  return digits;
}

/**
 * Robust phone matcher that handles +880, 880, and 0 prefixes
 * e.g. "0197272313" matches "+880197272313", "880197272313", "0197272313"
 */
function matchPhone(stored, query) {
  if (!stored || !query) return false;
  const sDigits = cleanDigits(stored);
  const qDigits = cleanDigits(query);
  if (!sDigits || !qDigits) return false;
  if (sDigits === qDigits) return true;

  const stripPrefix = (d) => {
    if (d.startsWith('880')) return '0' + d.slice(3);
    return d;
  };

  const sNorm = stripPrefix(sDigits);
  const qNorm = stripPrefix(qDigits);
  if (sNorm === qNorm) return true;

  // Compare core digits without leading 880 or 0
  const sCore = sDigits.replace(/^880|^0/, '');
  const qCore = qDigits.replace(/^880|^0/, '');
  if (sCore && qCore && sCore === qCore) return true;

  return sDigits.includes(qDigits) || qDigits.includes(sDigits);
}

/**
 * Build phone search regex for MongoDB queries
 */
function buildPhoneQuery(query) {
  const digits = cleanDigits(query);
  if (!digits) return null;
  const core = digits.replace(/^880|^0/, '');
  const pattern = core && core.length >= 6 ? core : digits;
  return new RegExp(pattern, 'i');
}

class Database {
  constructor() {
    this._cachedMessageCount = 0;
    this.isConnected = false;
    this._paymentSessions = new Map();
  }

  get messages() {
    return {
      size: this._cachedMessageCount,
    };
  }

  async connect(uri) {
    if (mongoose.connection.readyState === 1) {
      this.isConnected = true;
      return mongoose.connection;
    }

    if (this._connectingPromise) {
      return await this._connectingPromise;
    }

    const mongoUri =
      uri ||
      process.env.MONGODB_URI ||
      'mongodb+srv://mdsayel111_db_user:Wh6mrvcZTK9xSacX@cluster0.tylxeag.mongodb.net/recharge_app?retryWrites=true&w=majority';

    this._connectingPromise = (async () => {
      try {
        console.log('[MongoDB] Connecting to MongoDB Atlas...');
        await mongoose.connect(mongoUri, {
          serverSelectionTimeoutMS: 15000,
        });
        this.isConnected = true;
        console.log(`[MongoDB] Connected to MongoDB Atlas! Database: ${mongoose.connection.name}`);

        // Seed default SIMs and Packages if still empty
        await this.ensureSeeds();

        this._cachedMessageCount = await Message.countDocuments();
        console.log(`[MongoDB] Active message count in Atlas: ${this._cachedMessageCount}`);
        return mongoose.connection;
      } catch (err) {
        console.error('[MongoDB] Connection error:', err.message);
        this.isConnected = false;
        throw err;
      } finally {
        this._connectingPromise = null;
      }
    })();

    return await this._connectingPromise;
  }

  /**
   * Migrate existing local JSON database into MongoDB Atlas if MongoDB is empty
   */
  async migrateFromLocalIfEmpty() {
    try {
      const count = await Message.countDocuments();
      if (count > 0) {
        console.log(`[MongoDB] Atlas already has ${count} messages stored. Skipping local import.`);
        this._cachedMessageCount = count;
        return;
      }

      if (fs.existsSync(DB_FILE)) {
        console.log(`[MongoDB Migration] Local backup found at ${DB_FILE}. Migrating to MongoDB Atlas...`);
        const raw = fs.readFileSync(DB_FILE, 'utf8');
        const parsed = JSON.parse(raw);

        // 1. Migrate Messages
        if (Array.isArray(parsed.messages) && parsed.messages.length > 0) {
          const ops = parsed.messages
            .filter((m) => m && m.id)
            .map((m) => {
              const rNum = normalizePhone(m.receiptNumber || m.recipientPhone || '');
              return {
                updateOne: {
                  filter: { id: m.id },
                  update: {
                    $set: {
                      id: m.id,
                      threadId: m.threadId || 'default',
                      sender: m.sender || 'Unknown',
                      phoneNumber: m.phoneNumber || m.sender || '',
                      receiptNumber: rNum,
                      recipientPhone: rNum,
                      body: m.body || '',
                      timestamp: Number(m.timestamp) || Date.now(),
                      isIncoming: m.isIncoming !== undefined ? Boolean(m.isIncoming) : true,
                      isRead: m.isRead !== undefined ? Boolean(m.isRead) : false,
                      category: m.category || 'personal',
                      otpCode: m.otpCode ? String(m.otpCode) : null,
                      deviceModel: m.deviceModel || 'Unknown Device',
                      storedAt: m.storedAt || Date.now(),
                      updatedAt: m.updatedAt || Date.now(),
                      notes: m.notes || '',
                      tags: Array.isArray(m.tags) ? m.tags : [],
                    },
                  },
                  upsert: true,
                },
              };
            });

          if (ops.length > 0) {
            await Message.bulkWrite(ops);
            console.log(`[MongoDB Migration] Migrated ${ops.length} messages into MongoDB Atlas.`);
          }
        }

        // 2. Migrate Users
        if (Array.isArray(parsed.users) && parsed.users.length > 0) {
          for (const u of parsed.users) {
            if (u && u.phoneNumber) {
              await User.findOneAndUpdate(
                { phoneNumber: normalizePhone(u.phoneNumber) },
                { $set: u },
                { upsert: true }
              );
            }
          }
          console.log(`[MongoDB Migration] Migrated ${parsed.users.length} users into MongoDB.`);
        }

        // 3. Migrate SIMs
        if (Array.isArray(parsed.sims) && parsed.sims.length > 0) {
          for (const sim of parsed.sims) {
            if (sim && sim.id) {
              await Sim.findOneAndUpdate({ id: sim.id }, { $set: sim }, { upsert: true });
            }
          }
          console.log(`[MongoDB Migration] Migrated ${parsed.sims.length} SIM operators.`);
        }

        // 4. Migrate Packages
        if (Array.isArray(parsed.packages) && parsed.packages.length > 0) {
          for (const pkg of parsed.packages) {
            if (pkg && pkg.id) {
              await Package.findOneAndUpdate({ id: pkg.id }, { $set: pkg }, { upsert: true });
            }
          }
          console.log(`[MongoDB Migration] Migrated ${parsed.packages.length} packages.`);
        }

        // 5. Migrate Devices
        if (Array.isArray(parsed.devices) && parsed.devices.length > 0) {
          for (const dev of parsed.devices) {
            const key = dev.modelName || dev.deviceName || 'default';
            await Device.findOneAndUpdate(
              { key },
              { $set: { ...dev, key } },
              { upsert: true }
            );
          }
          console.log(`[MongoDB Migration] Migrated ${parsed.devices.length} devices.`);
        }

        // 6. Migrate Metadata
        if (parsed.metadata) {
          await Metadata.findOneAndUpdate(
            { key: 'global_stats' },
            { $set: { ...parsed.metadata, key: 'global_stats' } },
            { upsert: true }
          );
        }

        this._cachedMessageCount = await Message.countDocuments();
        console.log(`[MongoDB Migration] ✅ All local data successfully migrated to MongoDB Atlas!`);
      }
    } catch (err) {
      console.error('[MongoDB Migration] Error migrating local data:', err.message);
    }
  }

  async ensureSeeds() {
    await this.ensureAdminUser();
    await this.ensureDefaultSettings();
    const prodCount = await Product.countDocuments();
    if (prodCount === 0) {
      await this.seedDefaultProducts();
    }
    const simCount = await Sim.countDocuments();
    if (simCount === 0) {
      await this.seedDefaultSims();
    }
    const pkgCount = await Package.countDocuments();
    if (pkgCount === 0) {
      await this.seedDefaultPackages();
    }
  }

  async ensureDefaultSettings() {
    try {
      const existing = await AppSettings.findOne({ key: 'global_settings' });
      if (!existing) {
        await AppSettings.create({
          key: 'global_settings',
          bookingPaymentAmount: 50, // Default 50 BDT
          appName: 'BuySell - সেকেন্ড হ্যান্ড বাজার',
          supportPhone: '0197272313',
          noticeBanner: 'নিরাপদে সেকেন্ড হ্যান্ড পণ্য কিনুন বা টোকেন বুকিং মানি দিয়ে বুক করে রাখুন!',
          updatedAt: Date.now(),
        });
        console.log('[MongoDB] Created default AppSettings with bookingPaymentAmount = 50 BDT');
      }
    } catch (err) {
      console.warn('[MongoDB] ensureDefaultSettings warning:', err.message);
    }
  }

  async ensureAdminUser() {
    const adminUsername = 'super-admin';
    const adminPassword = 'super-admin';

    // 1. Ensure in Admin collection
    await Admin.findOneAndUpdate(
      { username: adminUsername },
      {
        $set: {
          username: adminUsername,
          name: 'Super Administrator',
          password: adminPassword,
          role: 'super-admin',
          lastLogin: Date.now(),
        },
        $setOnInsert: { createdAt: Date.now() },
      },
      { upsert: true, new: true }
    );

    // 2. Ensure in User collection (active, unblocked)
    await User.findOneAndUpdate(
      {
        $or: [
          { username: adminUsername },
          { phoneNumber: adminUsername },
        ],
      },
      {
        $set: {
          username: adminUsername,
          phoneNumber: adminUsername,
          name: 'Super Administrator',
          password: adminPassword,
          role: 'super-admin',
          isBlocked: false,
          blockedAt: null,
          blockedReason: '',
        },
        $setOnInsert: { createdAt: Date.now() },
      },
      { upsert: true, new: true }
    );

    console.log(`[Admin] Ensured Super Admin user: username="${adminUsername}", password="${adminPassword}"`);
  }

  async seedDefaultSims() {
    const defaults = [
      {
        id: 'gp',
        name: 'Grameenphone',
        color: '#007AFF',
        gradient: ['#007AFF', '#00C6FF'],
        balance: 145.5,
        smsRate: '৳ 0.50 / SMS',
        callRate: '৳ 0.70 / min',
        number: '01712-345678',
        badge: 'Recommended',
        status: 'active',
        createdAt: Date.now(),
      },
      {
        id: 'bl',
        name: 'Banglalink',
        color: '#FF6B00',
        gradient: ['#FF6B00', '#FF9E00'],
        balance: 82.25,
        smsRate: '৳ 0.45 / SMS',
        callRate: '৳ 0.65 / min',
        number: '01912-345678',
        badge: 'Best Value',
        status: 'active',
        createdAt: Date.now(),
      },
      {
        id: 'robi',
        name: 'Robi',
        color: '#E60000',
        gradient: ['#E60000', '#FF4D4D'],
        balance: 210.0,
        smsRate: '৳ 0.50 / SMS',
        callRate: '৳ 0.68 / min',
        number: '01812-345678',
        badge: 'Popular',
        status: 'active',
        createdAt: Date.now(),
      },
      {
        id: 'airtel',
        name: 'Airtel',
        color: '#D80027',
        gradient: ['#D80027', '#FF334B'],
        balance: 55.75,
        smsRate: '৳ 0.40 / SMS',
        callRate: '৳ 0.60 / min',
        number: '01612-345678',
        badge: 'Youth Choice',
        status: 'active',
        createdAt: Date.now(),
      },
      {
        id: 'teletalk',
        name: 'Teletalk',
        color: '#28A745',
        gradient: ['#28A745', '#5DD879'],
        balance: 315.0,
        smsRate: '৳ 0.35 / SMS',
        callRate: '৳ 0.50 / min',
        number: '01512-345678',
        badge: 'Govt Network',
        status: 'active',
        createdAt: Date.now(),
      },
    ];

    for (const sim of defaults) {
      await Sim.findOneAndUpdate({ id: sim.id }, { $set: sim }, { upsert: true });
    }
    console.log(`[MongoDB] Seeded ${defaults.length} default SIM operators into MongoDB.`);
  }

  async seedDefaultPackages() {
    const defaults = [
      // Grameenphone Offers
      { id: 'gp-min-1', operator: 'gp', category: 'minute', title: '100 Minutes Pack', volume: '100 Mins', validity: '7 Days', price: 68, regularPrice: 75, cashback: 7, badge: 'Hot', description: 'To any local operator', code: '*121*100#', isActive: true, createdAt: Date.now() },
      { id: 'gp-min-2', operator: 'gp', category: 'minute', title: '250 Minutes Pack', volume: '250 Mins', validity: '30 Days', price: 169, regularPrice: 185, cashback: 16, badge: 'Popular', description: 'Any local operator with 30 days validity', code: '*121*250#', isActive: true, createdAt: Date.now() },
      { id: 'gp-net-1', operator: 'gp', category: 'internet', title: '10 GB Regular Pack', volume: '10 GB', validity: '7 Days', price: 149, regularPrice: 169, cashback: 20, badge: 'Fast 4G', description: 'Unrestricted 4G high-speed data', code: '*121*10#', isActive: true, createdAt: Date.now() },
      { id: 'gp-net-2', operator: 'gp', category: 'internet', title: '30 GB Monthly Pack', volume: '30 GB', validity: '30 Days', price: 399, regularPrice: 449, cashback: 50, badge: 'Best Seller', description: 'Valid for 30 days, no daily limit', code: '*121*30#', isActive: true, createdAt: Date.now() },
      { id: 'gp-combo-1', operator: 'gp', category: 'combo', title: 'Super Combo 20GB + 400 Min', volume: '20 GB + 400 Mins', validity: '30 Days', price: 498, regularPrice: 560, cashback: 62, badge: 'Exclusive', description: 'Complete monthly package for calls & internet', code: '*121*498#', isActive: true, createdAt: Date.now() },

      // Banglalink Offers
      { id: 'bl-min-1', operator: 'bl', category: 'minute', title: '120 Minutes Pack', volume: '120 Mins', validity: '7 Days', price: 74, regularPrice: 85, cashback: 11, badge: 'Best Rate', description: 'Any local operator call minutes', code: '*121*74#', isActive: true, createdAt: Date.now() },
      { id: 'bl-net-1', operator: 'bl', category: 'internet', title: '12 GB Weekly Pack', volume: '12 GB', validity: '7 Days', price: 129, regularPrice: 149, cashback: 20, badge: 'Budget', description: 'Fastest 4G internet for social & streaming', code: '*121*129#', isActive: true, createdAt: Date.now() },
      { id: 'bl-combo-1', operator: 'bl', category: 'combo', title: 'Power Pack 25GB + 500 Min', volume: '25 GB + 500 Mins', validity: '30 Days', price: 448, regularPrice: 520, cashback: 72, badge: 'Mega Savings', description: 'All-inclusive monthly power combo', code: '*121*448#', isActive: true, createdAt: Date.now() },

      // Robi Offers
      { id: 'robi-min-1', operator: 'robi', category: 'minute', title: '150 Minutes Pack', volume: '150 Mins', validity: '10 Days', price: 98, regularPrice: 110, cashback: 12, badge: 'Popular', description: 'Talk to any operator with crystal clear HD voice', code: '*123*98#', isActive: true, createdAt: Date.now() },
      { id: 'robi-net-1', operator: 'robi', category: 'internet', title: '15 GB Internet Pack', volume: '15 GB', validity: '7 Days', price: 139, regularPrice: 160, cashback: 21, badge: 'Trending', description: 'Non-stop high speed 4.5G data', code: '*123*139#', isActive: true, createdAt: Date.now() },
      { id: 'robi-combo-1', operator: 'robi', category: 'combo', title: 'Mega Combo 30GB + 450 Min', volume: '30 GB + 450 Mins', validity: '30 Days', price: 479, regularPrice: 550, cashback: 71, badge: 'Best Seller', description: '30GB data + 450 mins to any number', code: '*123*479#', isActive: true, createdAt: Date.now() },
    ];

    for (const pkg of defaults) {
      await Package.findOneAndUpdate({ id: pkg.id }, { $set: pkg }, { upsert: true });
    }
    console.log(`[MongoDB] Seeded ${defaults.length} default packages into MongoDB.`);
  }

  async seedDefaultProducts() {
    const defaults = [
      {
        id: 'prod-iphone-13-pro',
        title: 'iPhone 13 Pro 128GB - Graphite',
        category: 'mobiles',
        categoryName: 'মোবাইল ও গ্যাজেট',
        price: 52000,
        originalPrice: 78000,
        condition: 'used-like-new',
        conditionLabel: 'নতুনের মতো (Like New)',
        location: 'মিরপুর ১০, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1632661674596-df8be070a5c5?auto=format&fit=crop&w=800&q=80',
          'https://images.unsplash.com/photo-1592750475338-74b7b21085ab?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1632661674596-df8be070a5c5?auto=format&fit=crop&w=800&q=80',
        description: 'অফিসিয়াল ফোন। কোনো দাগ বা স্ক্র্যাচ নেই। ব্যাটারি হেলথ ৮৮%। সাথে অরিজিনাল ক্যাবল, বক্স এবং শপের ক্যাশ মেমো পাবেন। সরাসরি দেখে নিতে পারেন।',
        sellerName: 'তানভীর আহমেদ',
        sellerPhone: '01712345678',
        sellerVerified: true,
        sellerRating: 4.9,
        bookingAmount: 50,
        status: 'available',
        featured: true,
        badge: 'হট ডিল',
        specifications: [
          { label: 'র‌্যাম ও স্টোরেজ', value: '6GB RAM, 128GB Storage' },
          { label: 'ব্যাটারি হেলথ', value: '88% Authentic' },
          { label: 'ডিসপ্লে', value: '6.1" Super Retina XDR 120Hz' },
          { label: 'ক্যামেরা', value: 'Triple 12MP with LiDAR' },
        ],
        createdAt: Date.now() - 3600000 * 2,
        updatedAt: Date.now(),
      },
      {
        id: 'prod-samsung-s22-ultra',
        title: 'Samsung Galaxy S22 Ultra 5G (12/256GB)',
        category: 'mobiles',
        categoryName: 'মোবাইল ও গ্যাজেট',
        price: 48500,
        originalPrice: 72000,
        condition: 'used-good',
        conditionLabel: 'ভালো কন্ডিশন (Good)',
        location: 'উত্তরা সেক্টর ৭, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1610945415295-d9bbf067e59c?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1610945415295-d9bbf067e59c?auto=format&fit=crop&w=800&q=80',
        description: 'খুব যত্ন সহকারে ১ বছর ব্যবহার করা হয়েছে। অরিজিনাল এস-পেন সহ আছে। ১০০এক্স জুম ক্যামেরা সম্পূর্ণ নিখুঁত। সাথে ফাস্ট চার্জার দেওয়া হবে।',
        sellerName: 'হাসানুল করিম',
        sellerPhone: '01898765432',
        sellerVerified: true,
        sellerRating: 4.8,
        bookingAmount: 50,
        status: 'available',
        featured: true,
        badge: 'জনপ্রিয়',
        specifications: [
          { label: 'র‌্যাম ও রম', value: '12GB / 256GB' },
          { label: 'প্রসেসর', value: 'Snapdragon 8 Gen 1' },
          { label: 'ডিসপ্লে', value: '6.8" Dynamic AMOLED 2X' },
        ],
        createdAt: Date.now() - 3600000 * 5,
        updatedAt: Date.now(),
      },
      {
        id: 'prod-macbook-air-m1',
        title: 'Apple MacBook Air M1 (8GB / 256GB) Space Gray',
        category: 'computers',
        categoryName: 'ল্যাপটপ ও পিসি',
        price: 64000,
        originalPrice: 89000,
        condition: 'used-like-new',
        conditionLabel: 'নতুনের মতো (Like New)',
        location: 'ধানমন্ডি ২৭, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1611186871348-b1ce696e52c9?auto=format&fit=crop&w=800&q=80',
        description: 'কোডিং এবং গ্রাফিক ডিজাইনের জন্য অসাধারণ ল্যাপটপ। ব্যাটারি সাইকেল কাউন্ট মাত্র ১১২, ব্যাকআপ প্রায় ১২ ঘন্টা। অরিজিনাল ৩০ ওয়াট অ্যাডাপ্টার ও বক্স বিদ্যমান।',
        sellerName: 'রাকিবুল ইসলাম',
        sellerPhone: '01911223344',
        sellerVerified: true,
        sellerRating: 5.0,
        bookingAmount: 50,
        status: 'available',
        featured: true,
        badge: 'ভেরিফাইড',
        specifications: [
          { label: 'চিপসেট', value: 'Apple M1 Chip (8-Core CPU)' },
          { label: 'র‌্যাম / স্টোরেজ', value: '8GB Unified / 256GB SSD' },
          { label: 'ব্যাটারি লাইফ', value: 'Cycle 112 (96% Health)' },
        ],
        createdAt: Date.now() - 3600000 * 8,
        updatedAt: Date.now(),
      },
      {
        id: 'prod-yamaha-fz-v2',
        title: 'Yamaha FZ-S Fi V2 (Double Disc) - 2021',
        category: 'bikes',
        categoryName: 'বাইক ও গাড়ি',
        price: 142000,
        originalPrice: 215000,
        condition: 'used-good',
        conditionLabel: 'ভালো কন্ডিশন (Good)',
        location: 'মোহাম্মদপুর, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1558981403-c5f9899a28bc?auto=format&fit=crop&w=800&q=80',
        description: 'ঢাকা মেট্রো ল সিরিয়াল, ১৮,০০০ কিমি রানিং। প্রতি লিটারে ৪০+ মাইলেজ। ডিজিটাল নাম্বার প্লেট এবং স্মার্ট কার্ড প্রস্তুত। ২ বছরের ট্যাক্স টোকেন আপডেটেড। কোনো এক্সিডেন্ট হিস্ট্রি নেই।',
        sellerName: 'মেহেদী হাসান',
        sellerPhone: '01655443322',
        sellerVerified: true,
        sellerRating: 4.7,
        bookingAmount: 50,
        status: 'available',
        featured: false,
        badge: 'জরুরি বিক্রয়',
        specifications: [
          { label: 'ইঞ্জিন ক্ষমতা', value: '149cc Fuel Injection' },
          { label: 'রানিং', value: '18,200 KM' },
          { label: 'রেজিস্ট্রেশন', value: 'BRTA Mirpur, 2 Years' },
        ],
        createdAt: Date.now() - 3600000 * 12,
        updatedAt: Date.now(),
      },
      {
        id: 'prod-sony-bravia-tv',
        title: 'Sony Bravia 43" 4K HDR Google Smart TV',
        category: 'electronics',
        categoryName: 'ইলেকট্রনিক্স ও টিভি',
        price: 28000,
        originalPrice: 42000,
        condition: 'used-like-new',
        conditionLabel: 'নতুনের মতো (Like New)',
        location: 'বাড্ডা লিংক রোড, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1593784991095-a205069470b6?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1593784991095-a205069470b6?auto=format&fit=crop&w=800&q=80',
        description: '১০০% অরিজিনাল সনি ব্রাভিয়া টিভি। ডলবি অডিও ও ট্রিলুমিনাস ডিসপ্লে। ইউটিউব, নেটফ্লিক্স স্মুথলি চলে। সাথে ভয়েস কন্ট্রোল রিমোট ও ওয়াল মাউন্ট হ্যাঙ্গার দেওয়া হবে।',
        sellerName: 'ফারহান চৌধুরী',
        sellerPhone: '01533221100',
        sellerVerified: true,
        sellerRating: 4.8,
        bookingAmount: 50,
        status: 'available',
        featured: false,
        badge: 'হট ডিল',
        specifications: [
          { label: 'স্ক্রিন সাইজ', value: '43 Inch 4K UHD' },
          { label: 'সাউন্ড', value: 'Dolby Audio 20W' },
          { label: 'ওএস', value: 'Google TV / Android' },
        ],
        createdAt: Date.now() - 3600000 * 16,
        updatedAt: Date.now(),
      },
      {
        id: 'prod-canon-200d',
        title: 'Canon EOS 200D Mark II with 18-55mm IS STM Lens',
        category: 'cameras',
        categoryName: 'ক্যামেরা ও অডিও',
        price: 38000,
        originalPrice: 55000,
        condition: 'used-like-new',
        conditionLabel: 'নতুনের মতো (Like New)',
        location: 'ফার্মগেট, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=800&q=80',
        description: 'শর্টার কাউন্ট মাত্র ৪,৫০০। ভ্লগিং এবং ফটোশ্যুটের জন্য বেস্ট রোটেটিং টাচস্ক্রিন ডিসপ্লে ও 4K ভিডিও রেকর্ডিং সুবিধা। সাথে ৬০ ফ্রেম ভিডিও সাপোর্ট, ব্যাগ ও ৩২জিবি মেমোরি কার্ড।',
        sellerName: 'সাইফুল ইসলাম',
        sellerPhone: '01799887766',
        sellerVerified: true,
        sellerRating: 4.9,
        bookingAmount: 50,
        status: 'available',
        featured: false,
        badge: 'প্রস্তাবিত',
        specifications: [
          { label: 'সেন্সর', value: '24.1MP APS-C CMOS' },
          { label: 'ভিডিও', value: '4K UHD, Dual Pixel AF' },
          { label: 'শর্টার কাউন্ট', value: '4,500 clicks' },
        ],
        createdAt: Date.now() - 3600000 * 20,
        updatedAt: Date.now(),
      },
      {
        id: 'prod-walton-inverter-ac',
        title: 'Walton Inverter 1.5 Ton Split AC (Energy Star)',
        category: 'appliances',
        categoryName: 'গৃহস্থালি সামগ্রী',
        price: 29500,
        originalPrice: 46000,
        condition: 'used-good',
        conditionLabel: 'ভালো কন্ডিশন (Good)',
        location: 'মিরপুর ২, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1614633833026-06204043b27b?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1614633833026-06204043b27b?auto=format&fit=crop&w=800&q=80',
        description: 'ইনভার্টার টেকনোলজি তাই বিদ্যুৎ খরচ ৬০% পর্যন্ত কম। খুব দ্রুত ঘর ঠান্ডা করে। গত বছর মে মাসে কেনা হয়েছিল, এখনো সার্ভিস ওয়ারেন্টি বিদ্যমান। সাথে ১০ ফুট কপার পাইপ পাবেন।',
        sellerName: 'জাকির হোসেন',
        sellerPhone: '01811447788',
        sellerVerified: true,
        sellerRating: 4.6,
        bookingAmount: 50,
        status: 'available',
        featured: false,
        badge: 'বাজেট ফ্রেন্ডলি',
        specifications: [
          { label: 'ক্যাপাসিটি', value: '1.5 Ton (18,000 BTU)' },
          { label: 'কম্প্রেসার', value: 'Dual Inverter Rotary' },
          { label: 'গ্যাস টাইপ', value: 'R32 Eco-Friendly' },
        ],
        createdAt: Date.now() - 3600000 * 24,
        updatedAt: Date.now(),
      },
      {
        id: 'prod-apple-watch-s7',
        title: 'Apple Watch Series 7 (45mm) Midnight Aluminum',
        category: 'fashion',
        categoryName: 'ঘড়ি ও ফ্যাশন',
        price: 21000,
        originalPrice: 35000,
        condition: 'used-like-new',
        conditionLabel: 'নতুনের মতো (Like New)',
        location: 'গুলশান ১, ঢাকা',
        images: [
          'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?auto=format&fit=crop&w=800&q=80',
        ],
        thumbnail: 'https://images.unsplash.com/photo-1579586337278-3befd40fd17a?auto=format&fit=crop&w=800&q=80',
        description: 'অরিজিনাল অ্যাপল ওয়াচ ৭, কোনো ডেন্ট নেই। অলওয়েজ-অন রেটিনা ডিসপ্লে, ইসিজি ও ব্লাড অক্সিজেন সেন্সর একটিভ। সাথে অরিজিনাল ফাস্ট চার্জার ও ২টি এক্সট্রা বেল্ট উপহার।',
        sellerName: 'নাঈম রহমান',
        sellerPhone: '01722334455',
        sellerVerified: true,
        sellerRating: 4.9,
        bookingAmount: 50,
        status: 'available',
        featured: false,
        badge: 'হট ডিল',
        specifications: [
          { label: 'সাইজ', value: '45mm Midnight Case' },
          { label: 'সেন্সর', value: 'ECG, SpO2, Heart Rate' },
          { label: 'ব্যাটারি হেলথ', value: '91%' },
        ],
        createdAt: Date.now() - 3600000 * 28,
        updatedAt: Date.now(),
      },
    ];

    for (const prod of defaults) {
      await Product.findOneAndUpdate({ id: prod.id }, { $set: prod }, { upsert: true });
    }
    console.log(`[MongoDB] Seeded ${defaults.length} default 2nd-hand products into MongoDB.`);
  }

  // ============================================================================
  // 📊 STATS & OVERVIEW
  // ============================================================================
  async getStats() {
    const totalMessages = await Message.countDocuments();
    const bankingCount = await Message.countDocuments({ category: { $in: ['banking', 'transaction'] } });
    const otpCount = await Message.countDocuments({ category: 'otp' });
    const personalCount = await Message.countDocuments({ category: 'personal' });
    const promoCount = await Message.countDocuments({ category: 'promotional' });
    const devicesCount = await Device.countDocuments();
    const userCount = await User.countDocuments();
    const meta = (await Metadata.findOne({ key: 'global_stats' }).lean()) || {};

    return {
      totalMessages,
      totalSyncBatches: meta.totalSyncBatches || 0,
      totalIncomingReceived: meta.totalIncomingReceived || 0,
      lastSync: meta.lastSync || null,
      devicesCount,
      userCount,
      categories: {
        banking: bankingCount,
        otp: otpCount,
        personal: personalCount,
        promotional: promoCount,
        transaction: 0,
      },
    };
  }

  async getTotalMessagesCount() {
    return await Message.countDocuments();
  }

  // ============================================================================
  // 📱 DEVICE MANAGEMENT
  // ============================================================================
  async getDevices() {
    return await Device.find().sort({ lastSync: -1 }).lean();
  }

  async recordDevice(metadata, assignedReceipt = '') {
    if (!metadata) return null;
    const key = metadata.modelName || metadata.deviceName || 'default';
    const now = Date.now();
    const update = {
      modelName: metadata.modelName || 'Unknown Device',
      deviceName: metadata.deviceName || '',
      brand: metadata.brand || '',
      receiptNumber: assignedReceipt || metadata.receiptNumber || '',
      lastSync: now,
    };

    return await Device.findOneAndUpdate(
      { key },
      {
        $set: update,
        $inc: { syncCount: 1 },
        $setOnInsert: { firstSeen: now, totalMessages: 0 },
      },
      { upsert: true, new: true }
    ).lean();
  }

  // ============================================================================
  // 🔢 OTP VERIFICATION & PASSWORD RESET (Twilio Integration)
  // ============================================================================
  async findUserByPhone(phoneNumber) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) return null;
    const phoneRegex = buildPhoneQuery(norm);
    return await User.findOne({
      $or: [
        { phoneNumber: norm },
        ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : []),
      ],
    }).lean();
  }

  async createOtpSession({ phoneNumber, type = 'register', tempData = {} }) {
    const norm = normalizePhone(phoneNumber);
    if (!norm || norm.length < 8) {
      throw new Error('সঠিক মোবাইল নম্বর প্রদান করা আবশ্যক');
    }

    if (!['register', 'forgot_password'].includes(type)) {
      throw new Error('অবৈধ ওটিপি রিকোয়েস্ট টাইপ');
    }

    // Generate random 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const now = Date.now();
    const expiresAt = now + 5 * 60 * 1000; // 5 minutes validity

    // Invalidate previous unverified OTPs for this phone + type
    await OtpVerification.deleteMany({
      phoneNumber: norm,
      type,
      verified: false,
    });

    const session = await OtpVerification.create({
      phoneNumber: norm,
      otp,
      type,
      tempData,
      expiresAt,
      verified: false,
      attempts: 0,
      createdAt: now,
    });

    // Send SMS via sendmysms.net (https://sendmysms.net/api.php)
    const purposeText = type === 'register' ? 'রেজিস্ট্রেশন' : 'পাসওয়ার্ড রিসেট';
    const message = `Topup BD ${purposeText} ভেরিফিকেশন কোড: ${otp}। Your OTP code is: ${otp}`;

    let cleanTo = norm.replace(/\D/g, '');
    if (cleanTo.startsWith('880') && cleanTo.length === 13) {
      cleanTo = cleanTo.slice(2);
    } else if (cleanTo.length === 10 && cleanTo.startsWith('1')) {
      cleanTo = '0' + cleanTo;
    }

    const smsResult = await sendSms({ to: cleanTo, message });

    return {
      success: true,
      phoneNumber: norm,
      otp,
      type,
      expiresAt,
      mocked: !smsResult?.ok,
      devOtp: otp,
      message: 'আপনার নম্বরে ওটিপি পাঠানো হয়েছে',
    };
  }

  async getRecentOtps() {
    try {
      const since = Date.now() - 24 * 60 * 60 * 1000;
      return await OtpVerification.find({ createdAt: { $gte: since } })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean();
    } catch (err) {
      console.error('[DB getRecentOtps Error]:', err.message);
      return [];
    }
  }

  async verifyOtp({ phoneNumber, otp, type }) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('মোবাইল নম্বর দেওয়া আবশ্যক');
    if (!otp || !String(otp).trim()) throw new Error('ওটিপি কোড দেওয়া আবশ্যক');

    const cleanOtp = String(otp).trim();
    const now = Date.now();

    const session = await OtpVerification.findOne({
      phoneNumber: norm,
      type,
      verified: false,
    }).sort({ createdAt: -1 });

    if (!session) {
      throw new Error('কোনো সক্রিয় ওটিপি পাওয়া যায়নি। অনুগ্রহ করে পুনরায় চেষ্টা করুন।');
    }

    if (now > session.expiresAt) {
      throw new Error('ওটিপির মেয়াদ শেষ হয়ে গেছে। অনুগ্রহ করে পুনরায় ওটিপি কোড নিন।');
    }

    if (session.attempts >= 5) {
      throw new Error('আপনি সর্বোচ্চ সংখ্যক ভুল কোড দিয়েছেন। অনুগ্রহ করে পুনরায় ওটিপি কোড পাঠান।');
    }

    if (session.otp !== cleanOtp) {
      session.attempts += 1;
      await session.save();
      const remaining = 5 - session.attempts;
      throw new Error(`ভুল ওটিপি কোড। অনুগ্রহ করে সঠিক কোড দিন। (বাকি চেষ্টা: ${remaining})`);
    }

    session.verified = true;
    await session.save();

    return session;
  }

  async registerWithOtp({ phoneNumber, otp, name, password }) {
    const norm = normalizePhone(phoneNumber);
    // 1. Verify OTP
    await this.verifyOtp({ phoneNumber: norm, otp, type: 'register' });
    // 2. Register user
    return await this.registerUser({ phoneNumber: norm, name, password });
  }

  async resetPasswordWithOtp({ phoneNumber, otp, newPassword }) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('মোবাইল নম্বর দেওয়া আবশ্যক');

    const cleanPass = (newPassword || '').trim();
    if (!cleanPass) {
      throw new Error('নতুন পাসওয়ার্ড প্রদান করা আবশ্যক');
    }
    if (cleanPass.length < 4) {
      throw new Error('পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে');
    }

    // 1. Verify OTP
    await this.verifyOtp({ phoneNumber: norm, otp, type: 'forgot_password' });

    // 2. Find user
    const phoneRegex = buildPhoneQuery(norm);
    const user = await User.findOne({
      $or: [
        { phoneNumber: norm },
        ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : []),
      ],
    });

    if (!user) {
      throw new Error('এই নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি');
    }

    user.password = cleanPass;
    await user.save();

    return {
      success: true,
      phoneNumber: user.phoneNumber,
      name: user.name,
      message: 'পাসওয়ার্ড সফলভাবে পরিবর্তন করা হয়েছে। এখন নতুন পাসওয়ার্ড দিয়ে লগইন করুন।',
    };
  }

  // ============================================================================
  // 🔐 USER ACCOUNTS & BLOCKING
  // ============================================================================
  async registerUser({ phoneNumber, name, password }) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('Phone number is required');

    const cleanPass = (password || '').trim();
    if (!cleanPass) {
      throw new Error('পাসওয়ার্ড প্রদান করা আবশ্যক। (Password is required)');
    }
    if (cleanPass.length < 4) {
      throw new Error('পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে। (Password must be at least 4 characters)');
    }

    // Check if user already exists with this phone number or its normalized variations
    const phoneRegex = buildPhoneQuery(norm);
    const existing = await User.findOne({
      $or: [
        { phoneNumber: norm },
        ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : []),
      ],
    }).lean();

    if (existing) {
      throw new Error('এই ফোন নম্বর দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট খোলা হয়েছে। অনুগ্রহ করে লগইন করুন। (An account with this phone number already exists. Please sign in.)');
    }

    const now = Date.now();
    try {
      const user = await User.create({
        phoneNumber: norm,
        name: (name || 'User').trim(),
        password: cleanPass,
        isBlocked: true, // By default user is blocked until admin activates
        blockedAt: now,
        blockedReason: 'Account pending administrator activation',
        createdAt: now,
        lastLogin: now,
      });

      return {
        phoneNumber: user.phoneNumber,
        name: user.name,
        isBlocked: true,
        blockedReason: user.blockedReason,
        createdAt: user.createdAt,
      };
    } catch (err) {
      if (err.code === 11000) {
        throw new Error('এই ফোন নম্বর দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট খোলা হয়েছে। অনুগ্রহ করে লগইন করুন। (An account with this phone number already exists. Please sign in.)');
      }
      throw err;
    }
  }

  async loginUser({ phoneNumber, username, password }) {
    const identifier = String(username || phoneNumber || '').trim();
    if (!identifier) throw new Error('Phone number or username is required');

    const cleanPass = (password || '').trim();
    if (!cleanPass) {
      throw new Error('অনুগ্রহ করে পাসওয়ার্ড দিন। (Password is required)');
    }

    const norm = normalizePhone(identifier);
    const phoneRegex = buildPhoneQuery(norm);

    let found = await User.findOne({
      $or: [
        { username: identifier.toLowerCase() },
        { phoneNumber: identifier },
        { phoneNumber: norm },
        ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : []),
      ],
    });

    if (!found) {
      if (identifier.toLowerCase() === 'super-admin') {
        throw new Error('Invalid super-admin credentials');
      }
      throw new Error('এই নম্বরে কোনো অ্যাকাউন্ট পাওয়া যায়নি। অনুগ্রহ করে প্রথমে রেজিস্ট্রেশন করুন। (No account found with this phone number. Please register first.)');
    }

    if (!found.password || found.password !== cleanPass) {
      throw new Error('ভুল পাসওয়ার্ড বা পিন। আবার চেষ্টা করুন। (Incorrect password or PIN)');
    }

    found.lastLogin = Date.now();
    await found.save();

    return {
      phoneNumber: found.phoneNumber,
      username: found.username || found.phoneNumber,
      name: found.name,
      avatar: found.avatar || '',
      role: found.role || 'user',
      isBlocked: Boolean(found.isBlocked),
      blockedReason: found.blockedReason || '',
      lastLogin: found.lastLogin,
    };
  }

  async loginAdmin({ username, password }) {
    const u = String(username || '').trim().toLowerCase();
    const p = String(password || '').trim();
    if (!u || !p) throw new Error('Username and password are required');

    let admin = await Admin.findOne({ username: u });
    if (!admin) {
      admin = await User.findOne({
        $or: [{ username: u }, { phoneNumber: u }],
        role: { $in: ['admin', 'super-admin'] },
      });
    }

    if (!admin || admin.password !== p) {
      throw new Error('Invalid administrator credentials');
    }

    if (admin.isBlocked) {
      throw new Error('This admin account has been suspended');
    }

    admin.lastLogin = Date.now();
    await admin.save();

    return {
      username: admin.username || u,
      name: admin.name || 'Super Administrator',
      role: admin.role || 'super-admin',
      lastLogin: admin.lastLogin,
    };
  }

  async blockUser(phoneNumber, reason = 'Blocked by administrator') {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('Phone number is required');

    const phoneRegex = buildPhoneQuery(norm);
    const updated = await User.findOneAndUpdate(
      { $or: [{ phoneNumber: norm }, { phoneNumber: phoneRegex }] },
      {
        $set: {
          isBlocked: true,
          blockedAt: Date.now(),
          blockedReason: reason || 'Blocked by administrator',
        },
      },
      { new: true }
    ).lean();

    if (!updated) throw new Error('User not found with this phone number');
    return updated;
  }

  async unblockUser(phoneNumber) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('Phone number is required');

    const phoneRegex = buildPhoneQuery(norm);
    const updated = await User.findOneAndUpdate(
      { $or: [{ phoneNumber: norm }, { phoneNumber: phoneRegex }] },
      {
        $set: {
          isBlocked: false,
          blockedAt: null,
          blockedReason: '',
        },
      },
      { new: true }
    ).lean();

    if (!updated) throw new Error('User not found with this phone number');
    return updated;
  }

  async isUserBlocked(phoneNumber) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) return false;
    const phoneRegex = buildPhoneQuery(norm);
    const user = await User.findOne({
      $or: [{ phoneNumber: norm }, { phoneNumber: phoneRegex }],
    }).lean();
    return Boolean(user && user.isBlocked);
  }

  async getRegisteredUsers() {
    return await User.find().sort({ isOnline: -1, lastActiveAt: -1, createdAt: -1 }).lean();
  }

  async setUserPresence(phoneNumber, { isOnline, lastActiveAt }) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) return null;
    const phoneRegex = buildPhoneQuery(norm);
    const update = {
      $set: {
        ...(isOnline !== undefined ? { isOnline: Boolean(isOnline) } : {}),
        lastActiveAt: Number(lastActiveAt) || Date.now(),
      },
    };
    return await User.findOneAndUpdate(
      { $or: [{ phoneNumber: norm }, ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : [])] },
      update,
      { new: true }
    ).lean();
  }

  async deleteUser(phoneNumber) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('Phone number is required');
    if (norm === 'super-admin') throw new Error('Cannot delete super-admin user');
    const phoneRegex = buildPhoneQuery(norm);
    const result = await User.deleteOne({
      $or: [{ phoneNumber: norm }, ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : [])],
    });
    return result.deletedCount > 0;
  }

  async getUserByPhone(phoneNumber) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) return null;
    const phoneRegex = buildPhoneQuery(norm);
    return await User.findOne({
      $or: [{ phoneNumber: norm }, ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : [])],
    }).lean();
  }

  async updateUserProfile(phoneNumber, { name, avatar }) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('Phone number is required');

    const updateFields = {};
    if (name !== undefined) {
      const cleanName = (name || '').trim();
      if (!cleanName) throw new Error('নাম আবশ্যক (Name is required)');
      updateFields.name = cleanName;
    }
    if (avatar !== undefined) {
      updateFields.avatar = String(avatar || '').trim();
    }

    if (Object.keys(updateFields).length === 0) {
      throw new Error('কোনো তথ্য পরিবর্তন করা হয়নি');
    }

    const phoneRegex = buildPhoneQuery(norm);
    const updated = await User.findOneAndUpdate(
      { $or: [{ phoneNumber: norm }, ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : [])] },
      { $set: updateFields },
      { new: true }
    ).lean();

    if (!updated) throw new Error('ব্যবহারকারী পাওয়া যায়নি (User not found)');
    return {
      phoneNumber: updated.phoneNumber,
      name: updated.name,
      avatar: updated.avatar || '',
      isBlocked: Boolean(updated.isBlocked),
      blockedReason: updated.blockedReason || '',
      createdAt: updated.createdAt,
      lastLogin: updated.lastLogin,
    };
  }

  async changePassword(phoneNumber, { oldPassword, newPassword }) {
    const norm = normalizePhone(phoneNumber);
    if (!norm) throw new Error('Phone number is required');

    const cleanOld = String(oldPassword || '').trim();
    const cleanNew = String(newPassword || '').trim();
    if (!cleanOld) throw new Error('বর্তমান পাসওয়ার্ড দিন (Current password is required)');
    if (!cleanNew) throw new Error('নতুন পাসওয়ার্ড দিন (New password is required)');
    if (cleanNew.length < 4) {
      throw new Error('নতুন পাসওয়ার্ড কমপক্ষে ৪ অক্ষরের হতে হবে (New password must be at least 4 characters)');
    }

    const phoneRegex = buildPhoneQuery(norm);
    const user = await User.findOne({
      $or: [{ phoneNumber: norm }, ...(phoneRegex ? [{ phoneNumber: phoneRegex }] : [])],
    });

    if (!user) throw new Error('ব্যবহারকারী পাওয়া যায়নি (User not found)');
    if (user.password !== cleanOld) {
      throw new Error('বর্তমান পাসওয়ার্ডটি সঠিক নয় (Current password is incorrect)');
    }

    user.password = cleanNew;
    await user.save();
    return true;
  }

  // ============================================================================
  // 📶 SIM OPERATORS MANAGEMENT
  // ============================================================================
  // 📱 STATIC SIM OPERATORS LIST (Static 5 Operators in Bangladesh)
  // ============================================================================
  getStaticSims() {
    return [
      { id: 'gp', name: 'Grameenphone', banglaName: 'গ্রামীণফোন', color: '#00A3E0', prefix: ['017', '013'] },
      { id: 'robi', name: 'Robi', banglaName: 'রবি', color: '#ED1C24', prefix: ['018'] },
      { id: 'bl', name: 'Banglalink', banglaName: 'বাংলালিংক', color: '#FF6F00', prefix: ['019', '014'] },
      { id: 'airtel', name: 'Airtel', banglaName: 'এয়ারটেল', color: '#D50000', prefix: ['016'] },
      { id: 'teletalk', name: 'Teletalk', banglaName: 'টেলিটক', color: '#00843D', prefix: ['015'] },
    ];
  }

  async getSims() {
    return this.getStaticSims();
  }

  async getSimById(id) {
    const sims = this.getStaticSims();
    return sims.find((s) => s.id.toLowerCase() === String(id).toLowerCase()) || null;
  }

  // ============================================================================
  // 📦 PACKAGES (OFFERS) MANAGEMENT
  // ============================================================================
  async getPackages({ operator, category, search } = {}) {
    const filter = { isActive: true };
    if (operator && operator !== 'all') {
      filter.operator = operator.toLowerCase();
    }
    if (category && category !== 'all') {
      filter.category = category.toLowerCase();
    }
    if (search && search.trim()) {
      const q = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { volume: { $regex: q, $options: 'i' } },
        { validity: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
      ];
    }
    return await Package.find(filter).sort({ price: 1 }).lean();
  }

  async getPackageById(id) {
    return await Package.findOne({ id }).lean();
  }

  async createPackage(data) {
    if (!data.operator) throw new Error('Operator is required (e.g. gp, bl, robi, airtel, teletalk)');
    if (!data.title) throw new Error('Package title is required');
    if (data.price === undefined || isNaN(Number(data.price))) throw new Error('Valid price is required');

    const id = data.id || `${data.operator.toLowerCase()}-${data.category || 'pack'}-${Date.now().toString(36)}`;
    return await Package.create({
      id,
      operator: data.operator.toLowerCase(),
      category: data.category || 'minute',
      title: data.title,
      volume: data.volume || '',
      validity: data.validity || '',
      price: Number(data.price),
      regularPrice: data.regularPrice ? Number(data.regularPrice) : null,
      cashback: Number(data.cashback) || 0,
      badge: data.badge || '',
      description: data.description || '',
      code: data.code || '',
      isActive: data.isActive !== undefined ? Boolean(data.isActive) : true,
      createdAt: Date.now(),
    });
  }

  async updatePackage(id, updates) {
    const updated = await Package.findOneAndUpdate({ id }, { $set: updates }, { new: true }).lean();
    if (!updated) throw new Error('Package not found');
    return updated;
  }

  async deletePackage(id) {
    const res = await Package.deleteOne({ id });
    return res.deletedCount > 0;
  }

  // ============================================================================
  // ⚙️ APP SETTINGS MANAGEMENT (Configurable Booking Fee)
  // ============================================================================
  async getAppSettings() {
    try {
      let settings = await AppSettings.findOne({ key: 'global_settings' }).lean();
      if (!settings) {
        settings = await AppSettings.create({
          key: 'global_settings',
          bookingPaymentAmount: 50,
          deliveryFeeInsideDhaka: 70,
          deliveryFeeOutsideDhaka: 120,
          shopLocation: 'মিরপুর ১০, ঢাকা',
          shopAddress: 'মিরপুর ১০ গোলচত্বর, ঢাকা',
          appName: 'BuySell - সেকেন্ড হ্যান্ড বাজার',
          supportPhone: '0197272313',
          noticeBanner: 'নিরাপদে সেকেন্ড হ্যান্ড পণ্য কিনুন বা টোকেন বুকিং মানি দিয়ে বুক করে রাখুন!',
          updatedAt: Date.now(),
        });
        if (settings.toObject) settings = settings.toObject();
      }
      return settings;
    } catch (err) {
      console.warn('[DB getAppSettings Warning]:', err.message);
      return {
        key: 'global_settings',
        bookingPaymentAmount: 50,
        deliveryFeeInsideDhaka: 70,
        deliveryFeeOutsideDhaka: 120,
        shopLocation: 'মিরপুর ১০, ঢাকা',
        shopAddress: 'মিরপুর ১০ গোলচত্বর, ঢাকা',
        appName: 'BuySell - সেকেন্ড হ্যান্ড বাজার',
        supportPhone: '0197272313',
      };
    }
  }

  async updateAppSettings(updates = {}) {
    const data = { ...updates, updatedAt: Date.now() };
    if (data.bookingPaymentAmount !== undefined) {
      const val = Number(data.bookingPaymentAmount);
      data.bookingPaymentAmount = isNaN(val) || val <= 0 ? 50 : val;
    }
    if (data.deliveryFeeInsideDhaka !== undefined) {
      const val = Number(data.deliveryFeeInsideDhaka);
      data.deliveryFeeInsideDhaka = isNaN(val) || val <= 0 ? 70 : val;
    }
    if (data.deliveryFeeOutsideDhaka !== undefined) {
      const val = Number(data.deliveryFeeOutsideDhaka);
      data.deliveryFeeOutsideDhaka = isNaN(val) || val <= 0 ? 120 : val;
    }
    const updated = await AppSettings.findOneAndUpdate(
      { key: 'global_settings' },
      { $set: data },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    // Single-vendor sync: if shopLocation changed, update all products' location automatically
    if (data.shopLocation && typeof data.shopLocation === 'string' && data.shopLocation.trim()) {
      await Product.updateMany({}, { $set: { location: data.shopLocation.trim() } }).catch(() => {});
    }
    return updated;
  }

  // ============================================================================
  // 🛍️ 2ND-HAND PRODUCTS MANAGEMENT
  // ============================================================================
  async getProducts({ category, search, minPrice, maxPrice, status, condition, sort = 'newest' } = {}) {
    const filter = {};
    if (category && category !== 'all') {
      filter.category = category.toLowerCase();
    }
    if (status && status !== 'all') {
      filter.status = status;
    }
    if (condition && condition !== 'all') {
      filter.condition = condition;
    }
    if (minPrice !== undefined && !isNaN(Number(minPrice)) && Number(minPrice) > 0) {
      filter.price = { ...(filter.price || {}), $gte: Number(minPrice) };
    }
    if (maxPrice !== undefined && !isNaN(Number(maxPrice)) && Number(maxPrice) > 0) {
      filter.price = { ...(filter.price || {}), $lte: Number(maxPrice) };
    }
    if (search && search.trim()) {
      const q = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { title: { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { location: { $regex: q, $options: 'i' } },
        { categoryName: { $regex: q, $options: 'i' } },
        { badge: { $regex: q, $options: 'i' } },
      ];
    }

    let sortOptions = { createdAt: -1 };
    if (sort === 'price_asc') sortOptions = { price: 1 };
    else if (sort === 'price_desc') sortOptions = { price: -1 };
    else if (sort === 'oldest') sortOptions = { createdAt: 1 };

    return await Product.find(filter).sort(sortOptions).lean();
  }

  async getProductById(id) {
    return await Product.findOne({ id }).lean();
  }

  async createProduct(data) {
    if (!data.title) throw new Error('Product title is required');
    if (data.price === undefined || isNaN(Number(data.price))) throw new Error('Valid price is required');

    const id = data.id || `prod-${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 6)}`;
    const category = (data.category || 'others').toLowerCase();

    const catNames = {
      mobiles: 'মোবাইল ও গ্যাজেট',
      computers: 'ল্যাপটপ ও পিসি',
      bikes: 'বাইক ও গাড়ি',
      electronics: 'ইলেকট্রনিক্স ও টিভি',
      appliances: 'গৃহস্থালি সামগ্রী',
      cameras: 'ক্যামেরা ও অডিও',
      furniture: 'আসবাবপত্র',
      fashion: 'ঘড়ি ও ফ্যাশন',
      others: 'অন্যান্য পণ্য',
    };

    const conditionLabels = {
      'used-like-new': 'নতুনের মতো (Like New)',
      'used-good': 'ভালো কন্ডিশন (Good)',
      'used-fair': 'মোটামুটি / ব্যবহার্য (Fair)',
    };

    return await Product.create({
      id,
      title: data.title.trim(),
      category,
      categoryName: data.categoryName || catNames[category] || 'সাধারণ পণ্য',
      price: Number(data.price),
      originalPrice: data.originalPrice ? Number(data.originalPrice) : null,
      condition: data.condition || 'used-good',
      conditionLabel: data.conditionLabel || conditionLabels[data.condition] || 'ভালো',
      location: data.location || 'মিরপুর ১০, ঢাকা',
      images: Array.isArray(data.images) && data.images.length > 0 ? data.images : (data.thumbnail ? [data.thumbnail] : []),
      thumbnail: data.thumbnail || (Array.isArray(data.images) && data.images[0]) || '',
      description: data.description || '',
      sellerName: data.sellerName || 'Buy & Sell BD',
      sellerPhone: data.sellerPhone || '01900000000',
      sellerVerified: data.sellerVerified !== undefined ? Boolean(data.sellerVerified) : true,
      sellerRating: Number(data.sellerRating) || 4.8,
      bookingAmount: data.bookingAmount !== undefined && data.bookingAmount !== null && !isNaN(Number(data.bookingAmount)) ? Number(data.bookingAmount) : null,
      status: data.status || 'available',
      featured: Boolean(data.featured),
      badge: data.badge || (data.featured ? 'হট ডিল' : ''),
      specifications: Array.isArray(data.specifications) ? data.specifications : [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  }

  async updateProduct(id, updates) {
    const updated = await Product.findOneAndUpdate(
      { id },
      { $set: { ...updates, updatedAt: Date.now() } },
      { new: true }
    ).lean();
    if (!updated) throw new Error('Product not found');
    return updated;
  }

  async deleteProduct(id) {
    const res = await Product.deleteOne({ id });
    return res.deletedCount > 0;
  }

  // ============================================================================
  // 📱 SMS MESSAGES MANAGEMENT
  // ============================================================================
  async getReceiptNumbersList() {
    const receipts = await Message.distinct('receiptNumber');
    const recipients = await Message.distinct('recipientPhone');
    const users = await User.find().lean();

    const set = new Set();
    for (const r of receipts) if (r) set.add(r);
    for (const r of recipients) if (r) set.add(r);
    for (const u of users) if (u && u.phoneNumber) set.add(u.phoneNumber);

    return Array.from(set).sort();
  }

  /**
   * Filter, search and paginate messages directly in MongoDB
   */
  async getMessages({
    search,
    category,
    sender,
    threadId,
    receiptNumber,
    recipientPhone,
    userPhone,
    page = 1,
    limit = 50,
  }) {
    const filter = {};

    // 📱 Receipt Number Filter
    const targetReceipt = (receiptNumber || recipientPhone || userPhone || '').trim();
    if (targetReceipt) {
      const pRegex = buildPhoneQuery(targetReceipt);
      if (pRegex) {
        filter.$or = [
          { receiptNumber: pRegex },
          { recipientPhone: pRegex },
          { receiptNumber: targetReceipt },
          { recipientPhone: targetReceipt },
        ];
      } else {
        filter.$or = [
          { receiptNumber: targetReceipt },
          { recipientPhone: targetReceipt },
        ];
      }
    }

    // 🔍 Search filter across all relevant fields
    if (search && search.trim()) {
      const q = search.trim();
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const qRegex = new RegExp(escaped, 'i');
      const pRegex = buildPhoneQuery(q);

      const searchConditions = [
        { body: qRegex },
        { sender: qRegex },
        { phoneNumber: qRegex },
        { receiptNumber: qRegex },
        { recipientPhone: qRegex },
        { notes: qRegex },
        { otpCode: qRegex },
        { deviceModel: qRegex },
      ];

      if (pRegex) {
        searchConditions.push({ receiptNumber: pRegex }, { recipientPhone: pRegex });
      }

      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, { $or: searchConditions }];
        delete filter.$or;
      } else {
        filter.$or = searchConditions;
      }
    }

    // Category filter
    if (category && category !== 'all') {
      filter.category = category;
    }

    // Sender filter
    if (sender) {
      filter.sender = new RegExp(`^${sender.trim()}$`, 'i');
    }

    // Thread ID filter
    if (threadId) {
      filter.threadId = threadId;
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(500, parseInt(limit, 10) || 50));
    const offset = (pageNum - 1) * limitNum;

    const total = await Message.countDocuments(filter);
    const messages = await Message.find(filter)
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limitNum)
      .lean();

    return {
      messages,
      total,
      page: pageNum,
      limit: limitNum,
      totalPages: Math.ceil(total / limitNum) || 1,
    };
  }

  async getMessageById(id) {
    return await Message.findOne({ id }).lean();
  }

  async updateMessage(id, updates) {
    const allowed = [
      'category', 'notes', 'tags', 'isRead', 'body', 'sender',
      'phoneNumber', 'receiptNumber', 'recipientPhone'
    ];
    const updatePayload = { updatedAt: Date.now() };

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        updatePayload[key] = updates[key];
        if (key === 'receiptNumber') updatePayload.recipientPhone = updates[key];
        if (key === 'recipientPhone') updatePayload.receiptNumber = updates[key];
      }
    }

    return await Message.findOneAndUpdate({ id }, { $set: updatePayload }, { new: true }).lean();
  }

  async deleteMessage(id) {
    const res = await Message.deleteOne({ id });
    if (res.deletedCount > 0) {
      this._cachedMessageCount = Math.max(0, this._cachedMessageCount - 1);
      return true;
    }
    return false;
  }

  /**
   * Find an existing duplicate message with identical sender and body within a 3-minute window
   */
  async findDuplicate(sender, body, receiptNumber, timestamp, excludeId = null) {
    if (!body || !sender) return null;
    const cleanBody = String(body).trim();
    const cleanSender = String(sender).trim();
    const ts = Number(timestamp) || Date.now();
    const timeWindow = 180000; // 3 minutes window to absorb broadcast vs inbox delay

    const query = {
      body: cleanBody,
      sender: new RegExp(`^${cleanSender.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'),
      timestamp: { $gte: ts - timeWindow, $lte: ts + timeWindow },
    };

    if (excludeId) {
      query.id = { $ne: excludeId };
    }

    if (receiptNumber) {
      const pRegex = buildPhoneQuery(receiptNumber);
      if (pRegex) {
        query.$or = [
          { receiptNumber: pRegex },
          { recipientPhone: pRegex },
          { receiptNumber },
          { recipientPhone: receiptNumber },
          { receiptNumber: '' },
          { receiptNumber: null },
        ];
      }
    }

    return await Message.findOne(query).lean();
  }

  async createCustomMessage(data) {
    const now = Date.now();
    const rNum = normalizePhone(data.receiptNumber || data.recipientPhone || data.userPhone || '');
    const ts = Number(data.timestamp) || now;

    // Check for duplicate
    const existing = await this.findDuplicate(data.sender, data.body, rNum, ts);
    if (existing) {
      console.log(`[Deduplication] Message already exists with ID "${existing.id}". Returning existing message.`);
      return existing;
    }

    const id = data.id || `custom-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const doc = {
      id,
      threadId: data.threadId || 'default',
      sender: data.sender || 'Custom',
      phoneNumber: data.phoneNumber || data.sender || '',
      receiptNumber: rNum,
      recipientPhone: rNum,
      body: data.body || '',
      timestamp: ts,
      isIncoming: data.isIncoming !== undefined ? Boolean(data.isIncoming) : false,
      isRead: true,
      category: data.category || 'personal',
      otpCode: data.otpCode ? String(data.otpCode) : null,
      deviceModel: data.deviceModel || 'Web Dashboard',
      storedAt: now,
      updatedAt: now,
      notes: data.notes || '',
      tags: Array.isArray(data.tags) ? data.tags : ['manual'],
    };

    const created = await Message.create(doc);
    this._cachedMessageCount = await Message.countDocuments();
    return created.toObject();
  }

  async addIncoming(msg, deviceMetadata = null, receiptNumber = '') {
    const assignedReceipt = normalizePhone(
      receiptNumber ||
      msg.receiptNumber ||
      msg.recipientPhone ||
      deviceMetadata?.receiptNumber ||
      deviceMetadata?.userPhone ||
      deviceMetadata?.phoneNumber ||
      ''
    );

    await this.recordDevice(deviceMetadata, assignedReceipt);

    const now = Date.now();
    const ts = Number(msg.timestamp) || now;

    // 1. Check if message with identical ID already exists
    if (msg.id) {
      const byId = await Message.findOne({ id: msg.id }).lean();
      if (byId) {
        console.log(`[Deduplication] Message with ID "${msg.id}" already exists. Skipping duplicate.`);
        return byId;
      }
    }

    // 2. Check if identical message (sender + body + receiptNumber within 3 min) already exists
    const duplicate = await this.findDuplicate(msg.sender, msg.body, assignedReceipt, ts);
    if (duplicate) {
      console.log(`[Deduplication] Prevented duplicate incoming SMS: "${String(msg.body).slice(0, 35)}..." from ${msg.sender} (Matches: ${duplicate.id})`);
      if (assignedReceipt && (!duplicate.receiptNumber || !duplicate.recipientPhone)) {
        await Message.updateOne(
          { id: duplicate.id },
          { $set: { receiptNumber: assignedReceipt, recipientPhone: assignedReceipt, updatedAt: now } }
        );
      }
      return duplicate;
    }

    const id = msg.id || `incoming-${now}-${Math.random().toString(36).slice(2, 7)}`;
    const normalized = {
      id,
      threadId: msg.threadId || 'default',
      sender: msg.sender || msg.phoneNumber || 'Unknown',
      phoneNumber: msg.phoneNumber || msg.sender || '',
      receiptNumber: assignedReceipt,
      recipientPhone: assignedReceipt,
      body: msg.body || '',
      timestamp: ts,
      isIncoming: true,
      isRead: false,
      category: msg.category || 'personal',
      otpCode: msg.otpCode ? String(msg.otpCode) : null,
      deviceModel: deviceMetadata?.modelName || 'Unknown Device',
      storedAt: now,
      updatedAt: now,
      notes: '',
      tags: ['live-incoming'],
    };

    const stored = await Message.create(normalized);

    await Metadata.findOneAndUpdate(
      { key: 'global_stats' },
      {
        $inc: { totalIncomingReceived: 1 },
        $set: { lastSync: now },
      },
      { upsert: true }
    );

    this._cachedMessageCount = await Message.countDocuments();
    return stored.toObject();
  }

  async upsertBatch(messages, deviceMetadata = null, receiptNumber = '') {
    const assignedReceipt = normalizePhone(
      receiptNumber ||
      deviceMetadata?.receiptNumber ||
      deviceMetadata?.userPhone ||
      deviceMetadata?.phoneNumber ||
      ''
    );

    await this.recordDevice(deviceMetadata, assignedReceipt);
    const now = Date.now();

    if (!Array.isArray(messages) || messages.length === 0) {
      return { inserted: 0, updated: 0, total: this._cachedMessageCount };
    }

    // Determine time window of the batch to pre-fetch candidates in one single query
    let minTime = Infinity;
    let maxTime = -Infinity;
    const validMessages = [];

    for (const msg of messages) {
      if (!msg || !msg.body) continue;
      const ts = Number(msg.timestamp) || now;
      if (ts < minTime) minTime = ts;
      if (ts > maxTime) maxTime = ts;
      validMessages.push({ ...msg, timestamp: ts });
    }

    if (validMessages.length === 0) {
      return { inserted: 0, updated: 0, total: this._cachedMessageCount };
    }

    // Pre-fetch all candidates in the batch's time range (+/- 3 minutes)
    const existingCandidates = await Message.find({
      timestamp: { $gte: minTime - 180000, $lte: maxTime + 180000 },
    }).lean();

    const existingById = new Map();
    const existingByContent = [];

    for (const m of existingCandidates) {
      existingById.set(m.id, m);
      existingByContent.push({
        id: m.id,
        sender: String(m.sender || '').trim().toLowerCase(),
        body: String(m.body || '').trim(),
        receipt: String(m.receiptNumber || m.recipientPhone || '').trim(),
        ts: Number(m.timestamp) || 0,
      });
    }

    const ops = [];
    let duplicateMergeCount = 0;

    for (const msg of validMessages) {
      const cleanSender = String(msg.sender || msg.phoneNumber || 'Unknown').trim().toLowerCase();
      const cleanBody = String(msg.body || '').trim();
      const rNum = normalizePhone(
        msg.receiptNumber ||
        msg.recipientPhone ||
        msg.receiverPhone ||
        assignedReceipt ||
        ''
      );
      const ts = msg.timestamp;

      // 1. Check if an exact ID already exists
      let targetId = msg.id;

      // 2. Check if a message with identical sender + body exists within 3 minutes (e.g. from live incoming)
      const matched = existingByContent.find(
        (c) =>
          c.sender === cleanSender &&
          c.body === cleanBody &&
          Math.abs(c.ts - ts) <= 180000
      );

      if (matched) {
        // Reuse the existing document's ID so we MERGE / UPDATE rather than inserting a duplicate!
        targetId = matched.id;
        duplicateMergeCount++;
      } else if (!targetId) {
        targetId = `msg-${ts}-${Math.random().toString(36).slice(2, 7)}`;
      }

      ops.push({
        updateOne: {
          filter: { id: targetId },
          update: {
            $set: {
              id: targetId,
              threadId: msg.threadId || 'default',
              sender: msg.sender || msg.phoneNumber || 'Unknown',
              phoneNumber: msg.phoneNumber || msg.sender || '',
              receiptNumber: rNum,
              recipientPhone: rNum,
              body: msg.body || '',
              timestamp: ts,
              isIncoming: msg.isIncoming !== undefined ? Boolean(msg.isIncoming) : true,
              isRead: msg.isRead !== undefined ? Boolean(msg.isRead) : false,
              category: msg.category || 'personal',
              otpCode: msg.otpCode ? String(msg.otpCode) : null,
              deviceModel: deviceMetadata?.modelName || 'Unknown Device',
              storedAt: matched ? matched.ts : now,
              updatedAt: now,
              notes: msg.notes || '',
              tags: Array.isArray(msg.tags) ? msg.tags : [],
            },
          },
          upsert: true,
        },
      });

      // Track in-flight additions so duplicates within the same batch are also caught
      if (!matched) {
        existingByContent.push({
          id: targetId,
          sender: cleanSender,
          body: cleanBody,
          receipt: rNum,
          ts,
        });
      }
    }

    let inserted = 0;
    let updated = 0;

    if (ops.length > 0) {
      const res = await Message.bulkWrite(ops);
      inserted = res.upsertedCount || 0;
      updated = res.modifiedCount || 0;
    }

    if (duplicateMergeCount > 0) {
      console.log(`[Deduplication] Prevented ${duplicateMergeCount} duplicate messages during batch sync.`);
    }

    await Metadata.findOneAndUpdate(
      { key: 'global_stats' },
      {
        $inc: { totalSyncBatches: 1 },
        $set: { lastSync: now },
      },
      { upsert: true }
    );

    this._cachedMessageCount = await Message.countDocuments();

    return {
      inserted,
      updated,
      duplicatesPrevented: duplicateMergeCount,
      total: this._cachedMessageCount,
    };
  }

  async assignReceiptNumber(receiptNumber, deviceModel = null) {
    const norm = normalizePhone(receiptNumber);
    if (!norm) throw new Error('Receipt number is required');

    const filter = {};
    if (deviceModel) {
      filter.deviceModel = deviceModel;
    }

    const res = await Message.updateMany(filter, {
      $set: {
        receiptNumber: norm,
        recipientPhone: norm,
        updatedAt: Date.now(),
      },
    });

    return res.modifiedCount || 0;
  }

  // ==========================================================================
  // 💳 LIVE PAYMENT SESSIONS / ORDERS
  // ==========================================================================

  async createOrUpdatePaymentSession(data) {
    const { sessionId } = data;
    if (!sessionId) throw new Error('sessionId is required');

    const update = {
      ...data,
      updatedAt: Date.now(),
    };
    if (!update.createdAt) {
      update.createdAt = Date.now();
    }

    // Keep in-memory cache updated for ultra-low latency polling
    const existingMem = this._paymentSessions.get(sessionId) || {};
    const mergedMem = { ...existingMem, ...update };
    this._paymentSessions.set(sessionId, mergedMem);

    try {
      const order = await PaymentOrder.findOneAndUpdate(
        { sessionId },
        { $set: update },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean();
      return order || mergedMem;
    } catch (err) {
      console.warn('[DB Payment Session Warning]: MongoDB update failed, using memory:', err.message);
      return mergedMem;
    }
  }

  async getPaymentSession(sessionId) {
    if (!sessionId) return null;

    // First check memory cache for instant sub-millisecond response
    if (this._paymentSessions.has(sessionId)) {
      return this._paymentSessions.get(sessionId);
    }

    try {
      const order = await PaymentOrder.findOne({ sessionId }).lean();
      if (order) {
        this._paymentSessions.set(sessionId, order);
      }
      return order;
    } catch (err) {
      console.error('[DB getPaymentSession Error]:', err.message);
      return null;
    }
  }

  async getActivePaymentOrders() {
    try {
      // Find orders from the last 24 hours
      const since = Date.now() - 24 * 60 * 60 * 1000;
      const dbOrders = await PaymentOrder.find({
        createdAt: { $gte: since }
      })
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

      // Merge with any active memory orders
      const orderMap = new Map();
      dbOrders.forEach(o => orderMap.set(o.sessionId, o));
      this._paymentSessions.forEach((o, id) => {
        if (!orderMap.has(id) && o.createdAt >= since) {
          orderMap.set(id, o);
        }
      });

      return Array.from(orderMap.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    } catch (err) {
      console.error('[DB getActivePaymentOrders Error]:', err.message);
      return Array.from(this._paymentSessions.values()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
  }

  async updatePaymentOrderStatus(sessionId, { status, errorMessage, currentStep, orderProgress, trackingNote }) {
    if (!sessionId) throw new Error('sessionId is required');

    const updateFields = {
      updatedAt: Date.now(),
    };
    if (status !== undefined) updateFields.status = status;
    if (errorMessage !== undefined) updateFields.errorMessage = errorMessage;
    if (currentStep !== undefined) updateFields.currentStep = currentStep;
    if (orderProgress !== undefined) {
      updateFields.orderProgress = orderProgress;
    } else if (status === 'completed') {
      updateFields.orderProgress = 'confirmed';
    } else if (status === 'failed') {
      updateFields.orderProgress = 'cancelled';
    }
    if (trackingNote !== undefined) updateFields.trackingNote = trackingNote;

    const existingMem = this._paymentSessions.get(sessionId) || {};
    const updatedMem = { ...existingMem, ...updateFields };
    this._paymentSessions.set(sessionId, updatedMem);

    try {
      const updated = await PaymentOrder.findOneAndUpdate(
        { sessionId },
        { $set: updateFields },
        { new: true }
      ).lean();
      return updated || updatedMem;
    } catch (err) {
      console.warn('[DB updatePaymentOrderStatus Warning]:', err.message);
      return updatedMem;
    }
  }

  async getUserOrders(phoneNumber) {
    if (!phoneNumber) return [];
    const cleaned = String(phoneNumber).replace(/\D/g, '');
    const last10 = cleaned.length >= 10 ? cleaned.slice(-10) : cleaned;
    const regex = last10 ? new RegExp(last10 + '$') : new RegExp('^' + String(phoneNumber) + '$');

    try {
      const orders = await PaymentOrder.find({
        $or: [
          { userPhone: regex },
          { buyerPhone: regex },
          { accountNumber: regex },
        ],
      })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean();

      // Enrich with product thumbnails if missing
      const prodIds = [...new Set(orders.map((o) => o.productId).filter(Boolean))];
      let prodMap = {};
      if (prodIds.length > 0) {
        const prods = await Product.find({ id: { $in: prodIds } }, { id: 1, thumbnail: 1, images: 1 }).lean();
        prods.forEach((p) => {
          prodMap[p.id] = p.thumbnail || (Array.isArray(p.images) && p.images[0]) || '';
        });
      }

      return orders.map((o) => {
        let derivedProgress = o.orderProgress;
        if (!derivedProgress || derivedProgress === 'pending') {
          if (o.status === 'completed') derivedProgress = 'confirmed';
          else if (o.status === 'failed') derivedProgress = 'cancelled';
          else derivedProgress = 'pending';
        }
        return {
          ...o,
          orderProgress: derivedProgress,
          productThumbnail: o.productThumbnail || prodMap[o.productId] || '',
        };
      });
    } catch (err) {
      console.error('[DB getUserOrders Error]:', err.message);
      return [];
    }
  }

  async updateOrderProgress(sessionId, { orderProgress, trackingNote }) {
    if (!sessionId) throw new Error('sessionId is required');
    const updateFields = { updatedAt: Date.now() };
    if (orderProgress) updateFields.orderProgress = orderProgress;
    if (trackingNote !== undefined) updateFields.trackingNote = String(trackingNote);

    const updated = await PaymentOrder.findOneAndUpdate(
      { sessionId },
      { $set: updateFields },
      { new: true }
    ).lean();
    if (!updated) throw new Error('Order not found');

    const existingMem = this._paymentSessions.get(sessionId) || {};
    this._paymentSessions.set(sessionId, { ...existingMem, ...updated });
    return updated;
  }

  async deletePaymentOrder(sessionId) {
    this._paymentSessions.delete(sessionId);
    try {
      await PaymentOrder.deleteOne({ sessionId });
      return true;
    } catch {
      return false;
    }
  }

  async exportAll() {
    const messages = await Message.find().lean();
    const devices = await Device.find().lean();
    const users = await User.find().lean();
    const sims = await Sim.find().lean();
    const packages = await Package.find().lean();
    const metadata = (await Metadata.findOne({ key: 'global_stats' }).lean()) || {};

    return {
      exportedAt: Date.now(),
      metadata,
      devices,
      users,
      sims,
      packages,
      messages,
    };
  }
}

module.exports = new Database();
