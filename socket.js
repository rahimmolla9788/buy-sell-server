const { Server } = require('socket.io');

function canonicalPhone(phone) {
  if (!phone) return '';
  const trimmed = String(phone).trim();
  if (trimmed.toLowerCase() === 'super-admin') return 'super-admin';
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return trimmed;
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

class SocketService {
  constructor() {
    this.io = null;
    // Map: canonical phone -> Set of socket.ids
    this.onlineUsers = new Map();
    // Map: socket.id -> canonical phone
    this.socketToPhone = new Map();
  }

  /**
   * Initialize Socket.IO with HTTP server
   */
  init(httpServer) {
    this.io = new Server(httpServer, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST'],
      },
      transports: ['websocket', 'polling'],
      pingTimeout: 30000,
      pingInterval: 10000,
    });

    this.io.on('connection', (socket) => {
      // Client joins a specific payment session room
      socket.on('join-session', (sessionId) => {
        if (sessionId) {
          socket.join(`session_${sessionId}`);
        }
      });

      // Client leaves session room
      socket.on('leave-session', (sessionId) => {
        if (sessionId) {
          socket.leave(`session_${sessionId}`);
        }
      });

      // User joins personal room for real-time status updates and presence tracking
      const registerUserPresence = async (phoneNumber) => {
        if (!phoneNumber) return;
        const clean = canonicalPhone(phoneNumber);
        if (!clean) return;

        socket.userPhone = clean;
        this.socketToPhone.set(socket.id, clean);

        let userSockets = this.onlineUsers.get(clean);
        const wasOffline = !userSockets || userSockets.size === 0;

        if (!userSockets) {
          userSockets = new Set();
          this.onlineUsers.set(clean, userSockets);
        }
        userSockets.add(socket.id);

        socket.join(`user_${clean}`);

        const now = Date.now();
        if (wasOffline) {
          this.emitUserPresence({
            phoneNumber: clean,
            isOnline: true,
            lastActiveAt: now,
            onlineCount: this.onlineUsers.size,
          });
        }

        try {
          const db = require('./database');
          await db.setUserPresence(clean, { isOnline: true, lastActiveAt: now });
        } catch (e) {}
      };

      socket.on('join-user', registerUserPresence);
      socket.on('user-presence', registerUserPresence);
      socket.on('user-heartbeat', registerUserPresence);

      // Admin panel joins dashboard room
      socket.on('join-admin', () => {
        socket.join('admin_dashboard');
        // Immediately send online count
        socket.emit('admin-presence-snapshot', {
          onlineCount: this.onlineUsers.size,
          onlineUsers: Array.from(this.onlineUsers.keys()),
        });
      });

      // Handle disconnect
      socket.on('disconnect', async () => {
        const clean = this.socketToPhone.get(socket.id);
        if (clean) {
          this.socketToPhone.delete(socket.id);
          const userSockets = this.onlineUsers.get(clean);
          if (userSockets) {
            userSockets.delete(socket.id);
            if (userSockets.size === 0) {
              this.onlineUsers.delete(clean);
              const now = Date.now();
              this.emitUserPresence({
                phoneNumber: clean,
                isOnline: false,
                lastActiveAt: now,
                onlineCount: this.onlineUsers.size,
              });

              try {
                const db = require('./database');
                await db.setUserPresence(clean, { isOnline: false, lastActiveAt: now });
              } catch (e) {}
            }
          }
        }
      });
    });

    console.log('[Socket.IO] Real-time WebSocket server initialized with User Presence tracking!');
    return this.io;
  }

  getIO() {
    return this.io;
  }

  /**
   * Check if a specific user phone number is currently online
   */
  isUserOnline(phoneNumber) {
    if (!phoneNumber) return false;
    const clean = canonicalPhone(phoneNumber);
    const userSockets = this.onlineUsers.get(clean);
    return Boolean(userSockets && userSockets.size > 0);
  }

  /**
   * Total currently online users
   */
  getOnlineUserCount() {
    return this.onlineUsers.size;
  }

  /**
   * Broadcast real-time user online/offline status change
   */
  emitUserPresence(payload) {
    if (!this.io || !payload) return;
    try {
      this.io.to('admin_dashboard').emit('user-presence-changed', payload);
      this.io.emit('user-presence-changed', payload);
    } catch (err) {
      console.warn('[Socket.IO] Failed to emit user-presence-changed:', err.message);
    }
  }

  /**
   * Broadcast an updated payment session to client and admin
   */
  emitPaymentSessionUpdate(session) {
    if (!this.io || !session) return;
    try {
      if (session.sessionId) {
        this.io.to(`session_${session.sessionId}`).emit('payment-session-updated', session);
      }
      this.io.to('admin_dashboard').emit('payment-session-updated', session);
      this.io.emit('payment-session-updated', session);
    } catch (err) {
      console.warn('[Socket.IO] Failed to emit payment-session-updated:', err.message);
    }
  }

  /**
   * Broadcast updated active orders list to admin dashboard
   */
  emitLiveOrdersUpdate(orders) {
    if (!this.io) return;
    try {
      this.io.to('admin_dashboard').emit('live-orders-updated', orders);
      this.io.emit('live-orders-updated', orders);
    } catch (err) {
      console.warn('[Socket.IO] Failed to emit live-orders-updated:', err.message);
    }
  }

  /**
   * Broadcast a new incoming SMS or batch sync
   */
  emitNewSms(message) {
    if (!this.io) return;
    try {
      this.io.emit('new-sms', message);
      this.io.emit('messages-updated');
    } catch (err) {
      console.warn('[Socket.IO] Failed to emit new-sms:', err.message);
    }
  }

  /**
   * Broadcast user status change (block / unblock / profile update)
   */
  emitUserStatusChange(payload) {
    if (!this.io || !payload) return;
    try {
      if (payload.phoneNumber) {
        this.io.to(`user_${payload.phoneNumber}`).emit('user-status-changed', payload);
      }
      this.io.emit('user-status-changed', payload);
    } catch (err) {
      console.warn('[Socket.IO] Failed to emit user-status-changed:', err.message);
    }
  }
}

module.exports = new SocketService();
