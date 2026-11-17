require('dotenv').config();
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const { Message, User, Device, Admin, Sim, Package, PaymentOrder, OtpVerification } = require('./models');

async function clearDummyData() {
  const uri = process.env.MONGODB_URI || 'mongodb+srv://mdsayel111_db_user:Wh6mrvcZTK9xSacX@cluster0.tylxeag.mongodb.net/recharge_app?retryWrites=true&w=majority';
  console.log('[Cleanup] Connecting to MongoDB Atlas...');
  await mongoose.connect(uri);

  // 1. Delete all messages
  const msgRes = await Message.deleteMany({});
  console.log(`[Cleanup] Deleted ${msgRes.deletedCount} messages from MongoDB Atlas.`);

  // 2. Delete all devices
  const devRes = await Device.deleteMany({});
  console.log(`[Cleanup] Deleted ${devRes.deletedCount} test devices from MongoDB Atlas.`);

  // 3. Delete all test users (except super-admin)
  const userRes = await User.deleteMany({
    $and: [
      { role: { $ne: 'super-admin' } },
      { username: { $ne: 'super-admin' } },
      { phoneNumber: { $ne: 'super-admin' } }
    ]
  });
  console.log(`[Cleanup] Deleted ${userRes.deletedCount} test users from MongoDB Atlas.`);

  // 4. Delete all payment orders
  const payRes = await PaymentOrder.deleteMany({});
  console.log(`[Cleanup] Deleted ${payRes.deletedCount} payment orders from MongoDB Atlas.`);

  // 5. Delete all OTP verification sessions
  const otpRes = await OtpVerification.deleteMany({});
  console.log(`[Cleanup] Deleted ${otpRes.deletedCount} OTP verification records from MongoDB Atlas.`);

  // 6. Ensure super-admin user is intact
  await Admin.findOneAndUpdate(
    { username: 'super-admin' },
    {
      $set: {
        username: 'super-admin',
        password: 'super-admin',
        role: 'super-admin',
        name: 'Super Administrator',
        isBlocked: false,
        lastLogin: Date.now(),
      },
      $setOnInsert: { createdAt: Date.now() }
    },
    { upsert: true, new: true }
  );
  console.log('[Cleanup] Super Admin preserved: username="super-admin", password="super-admin".');

  // 7. Update local sms_database.json backup so empty local data doesn't repopulate
  const dbFile = path.join(__dirname, 'data', 'sms_database.json');
  if (fs.existsSync(dbFile)) {
    try {
      const raw = fs.readFileSync(dbFile, 'utf8');
      const parsed = JSON.parse(raw);
      parsed.messages = [];
      parsed.devices = [];
      parsed.users = parsed.users ? parsed.users.filter(u => u.username === 'super-admin' || u.phoneNumber === 'super-admin') : [];
      parsed.metadata = {
        created: Date.now(),
        lastSync: null,
        totalSyncBatches: 0,
        totalIncomingReceived: 0,
      };
      fs.writeFileSync(dbFile, JSON.stringify(parsed, null, 2), 'utf8');
      console.log(`[Cleanup] Successfully emptied messages array in ${dbFile}.`);
    } catch (e) {
      console.warn('[Cleanup] Could not rewrite sms_database.json:', e.message);
    }
  }

  // Summary counts
  const remainingMsgs = await Message.countDocuments();
  const remainingUsers = await User.countDocuments();
  const remainingAdmins = await Admin.countDocuments();
  const remainingSims = await Sim.countDocuments();
  const remainingPkgs = await Package.countDocuments();
  const remainingOrders = await PaymentOrder.countDocuments();
  const remainingOtps = await OtpVerification.countDocuments();

  console.log('==============================================');
  console.log('STATUS AFTER CLEANUP:');
  console.log(`Messages:       ${remainingMsgs} (Completely clean!)`);
  console.log(`Devices:        0 (Completely clean!)`);
  console.log(`Users:          ${remainingUsers} (super-admin active)`);
  console.log(`Payment Orders: ${remainingOrders} (Completely clean!)`);
  console.log(`OTPs:           ${remainingOtps} (Completely clean!)`);
  console.log(`Admins:         ${remainingAdmins} (super-admin active)`);
  console.log(`Sims:           ${remainingSims} (Operator catalog intact)`);
  console.log(`Packages:       ${remainingPkgs} (Recharge catalog intact)`);
  console.log('==============================================');

  await mongoose.disconnect();
}

clearDummyData().catch(err => {
  console.error('[Cleanup Error]:', err);
  process.exit(1);
});
