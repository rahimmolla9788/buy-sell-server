# 🚀 Money App - SMS Backend & Cloud Vault

A high-performance, lightweight REST API and real-time Web Dashboard built with Node.js & Express to automatically store, organize, and manage mobile SMS backups with full CRUD operations.

---

## 🌟 Features

- **Batch SMS Backup**: Ingests hundreds or thousands of historical SMS messages from the mobile client in one request (`POST /api/sms/sync-batch`).
- **Live Real-Time SMS Receiver**: Captures live incoming SMS instantly as they arrive on the phone (`POST /api/sms/incoming`).
- **Smart Deduplication**: Automatically prevents duplicate SMS entries using unique message IDs and phone + timestamp signatures.
- **Zero-Config Persistent Storage**: Atomic file-backed JSON database in `data/sms_database.json` — works out of the box with zero external database setup.
- **Full CRUD Support**: Create, Read, Update (categories, tags, private notes), and Delete messages via REST API and Web Dashboard.
- **Interactive Web Dashboard**: Beautiful, mobile-friendly dashboard served at `http://localhost:5000/` featuring:
  - Live auto-sync polling
  - Instant keyword & sender search
  - Category filters (💳 Banking, 🔑 OTP, 💬 Personal, ⚡ Transaction, 📢 Promo)
  - One-click OTP code copy
  - Full message detail modal with custom expense/note editing
  - JSON backup exporter

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
cd money-app-server
npm install
```

### 2. Run Server
```bash
# Production mode
npm start

# Development mode (auto-reloads on file changes)
npm run dev
```

The server will start on port `5000`:
- **Web Dashboard**: [http://localhost:5000](http://localhost:5000)
- **REST API Base**: [http://localhost:5000/api](http://localhost:5000/api)

---

## 📡 REST API Reference

### 1. Batch SMS Sync
Stores an array of SMS messages sent by the mobile device.

- **Endpoint**: `POST /api/sms/sync-batch`
- **Headers**: `Content-Type: application/json`
- **Payload**:
```json
{
  "device": {
    "deviceName": "Redmi 12C",
    "modelName": "22120RN86I",
    "brand": "Xiaomi",
    "osName": "Android",
    "osVersion": "13",
    "platform": "android"
  },
  "syncedAt": 1729780000000,
  "totalCount": 2,
  "messages": [
    {
      "id": "real-msg-101",
      "threadId": "10",
      "sender": "bKash",
      "phoneNumber": "bKash",
      "body": "You have received Tk 2,500.00 from 01712345678. Balance Tk 8,920.00.",
      "timestamp": 1729780000000,
      "isIncoming": true,
      "isRead": true,
      "category": "banking",
      "otpCode": null
    }
  ]
}
```
- **Response**:
```json
{
  "success": true,
  "message": "Successfully synced 2 messages (2 new, 0 updated)",
  "syncedCount": 2,
  "inserted": 2,
  "updated": 0,
  "totalInDb": 2,
  "syncedAt": 1729780000000
}
```

---

### 2. Real-Time Incoming SMS
Saves an individual incoming cellular SMS as soon as the phone receives it.

- **Endpoint**: `POST /api/sms/incoming`
- **Payload**:
```json
{
  "device": { "modelName": "Redmi 12C" },
  "receivedAt": 1729780500000,
  "message": {
    "id": "incoming-msg-202",
    "sender": "Google",
    "phoneNumber": "Google",
    "body": "G-492103 is your Google verification code.",
    "category": "otp",
    "otpCode": "492103",
    "timestamp": 1729780500000
  }
}
```

---

### 3. List & Search SMS (CRUD: Read)
- **Endpoint**: `GET /api/sms`
- **Query Parameters**:
  - `userPhone`: Filter by recipient/user phone number (e.g. `017xxxxxxxx`)
  - `search`: Filter by keyword, sender, body, or OTP code
  - `category`: Filter by category (`banking`, `otp`, `personal`, `transaction`, `promotional`, `spam`)
  - `sender`: Filter by sender name
  - `page`: Page number (default: `1`)
  - `limit`: Number of items per page (default: `50`)

---

### 4. Fetch User Messages Upon Login
Returns all SMS messages that were received by a specific user phone number:

- **Endpoint**: `GET /api/sms/user/:phoneNumber`
- **Example**: `GET /api/sms/user/+8801700000000`
- **Query Parameters**: `search`, `category`, `page`, `limit`
- **Response**:
```json
{
  "success": true,
  "userPhone": "+8801700000000",
  "count": 150,
  "data": [
    {
      "id": "real-msg-...",
      "sender": "bKash",
      "recipientPhone": "+8801700000000",
      "body": "...",
      "timestamp": 1729780000000
    }
  ],
  "pagination": {
    "total": 150,
    "page": 1,
    "limit": 50,
    "totalPages": 3
  }
}
```

---

### 5. List All Registered User Phone Numbers
Returns all unique user phone numbers that have backed up messages:

- **Endpoint**: `GET /api/sms/users`
- **Response**:
```json
{
  "success": true,
  "data": [
    {
      "phoneNumber": "+8801700000000",
      "totalMessages": 1182,
      "lastReceived": 1729785000000,
      "deviceModel": "Redmi 12C"
    }
  ]
}
```

---

### 4. Update SMS (CRUD: Update)
- **Endpoint**: `PUT /api/sms/:id`
- **Payload**:
```json
{
  "category": "banking",
  "notes": "Payment for freelance project",
  "tags": ["income", "work"]
}
```

---

### 5. Delete SMS (CRUD: Delete)
- **Endpoint**: `DELETE /api/sms/:id`

---

### 6. Create Custom Message (CRUD: Create)
- **Endpoint**: `POST /api/sms`
- **Payload**:
```json
{
  "sender": "Manual Entry",
  "phoneNumber": "+8801700000000",
  "body": "Cash transaction record",
  "category": "transaction",
  "notes": "Hand-to-hand payment"
}
```

---

### 7. Overview Statistics
- **Endpoint**: `GET /api/stats`
- **Response**:
```json
{
  "success": true,
  "data": {
    "totalMessages": 1250,
    "unreadCount": 42,
    "otpsCount": 85,
    "categories": {
      "banking": 310,
      "otp": 85,
      "personal": 520,
      "promotional": 335
    },
    "devicesCount": 1,
    "lastSync": 1729781000000
  }
}
```

---

### 8. Download JSON Backup
- **Endpoint**: `GET /api/export`
- Triggers browser download of `sms_backup_<timestamp>.json`.
