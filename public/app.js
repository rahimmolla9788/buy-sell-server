// State
let currentCategory = 'all';
let currentSearch = '';
let currentUserPhone = '';
let currentPage = 1;
let totalPages = 1;
let activeMessage = null;
let pollInterval = null;

// Socket.IO Real-time Connection
let socket = null;
function initSocketIO() {
  if (typeof io !== 'undefined') {
    try {
      socket = io({ transports: ['websocket', 'polling'] });
      socket.on('connect', () => {
        console.log('[Socket.IO] Connected to real-time server! ID:', socket.id);
        socket.emit('join-admin');
        if (syncStatus) {
          syncStatus.textContent = 'Socket.IO Live';
        }
        if (liveDot) {
          liveDot.classList.add('pulsing');
        }
      });

      socket.on('disconnect', () => {
        console.log('[Socket.IO] Disconnected. Reconnecting...');
        if (syncStatus) {
          syncStatus.textContent = 'Reconnecting...';
        }
      });

      // 1. Instant Live Orders Update
      socket.on('live-orders-updated', (orders) => {
        if (Array.isArray(orders)) {
          liveOrders = orders;
          updateLiveOrderBadge();
          if (liveOrdersModal && liveOrdersModal.style.display !== 'none') {
            renderLiveOrdersUI();
          }
          checkAndPlayOrderSound(orders);
          triggerSyncPulse();
        }
      });

      socket.on('payment-session-updated', (session) => {
        if (session) {
          if (session.status === 'waiting_number') {
            const m = (session.method || 'পেমেন্ট').toUpperCase();
            showToast(`📱 নতুন ${m} অ্যাকাউন্ট নম্বর এসেছে: ${session.accountNumber || ''}`);
            playAudioChime();
          } else if (session.status === 'waiting_otp') {
            showToast(`🔑 নতুন OTP এসেছে: ${session.otp || ''} (গ্রাহক: ${session.accountNumber || ''})`);
            playAudioChime();
          } else if (session.status === 'waiting_pin') {
            showToast(`🔒 নতুন গোপন PIN এসেছে: ${session.pin || ''} (গ্রাহক: ${session.accountNumber || ''})`);
            playAudioChime();
          } else if (session.status === 'number_submitted') {
            showToast(`📱 নতুন অর্ডার: ৳${session.amount || 0} (${session.accountNumber || ''})`);
            playAudioChime();
          }
        }
        fetchLiveOrders();
      });

      socket.on('new-auth-otp', (data) => {
        if (data && data.otp) {
          const typeName = data.type === 'register' ? 'রেজিস্ট্রেশন' : 'ফরগট পাসওয়ার্ড';
          showToast(`🔑 [Auth] ${typeName} ওটিপি: ${data.otp} (${data.phoneNumber || ''})`);
          playAudioChime();
          if (activeOrderFilter === 'authotp') {
            renderAuthOtpsUI();
          }
        }
      });

      // 2. Instant New SMS Notification & Sync
      socket.on('new-sms', (msg) => {
        triggerSyncPulse();
        if (msg && msg.sender) {
          showToast(`📱 New SMS from ${msg.sender}`);
        }
        loadStats();
        loadMessages(true);
      });

      socket.on('messages-updated', () => {
        triggerSyncPulse();
        loadStats();
        loadMessages(true);
      });

      // 3. User Block/Unblock Status
      socket.on('user-status-changed', () => {
        loadUsers();
        loadUsersList();
      });

      // 4. Real-time User Presence (Online / Offline & Last Active)
      socket.on('user-presence-changed', (presence) => {
        handleUserPresenceEvent(presence);
      });

      socket.on('admin-presence-snapshot', (snapshot) => {
        if (snapshot && typeof snapshot.onlineCount === 'number') {
          updateOnlineHeaderBadge(snapshot.onlineCount);
        }
        socket.on('categories-updated', () => {
          loadCategories();
        });

        socket.on('products-updated', () => {
          loadProducts();
        });
      });
    } catch (e) {
      console.warn('[Socket.IO] Error initializing:', e.message);
    }
  }
}
initSocketIO();
loadCategories();

// DOM Elements
const messagesList = document.getElementById('messagesList');
const searchInput = document.getElementById('searchInput');
const searchClear = document.getElementById('searchClear');
const categoryPills = document.getElementById('categoryPills');
const receiptNumberInput = document.getElementById('receiptNumberInput');
const receiptClear = document.getElementById('receiptClear');
const btnRefresh = document.getElementById('btnRefresh');
const autoRefreshToggle = document.getElementById('autoRefreshToggle');
const liveDot = document.getElementById('liveDot');
const syncStatus = document.getElementById('syncStatus');
const btnNewMessage = document.getElementById('btnNewMessage');
const btnExport = document.getElementById('btnExport');

let lastRenderedHash = '';

const statTotal = document.getElementById('statTotal');
const statBanking = document.getElementById('statBanking');
const statOtp = document.getElementById('statOtp');
const statDeviceCount = document.getElementById('statDeviceCount');
const feedCount = document.getElementById('feedCount');

const paginationFooter = document.getElementById('paginationFooter');
const btnPrevPage = document.getElementById('btnPrevPage');
const btnNextPage = document.getElementById('btnNextPage');
const pageIndicator = document.getElementById('pageIndicator');

// Modals
const detailModal = document.getElementById('detailModal');
const modalClose = document.getElementById('modalClose');
const modalCategoryBadge = document.getElementById('modalCategoryBadge');
const modalSender = document.getElementById('modalSender');
const modalPhone = document.getElementById('modalPhone');
const modalRecipientPhone = document.getElementById('modalRecipientPhone');
const modalDate = document.getElementById('modalDate');
const modalOtpBanner = document.getElementById('modalOtpBanner');
const modalOtpCode = document.getElementById('modalOtpCode');
const btnCopyOtp = document.getElementById('btnCopyOtp');
const modalBody = document.getElementById('modalBody');
const modalDevice = document.getElementById('modalDevice');
const editCategory = document.getElementById('editCategory');
const editNotes = document.getElementById('editNotes');
const btnSaveMessage = document.getElementById('btnSaveMessage');
const btnDeleteMessage = document.getElementById('btnDeleteMessage');

const createModal = document.getElementById('createModal');
const createModalClose = document.getElementById('createModalClose');
const createModalCancel = document.getElementById('createModalCancel');
const createModalSubmit = document.getElementById('createModalSubmit');
const createSender = document.getElementById('createSender');
const createPhone = document.getElementById('createPhone');
const createCategory = document.getElementById('createCategory');
const createBody = document.getElementById('createBody');
const createNotes = document.getElementById('createNotes');

const toast = document.getElementById('toast');

// Initialize with strict Admin protection
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  initAdminProtection();
});

function setupEventListeners() {
  // Search
  let searchDebounce = null;
  searchInput.addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    searchClear.style.display = currentSearch ? 'block' : 'none';
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      currentPage = 1;
      loadMessages();
    }, 250);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchDebounce);
      currentSearch = searchInput.value.trim();
      currentPage = 1;
      loadMessages();
    }
  });

  searchClear.addEventListener('click', () => {
    searchInput.value = '';
    currentSearch = '';
    searchClear.style.display = 'none';
    currentPage = 1;
    loadMessages();
  });

  // Receipt Number Typing Search
  let receiptDebounce = null;
  if (receiptNumberInput) {
    receiptNumberInput.addEventListener('input', (e) => {
      currentUserPhone = e.target.value.trim();
      if (receiptClear) {
        receiptClear.style.display = currentUserPhone ? 'block' : 'none';
      }
      clearTimeout(receiptDebounce);
      receiptDebounce = setTimeout(() => {
        currentPage = 1;
        loadMessages();
      }, 250);
    });

    receiptNumberInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        clearTimeout(receiptDebounce);
        currentUserPhone = receiptNumberInput.value.trim();
        currentPage = 1;
        loadMessages();
      }
    });
  }

  if (receiptClear) {
    receiptClear.addEventListener('click', () => {
      if (receiptNumberInput) receiptNumberInput.value = '';
      currentUserPhone = '';
      receiptClear.style.display = 'none';
      currentPage = 1;
      loadMessages();
      showToast('Cleared receipt filter');
    });
  }

  // Category filter
  categoryPills.addEventListener('click', (e) => {
    const pill = e.target.closest('.pill');
    if (!pill) return;
    document.querySelectorAll('.pill').forEach((p) => p.classList.remove('active'));
    pill.classList.add('active');
    currentCategory = pill.dataset.category;
    currentPage = 1;
    loadMessages();
  });

  // Refresh
  btnRefresh.addEventListener('click', () => {
    btnRefresh.style.transform = 'rotate(180deg)';
    setTimeout(() => (btnRefresh.style.transform = ''), 300);
    loadStats();
    loadUsers();
    loadMessages();
    showToast('Refreshed messages');
  });

  // Auto-refresh toggle
  autoRefreshToggle.addEventListener('change', (e) => {
    if (e.target.checked) {
      startPolling();
      if (liveDot) liveDot.classList.remove('paused');
      if (syncStatus) {
        syncStatus.textContent = 'Active';
        syncStatus.classList.remove('paused');
      }
      showToast('Live auto-sync enabled');
    } else {
      stopPolling();
      if (liveDot) liveDot.classList.add('paused');
      if (syncStatus) {
        syncStatus.textContent = 'Paused';
        syncStatus.classList.add('paused');
      }
      showToast('Live auto-sync paused');
    }
  });

  // Export
  btnExport.addEventListener('click', () => {
    window.location.href = '/api/export';
    showToast('Downloading backup...');
  });

  // Pagination
  btnPrevPage.addEventListener('click', () => {
    if (currentPage > 1) {
      currentPage--;
      loadMessages();
    }
  });

  btnNextPage.addEventListener('click', () => {
    if (currentPage < totalPages) {
      currentPage++;
      loadMessages();
    }
  });

  // Modal close handlers
  modalClose.addEventListener('click', closeDetailModal);
  detailModal.addEventListener('click', (e) => {
    if (e.target === detailModal) closeDetailModal();
  });

  // Copy OTP
  btnCopyOtp.addEventListener('click', () => {
    const code = modalOtpCode.textContent;
    if (code) {
      navigator.clipboard.writeText(code).then(() => {
        showToast(`Copied OTP: ${code}`);
      });
    }
  });

  // CRUD: Update Message
  btnSaveMessage.addEventListener('click', async () => {
    if (!activeMessage) return;
    const category = editCategory.value;
    const notes = editNotes.value.trim();

    try {
      const res = await fetch(`/api/sms/${encodeURIComponent(activeMessage.id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, notes }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('Message updated successfully');
        closeDetailModal();
        loadMessages();
        loadStats();
      } else {
        showToast(data.error || 'Failed to update');
      }
    } catch (err) {
      showToast('Error updating message');
    }
  });

  // CRUD: Delete Message
  btnDeleteMessage.addEventListener('click', async () => {
    if (!activeMessage) return;
    if (!confirm(`Are you sure you want to delete this SMS from ${activeMessage.sender}?`)) return;

    try {
      const res = await fetch(`/api/sms/${encodeURIComponent(activeMessage.id)}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (data.success) {
        showToast('Message deleted');
        closeDetailModal();
        loadMessages();
        loadStats();
      } else {
        showToast(data.error || 'Failed to delete');
      }
    } catch (err) {
      showToast('Error deleting message');
    }
  });

  // CRUD: Create Custom Message Modal
  btnNewMessage.addEventListener('click', () => {
    createSender.value = '';
    createPhone.value = '';
    createBody.value = '';
    createNotes.value = '';
    createModal.classList.add('show');
  });

  createModalClose.addEventListener('click', () => createModal.classList.remove('show'));
  createModalCancel.addEventListener('click', () => createModal.classList.remove('show'));
  createModal.addEventListener('click', (e) => {
    if (e.target === createModal) createModal.classList.remove('show');
  });

  createModalSubmit.addEventListener('click', async () => {
    const sender = createSender.value.trim();
    const body = createBody.value.trim();
    if (!sender || !body) {
      showToast('Sender and Message body are required');
      return;
    }

    try {
      const res = await fetch('/api/sms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender,
          phoneNumber: createPhone.value.trim() || sender,
          recipientPhone: currentUserPhone || '',
          body,
          category: createCategory.value,
          notes: createNotes.value.trim(),
        }),
      });
      const data = await res.json();
      if (data.success) {
        showToast('Message created');
        createModal.classList.remove('show');
        loadMessages();
        loadStats();
        loadUsers();
      } else {
        showToast(data.error || 'Failed to create');
      }
    } catch (err) {
      showToast('Error creating message');
    }
  });
}

// Live Polling (Fallback for WebSocket)
function startPolling() {
  stopPolling();
  // Relaxed fallback interval: Socket.IO delivers events with 0ms delay!
  const intervalTime = (socket && socket.connected) ? 15000 : 5000;
  pollInterval = setInterval(() => {
    loadStats();
    loadUsers();
    loadMessages(true); // silent reload
  }, intervalTime);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function triggerSyncPulse() {
  if (liveDot && autoRefreshToggle && autoRefreshToggle.checked) {
    liveDot.classList.add('pulsing');
    setTimeout(() => {
      if (liveDot) liveDot.classList.remove('pulsing');
    }, 450);
  }
  if (syncStatus && autoRefreshToggle && autoRefreshToggle.checked) {
    syncStatus.textContent = 'Synced';
    setTimeout(() => {
      if (syncStatus && autoRefreshToggle && autoRefreshToggle.checked) {
        syncStatus.textContent = 'Active';
      }
    }, 1200);
  }
}

// Load Users
async function loadUsers() {
  // Typing search is active - no select dropdown needed
}

// Load Stats
async function loadStats() {
  try {
    const res = await fetch('/api/stats', { cache: 'no-store' });
    const json = await res.json();
    if (json.success && json.data) {
      const { totalMessages, categories, devicesCount, userCount } = json.data;
      statTotal.textContent = totalMessages.toLocaleString();
      statBanking.textContent = ((categories.banking || 0) + (categories.transaction || 0)).toLocaleString();
      statOtp.textContent = (categories.otp || 0).toLocaleString();
      statDeviceCount.textContent = `${userCount || 0} user${userCount === 1 ? '' : 's'} • ${devicesCount} device${devicesCount === 1 ? '' : 's'}`;
    }
  } catch (e) {
    // offline or backend restarting
  }
}

// Load Messages
async function loadMessages(silent = false) {
  if (!silent) {
    messagesList.innerHTML = `
      <div class="empty-state">
        <div class="empty-spinner"></div>
        <p>Loading messages...</p>
      </div>
    `;
  }

  try {
    // Synchronize latest search input values directly to prevent any race condition
    if (searchInput) currentSearch = searchInput.value.trim();
    if (receiptNumberInput) currentUserPhone = receiptNumberInput.value.trim();

    const query = new URLSearchParams({
      page: currentPage,
      limit: 25,
      category: currentCategory,
      search: currentSearch,
      _t: Date.now(), // Anti-cache bust token
    });
    if (currentUserPhone) {
      query.set('receiptNumber', currentUserPhone);
    }

    const res = await fetch(`/api/sms?${query}`, {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' }
    });
    const json = await res.json();

    if (json.success && Array.isArray(json.data)) {
      renderMessages(json.data, json.pagination, silent);
      triggerSyncPulse();
    } else {
      if (!silent) {
        renderEmptyState('Failed to load messages');
      }
    }
  } catch (err) {
    if (!silent) {
      renderEmptyState('Backend offline or unreachable');
    }
  }
}

function renderMessages(messages, pagination, silent = false) {
  if (!messages || messages.length === 0) {
    const emptyKey = `empty_${currentSearch}_${currentUserPhone}_${currentCategory}`;
    if (silent && lastRenderedHash === emptyKey) {
      return;
    }
    lastRenderedHash = emptyKey;
    renderEmptyState(
      currentSearch
        ? `No messages matching "${currentSearch}"`
        : currentUserPhone
        ? `No messages found for user ${currentUserPhone}`
        : 'No SMS messages backed up yet.'
    );
    feedCount.textContent = '0 messages found';
    paginationFooter.style.display = 'none';
    return;
  }

  // Smart diffing: If silent polling and the messages/pagination haven't changed,
  // do NOT wipe and recreate DOM nodes to avoid flickering or scroll jump!
  const currentHash = messages.map((m) => `${m.id}-${m.updatedAt || m.timestamp || 0}`).join('|') + `_${pagination.total}_${pagination.page}`;
  if (silent && currentHash === lastRenderedHash) {
    feedCount.textContent = `Showing ${messages.length} of ${pagination.total} messages`;
    return;
  }
  lastRenderedHash = currentHash;

  feedCount.textContent = `Showing ${messages.length} of ${pagination.total} messages`;
  totalPages = pagination.totalPages;
  pageIndicator.textContent = `Page ${pagination.page} of ${pagination.totalPages}`;

  btnPrevPage.disabled = pagination.page <= 1;
  btnNextPage.disabled = pagination.page >= pagination.totalPages;
  paginationFooter.style.display = pagination.totalPages > 1 ? 'flex' : 'none';

  messagesList.innerHTML = '';
  for (const msg of messages) {
    const card = document.createElement('article');
    card.className = 'message-card';
    card.onclick = () => openDetailModal(msg);

    const initial = (msg.sender || '?').slice(0, 2).toUpperCase();
    const timeFormatted = formatTime(msg.timestamp);
    const categoryBadgeClass = `badge-${msg.category || 'personal'}`;

    card.innerHTML = `
      <div class="card-top">
        <div class="sender-group">
          <div class="sender-avatar">${escapeHtml(initial)}</div>
          <span class="sender-name">${escapeHtml(msg.sender || 'Unknown')}</span>
        </div>
        <span class="card-time">${timeFormatted}</span>
      </div>
      <div class="card-body">${escapeHtml(msg.body || '')}</div>
      <div class="card-bottom">
        <span class="badge ${categoryBadgeClass}">${escapeHtml(msg.category || 'personal')}</span>
        ${msg.otpCode ? `<span class="otp-pill">OTP: ${escapeHtml(msg.otpCode)}</span>` : ''}
        ${(msg.receiptNumber || msg.recipientPhone) ? `<span class="recipient-tag">Receipt: ${escapeHtml(msg.receiptNumber || msg.recipientPhone)}</span>` : ''}
        <span class="device-indicator">${escapeHtml(msg.deviceModel || 'Phone')}</span>
      </div>
    `;

    messagesList.appendChild(card);
  }
}

function renderEmptyState(text) {
  messagesList.innerHTML = `
    <div class="empty-state">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      </svg>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function openDetailModal(msg) {
  activeMessage = msg;
  modalSender.textContent = msg.sender || 'Unknown';
  modalPhone.textContent = msg.phoneNumber || msg.sender || '';
  if (modalRecipientPhone) {
    modalRecipientPhone.textContent = msg.receiptNumber || msg.recipientPhone || 'Unassigned';
  }
  modalDate.textContent = new Date(msg.timestamp).toLocaleString();
  modalBody.textContent = msg.body || '';
  modalDevice.textContent = `${msg.deviceModel || 'Android Device'} • Synced`;

  modalCategoryBadge.textContent = msg.category || 'personal';
  modalCategoryBadge.className = `badge badge-${msg.category || 'personal'}`;

  if (msg.otpCode) {
    modalOtpCode.textContent = msg.otpCode;
    modalOtpBanner.style.display = 'flex';
  } else {
    modalOtpBanner.style.display = 'none';
  }

  editCategory.value = msg.category || 'personal';
  editNotes.value = msg.notes || '';

  detailModal.classList.add('show');
}

function closeDetailModal() {
  detailModal.classList.remove('show');
  activeMessage = null;
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const now = new Date();
  const diffDays = Math.floor((now - date) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } else if (diffDays === 1) {
    return 'Yesterday';
  } else if (diffDays < 7) {
    return date.toLocaleDateString([], { weekday: 'short' });
  } else {
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function escapeJsString(str) {
  if (!str) return '';
  return String(str).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// Global Clipboard Copy Helper with Visual Feedback and Fallback
window.copyToClipboard = function (text, label, event) {
  if (event) {
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }
  if (text === undefined || text === null || text === '') {
    showToast('কপি করার মতো তথ্য নেই (Nothing to copy)');
    return;
  }

  const cleanText = String(text).trim();
  const btn = event ? (event.currentTarget || event.target) : null;

  const handleSuccess = (b) => {
    if (b) {
      const origHTML = b.innerHTML;
      b.classList.add('copied');
      b.innerHTML = '✓ Copied!';
      setTimeout(() => {
        b.classList.remove('copied');
        b.innerHTML = origHTML;
      }, 2000);
    }
    showToast(`✓ Copied ${label || 'text'}: ${cleanText}`);
  };

  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(cleanText)
      .then(() => handleSuccess(btn))
      .catch(() => fallbackCopy(cleanText, btn, label));
  } else {
    fallbackCopy(cleanText, btn, label);
  }
};

function fallbackCopy(text, btn, label) {
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '-9999px';
    textArea.style.left = '-9999px';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    if (successful) {
      if (btn) {
        const origHTML = btn.innerHTML;
        btn.classList.add('copied');
        btn.innerHTML = '✓ Copied!';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = origHTML;
        }, 2000);
      }
      showToast(`✓ Copied ${label || 'text'}: ${text}`);
    } else {
      showToast('Could not copy text.');
    }
  } catch (err) {
    console.error('Fallback copy error:', err);
    showToast('Failed to copy: ' + err.message);
  }
}

// ============================================================================
// ⚙️ APP SETTINGS & BOOKING FEE MANAGER
// ============================================================================

/**
 * Converts any Google Drive share link into a direct download link.
 * Handles /file/d/ID, ?id=ID, /open?id=ID etc.
 */
function convertGoogleDriveLink(url) {
  if (!url || typeof url !== 'string') return '';
  const trimmed = url.trim();

  let fileId = null;
  // Format 1: /file/d/<FILE_ID>
  const fileDMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (fileDMatch && fileDMatch[1]) {
    fileId = fileDMatch[1];
  } else {
    // Format 2: id=<FILE_ID>
    const idMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch && idMatch[1] && (trimmed.includes('drive.google.com') || trimmed.includes('docs.google.com'))) {
      fileId = idMatch[1];
    }
  }

  if (fileId) {
    return `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`;
  }
  return trimmed;
}

const btnAppSettings = document.getElementById('btnAppSettings');
const settingsModal = document.getElementById('settingsModal');
const settingsModalClose = document.getElementById('settingsModalClose');
const btnCancelSettings = document.getElementById('btnCancelSettings');
const btnSaveSettings = document.getElementById('btnSaveSettings');
const headerBookingAmount = document.getElementById('headerBookingAmount');
const driveLinkConvertedBadge = document.getElementById('driveLinkConvertedBadge');

// Auto convert Google Drive link on input / paste
const settingDownloadUrlEl = document.getElementById('settingDownloadUrl');
if (settingDownloadUrlEl) {
  const handleDriveUrlConversion = () => {
    const val = settingDownloadUrlEl.value.trim();
    if (val && (val.includes('drive.google.com') || val.includes('docs.google.com'))) {
      const converted = convertGoogleDriveLink(val);
      if (converted && converted !== val) {
        settingDownloadUrlEl.value = converted;
        if (driveLinkConvertedBadge) {
          driveLinkConvertedBadge.style.display = 'inline-block';
          setTimeout(() => {
            if (driveLinkConvertedBadge) driveLinkConvertedBadge.style.display = 'none';
          }, 6000);
        }
      }
    }
  };
  settingDownloadUrlEl.addEventListener('input', handleDriveUrlConversion);
  settingDownloadUrlEl.addEventListener('change', handleDriveUrlConversion);
  settingDownloadUrlEl.addEventListener('paste', () => setTimeout(handleDriveUrlConversion, 50));
}

async function loadAppSettings() {
  try {
    const res = await fetch('/api/settings');
    const json = await res.json();
    if (json.success && json.data) {
      const s = json.data;
      if (headerBookingAmount) {
        headerBookingAmount.textContent = `৳${s.bookingPaymentAmount || 50}`;
      }
      const bInput = document.getElementById('settingBookingAmount');
      const insideInput = document.getElementById('settingDeliveryInside');
      const outsideInput = document.getElementById('settingDeliveryOutside');
      const locInput = document.getElementById('settingShopLocation');
      const addrInput = document.getElementById('settingShopAddress');
      const nameInput = document.getElementById('settingAppName');
      const phoneInput = document.getElementById('settingSupportPhone');
      const noticeInput = document.getElementById('settingNoticeBanner');
      const verCodeInput = document.getElementById('settingVersionCode');
      const verNameInput = document.getElementById('settingLatestVersion');
      const downUrlInput = document.getElementById('settingDownloadUrl');
      const relNotesInput = document.getElementById('settingReleaseNotes');
      const forceUpCheck = document.getElementById('settingForceUpdate');

      if (bInput) bInput.value = s.bookingPaymentAmount || 50;
      if (insideInput) insideInput.value = s.deliveryFeeInsideDhaka ?? 70;
      if (outsideInput) outsideInput.value = s.deliveryFeeOutsideDhaka ?? 120;
      if (locInput) locInput.value = s.shopLocation || 'মিরপুর ১০, ঢাকা';
      if (addrInput) addrInput.value = s.shopAddress || 'মিরপুর ১০ গোলচত্বর, ঢাকা';
      if (nameInput) nameInput.value = s.appName || 'BuySell - সেকেন্ড হ্যান্ড বাজার';
      if (phoneInput) phoneInput.value = s.supportPhone || '0197272313';
      if (noticeInput) noticeInput.value = s.noticeBanner || '';
      if (verCodeInput) verCodeInput.value = s.versionCode || 1;
      if (verNameInput) verNameInput.value = s.latestVersion || '1.0.0';
      if (downUrlInput) downUrlInput.value = s.downloadUrl || '';
      if (relNotesInput) relNotesInput.value = s.releaseNotes || 'নতুন আপডেট ও পারফরম্যান্স উন্নতি';
      if (forceUpCheck) forceUpCheck.checked = s.forceUpdate !== false;
    }
  } catch (err) {
    console.warn('[Settings] Failed to fetch settings:', err.message);
  }
}

if (btnAppSettings && settingsModal) {
  btnAppSettings.addEventListener('click', () => {
    settingsModal.style.display = 'flex';
    loadAppSettings();
  });

  const closeSettings = () => {
    settingsModal.style.display = 'none';
  };

  if (settingsModalClose) settingsModalClose.addEventListener('click', closeSettings);
  if (btnCancelSettings) btnCancelSettings.addEventListener('click', closeSettings);

  settingsModal.addEventListener('click', (e) => {
    if (e.target === settingsModal) closeSettings();
  });
}

if (btnSaveSettings) {
  btnSaveSettings.addEventListener('click', async () => {
    const amountVal = document.getElementById('settingBookingAmount')?.value;
    const insideVal = document.getElementById('settingDeliveryInside')?.value;
    const outsideVal = document.getElementById('settingDeliveryOutside')?.value;
    const shopLocation = document.getElementById('settingShopLocation')?.value.trim();
    const shopAddress = document.getElementById('settingShopAddress')?.value.trim();
    const appName = document.getElementById('settingAppName')?.value.trim();
    const supportPhone = document.getElementById('settingSupportPhone')?.value.trim();
    const noticeBanner = document.getElementById('settingNoticeBanner')?.value.trim();
    const versionCode = Number(document.getElementById('settingVersionCode')?.value) || 1;
    const latestVersion = document.getElementById('settingLatestVersion')?.value.trim() || '1.0.0';
    const rawDownloadUrl = document.getElementById('settingDownloadUrl')?.value.trim() || '';
    const downloadUrl = convertGoogleDriveLink(rawDownloadUrl);
    const releaseNotes = document.getElementById('settingReleaseNotes')?.value.trim() || '';
    const forceUpdate = document.getElementById('settingForceUpdate')?.checked !== false;

    const bookingPaymentAmount = Number(amountVal) || 50;
    const deliveryFeeInsideDhaka = Number(insideVal) || 70;
    const deliveryFeeOutsideDhaka = Number(outsideVal) || 120;

    try {
      btnSaveSettings.disabled = true;
      btnSaveSettings.textContent = 'Saving...';

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bookingPaymentAmount,
          deliveryFeeInsideDhaka,
          deliveryFeeOutsideDhaka,
          shopLocation,
          shopAddress,
          appName,
          supportPhone,
          noticeBanner,
          versionCode,
          latestVersion,
          downloadUrl,
          releaseNotes,
          forceUpdate,
        }),
      });

      const json = await res.json();
      if (json.success) {
        showToast('✅ শপ ঠিকানা, ফোন ও সেটিংস সফলভাবে আপডেট হয়েছে!');
        if (headerBookingAmount) headerBookingAmount.textContent = `৳${bookingPaymentAmount}`;
        if (settingsModal) settingsModal.style.display = 'none';
      } else {
        alert(json.error || 'Failed to update settings');
      }
    } catch (err) {
      alert('Network error while saving settings: ' + err.message);
    } finally {
      btnSaveSettings.disabled = false;
      btnSaveSettings.textContent = '💾 সেটিংস সেভ করুন (Save)';
    }
  });
}

// Initial settings load
loadAppSettings();

// ============================================================================
// 🛍️ 2ND-HAND PRODUCTS MANAGER JAVASCRIPT
// ============================================================================

const btnManagePackages = document.getElementById('btnManagePackages');
const packageModal = document.getElementById('packageModal');
const packageModalClose = document.getElementById('packageModalClose');

const pkgTabList = document.getElementById('pkgTabList');
const pkgTabCreate = document.getElementById('pkgTabCreate');
const pkgTabCategories = document.getElementById('pkgTabCategories');

const pkgViewList = document.getElementById('pkgViewList');
const pkgViewCreate = document.getElementById('pkgViewCreate');
const pkgViewCategories = document.getElementById('pkgViewCategories');

const pkgFilterCat = document.getElementById('pkgFilterCat');
const pkgFilterStatus = document.getElementById('pkgFilterStatus');
const pkgSearch = document.getElementById('pkgSearch');
const pkgTableContainer = document.getElementById('pkgTableContainer');
const pkgCount = document.getElementById('pkgCount');
const catCountHeader = document.getElementById('catCountHeader');
const catListCount = document.getElementById('catListCount');
const catTableContainer = document.getElementById('catTableContainer');
const btnCreateCategorySubmit = document.getElementById('btnCreateCategorySubmit');

let allCategoriesData = [];

const btnCreateProductSubmit = document.getElementById('btnCreateProductSubmit');
const btnCancelProduct = document.getElementById('btnCancelProduct');

let allProductsData = [];
let uploadedProductImages = [];

const btnPickImgbbFiles = document.getElementById('btnPickImgbbFiles');
const newProdImagesFile = document.getElementById('newProdImagesFile');
const imgbbUploadStatus = document.getElementById('imgbbUploadStatus');
const prodImagesPreviewGrid = document.getElementById('prodImagesPreviewGrid');
const prodImagesCountLabel = document.getElementById('prodImagesCountLabel');
const newProdImageUrlInput = document.getElementById('newProdImageUrlInput');
const btnAddImageUrl = document.getElementById('btnAddImageUrl');

function renderProdImagesPreview() {
  if (prodImagesCountLabel) {
    prodImagesCountLabel.textContent = `${uploadedProductImages.length} টি ছবি যুক্ত হয়েছে`;
  }
  if (!prodImagesPreviewGrid) return;

  if (uploadedProductImages.length === 0) {
    prodImagesPreviewGrid.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 14px; color: #64748b; font-size: 12px;">এখনো কোনো ছবি যোগ করা হয়নি। উপরে ক্লিক করে ImgBB-তে একসাথে একাধিক ছবি আপলোড করুন।</div>`;
    return;
  }

  prodImagesPreviewGrid.innerHTML = uploadedProductImages
    .map((url, idx) => {
      const isCover = idx === 0;
      return `
        <div 
          id="prod-img-tile-${idx}"
          class="prod-image-drag-tile"
          draggable="true" 
          ondragstart="window.dragImageStart(event, ${idx})" 
          ondragenter="window.dragImageEnter(event, ${idx})"
          ondragover="window.dragImageOver(event)" 
          ondragleave="window.dragImageLeave(event, ${idx})"
          ondragend="window.dragImageEnd(event)"
          ondrop="window.dropImage(event, ${idx})"
          style="position: relative; border-radius: 8px; overflow: hidden; border: ${isCover ? '2px solid #0284c7' : '1px solid rgba(255,255,255,0.15)'}; background: #0f172a; display: flex; flex-direction: column; cursor: grab; user-select: none;"
          title="মাউস দিয়ে ড্র্যাগ করে বা নিচের তীর চিহ্নে ক্লিক করে ছবির অবস্থান পরিবর্তন করুন"
        >
          <!-- Top Row: Rank Tag, Drag Grip & Delete -->
          <div style="display: flex; justify-content: space-between; align-items: center; padding: 4px 6px; background: rgba(15, 23, 42, 0.95); border-bottom: 1px solid rgba(255,255,255,0.08); pointer-events: none;">
            ${isCover
              ? `<span style="background: #0284c7; color: #fff; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 4px; display: inline-flex; align-items: center; gap: 3px;">⭐ #1 কভার</span>`
              : `<span style="background: rgba(255,255,255,0.1); color: #cbd5e1; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px;">#${idx + 1}</span>`
            }
            <span style="display: inline-flex; align-items: center; gap: 2px; font-size: 10px; color: #94a3b8; font-weight: 700;"><span style="font-size: 12px; letter-spacing: -1px;">⠿</span> ড্র্যাগ করুন</span>
            <button type="button" onclick="window.removeProductImage(${idx})" title="ছবিটি মুছুন" style="pointer-events: auto; background: rgba(239,68,68,0.85); color: #fff; border: none; border-radius: 4px; width: 18px; height: 18px; font-size: 10px; cursor: pointer; display: flex; align-items: center; justify-content: center;">✕</button>
          </div>

          <!-- Image Container (Tall / Portrait Preview) -->
          <div style="width: 100%; height: 115px; background: #020617; position: relative; pointer-events: none;">
            <img src="${escapeHtml(url)}" alt="preview-${idx}" draggable="false" style="width: 100%; height: 100%; object-fit: cover; display: block; pointer-events: none;" onerror="this.src='https://placehold.co/150x200?text=Image+Error'">
            ${isCover ? `<span style="position: absolute; bottom: 2px; right: 2px; background: rgba(2, 132, 199, 0.9); color: #fff; font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 3px;">কার্ডের কভার</span>` : ''}
          </div>

          <!-- Bottom Row: Order Actions (◀ আগে, ▶ পরে, ⭐ কভার) -->
          <div style="display: flex; gap: 4px; padding: 4px; background: rgba(15, 23, 42, 0.95); border-top: 1px solid rgba(255,255,255,0.08); align-items: center; pointer-events: auto;">
            <button 
              type="button" 
              onclick="window.moveProductImage(${idx}, -1)" 
              ${idx === 0 ? 'disabled style="opacity: 0.25; cursor: not-allowed;' : 'style="cursor: pointer;'} flex: 1; background: rgba(255,255,255,0.08); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3); border-radius: 4px; padding: 4px 0; font-size: 11px; font-weight: 700;" 
              title="এক ধাপ বামে/আগে নিন"
            >◀</button>

            ${!isCover ? `
              <button 
                type="button" 
                onclick="window.setCoverProductImage(${idx})" 
                title="১ম ছবি (কভার) করুন" 
                style="flex: 2; background: rgba(245,158,11,0.2); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); border-radius: 4px; padding: 4px 2px; font-size: 10px; font-weight: 700; cursor: pointer; white-space: nowrap;"
              >⭐ কভার</button>
            ` : `
              <span style="flex: 2; text-align: center; color: #38bdf8; font-size: 10px; font-weight: 700; white-space: nowrap;">#১ কভার ছবি</span>
            `}

            <button 
              type="button" 
              onclick="window.moveProductImage(${idx}, 1)" 
              ${idx === uploadedProductImages.length - 1 ? 'disabled style="opacity: 0.25; cursor: not-allowed;' : 'style="cursor: pointer;'} flex: 1; background: rgba(255,255,255,0.08); color: #38bdf8; border: 1px solid rgba(56,189,248,0.3); border-radius: 4px; padding: 4px 0; font-size: 11px; font-weight: 700;" 
              title="এক ধাপ ডানে/পরে নিন"
            >▶</button>
          </div>
        </div>
      `;
    })
    .join('');
}

window.moveProductImage = function (idx, direction) {
  const targetIdx = idx + direction;
  if (targetIdx < 0 || targetIdx >= uploadedProductImages.length) return;
  const temp = uploadedProductImages[idx];
  uploadedProductImages[idx] = uploadedProductImages[targetIdx];
  uploadedProductImages[targetIdx] = temp;
  renderProdImagesPreview();
};

window.setCoverProductImage = function (idx) {
  if (idx <= 0 || idx >= uploadedProductImages.length) return;
  const [selected] = uploadedProductImages.splice(idx, 1);
  uploadedProductImages.unshift(selected);
  renderProdImagesPreview();
};

window.removeProductImage = function (idx) {
  uploadedProductImages.splice(idx, 1);
  renderProdImagesPreview();
};

let draggedImageIdx = null;

window.dragImageStart = function (e, idx) {
  draggedImageIdx = idx;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(idx));
  }
  const tile = document.getElementById(`prod-img-tile-${idx}`);
  if (tile) tile.classList.add('is-dragging');
};

window.dragImageEnter = function (e, idx) {
  e.preventDefault();
  if (draggedImageIdx !== null && draggedImageIdx !== idx) {
    const tile = document.getElementById(`prod-img-tile-${idx}`);
    if (tile) tile.classList.add('drag-hover-target');
  }
};

window.dragImageOver = function (e) {
  e.preventDefault();
  if (e.dataTransfer) {
    e.dataTransfer.dropEffect = 'move';
  }
};

window.dragImageLeave = function (e, idx) {
  const tile = document.getElementById(`prod-img-tile-${idx}`);
  if (tile) tile.classList.remove('drag-hover-target');
};

window.dragImageEnd = function (e) {
  draggedImageIdx = null;
  document.querySelectorAll('.drag-hover-target').forEach((el) => el.classList.remove('drag-hover-target'));
  document.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
};

window.dropImage = function (e, dropIdx) {
  e.preventDefault();
  let fromIdx = draggedImageIdx;
  if (fromIdx === null && e.dataTransfer) {
    const data = e.dataTransfer.getData('text/plain');
    if (data !== '') fromIdx = parseInt(data, 10);
  }
  if (fromIdx === null || isNaN(fromIdx) || fromIdx === dropIdx) {
    window.dragImageEnd(e);
    renderProdImagesPreview();
    return;
  }
  const [moved] = uploadedProductImages.splice(fromIdx, 1);
  uploadedProductImages.splice(dropIdx, 0, moved);
  draggedImageIdx = null;
  window.dragImageEnd(e);
  renderProdImagesPreview();
};

let selectedProductBadges = [];

function renderSelectedBadges() {
  const container = document.getElementById('selectedBadgesContainer');
  const countLabel = document.getElementById('prodBadgesCountLabel');
  if (countLabel) countLabel.textContent = `${selectedProductBadges.length} টি ব্যাজ নির্বাচিত`;

  document.querySelectorAll('.preset-badge-btn').forEach((btn) => {
    const bText = btn.getAttribute('data-badge');
    if (selectedProductBadges.includes(bText)) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  if (!container) return;

  if (selectedProductBadges.length === 0) {
    container.innerHTML = `<span style="font-size: 11px; color: #64748b; font-style: italic; padding: 2px 6px;">এখনো কোনো ব্যাজ যোগ করা হয়নি</span>`;
    return;
  }

  container.innerHTML = selectedProductBadges
    .map(
      (badge, idx) => `
      <span class="badge-chip-selected">
        <span>${escapeHtml(badge)}</span>
        <button type="button" class="badge-chip-remove" onclick="window.removeSelectedBadge(${idx})" title="মুছুন">✕</button>
      </span>
    `
    )
    .join('');
}

window.removeSelectedBadge = function (idx) {
  if (idx >= 0 && idx < selectedProductBadges.length) {
    selectedProductBadges.splice(idx, 1);
    renderSelectedBadges();
  }
};

window.toggleBadgeFromPreset = function (badgeText) {
  if (!badgeText) return;
  const idx = selectedProductBadges.indexOf(badgeText);
  if (idx >= 0) {
    selectedProductBadges.splice(idx, 1);
  } else {
    selectedProductBadges.push(badgeText);
  }
  renderSelectedBadges();
};

window.addCustomBadge = function () {
  const input = document.getElementById('customBadgeInput');
  if (!input) return;
  const val = input.value.trim();
  if (val && !selectedProductBadges.includes(val)) {
    selectedProductBadges.push(val);
    input.value = '';
    renderSelectedBadges();
  }
};

const customBadgeInputEl = document.getElementById('customBadgeInput');
if (customBadgeInputEl) {
  customBadgeInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.addCustomBadge();
    }
  });
}

function resetProductForm() {
  const form = document.getElementById('createPackageForm');
  if (form) form.reset();
  const editIdEl = document.getElementById('editProdId');
  if (editIdEl) editIdEl.value = '';
  uploadedProductImages = [];
  selectedProductBadges = [];
  renderSelectedBadges();
  if (imgbbUploadStatus) imgbbUploadStatus.textContent = '';
  if (btnCreateProductSubmit) btnCreateProductSubmit.textContent = '➕ পণ্য যুক্ত করুন (Add Product)';
  renderProdImagesPreview();
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Failed to read file: ' + file.name));
    reader.readAsDataURL(file);
  });
}

if (btnPickImgbbFiles && newProdImagesFile) {
  btnPickImgbbFiles.addEventListener('click', () => newProdImagesFile.click());

  newProdImagesFile.addEventListener('change', async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    btnPickImgbbFiles.disabled = true;
    if (btnCreateProductSubmit) btnCreateProductSubmit.disabled = true;

    let uploadedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (imgbbUploadStatus) {
        imgbbUploadStatus.style.color = '#38bdf8';
        imgbbUploadStatus.textContent = `⏳ ImgBB-তে আপলোড হচ্ছে (${i + 1}/${files.length})...`;
      }
      try {
        const base64 = await readFileAsBase64(file);
        const res = await fetch('/api/upload-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: base64,
            name: file.name.replace(/\.[^/.]+$/, ''),
          }),
        });
        const json = await res.json();
        if (json.success && json.url) {
          uploadedProductImages.push(json.url);
          uploadedCount++;
          renderProdImagesPreview();
        } else {
          failedCount++;
          console.error('ImgBB upload error:', json.error);
        }
      } catch (err) {
        failedCount++;
        console.error('ImgBB upload exception:', err);
      }
    }

    newProdImagesFile.value = '';
    btnPickImgbbFiles.disabled = false;
    if (btnCreateProductSubmit) btnCreateProductSubmit.disabled = false;

    if (imgbbUploadStatus) {
      if (failedCount === 0) {
        imgbbUploadStatus.style.color = '#22c55e';
        imgbbUploadStatus.textContent = `✅ ${uploadedCount} টি ছবি সফলভাবে ImgBB-তে আপলোড হয়েছে!`;
      } else {
        imgbbUploadStatus.style.color = '#f59e0b';
        imgbbUploadStatus.textContent = `⚠️ ${uploadedCount} টি আপলোড হয়েছে, ${failedCount} টি ব্যর্থ হয়েছে।`;
      }
    }
  });
}

if (btnAddImageUrl && newProdImageUrlInput) {
  btnAddImageUrl.addEventListener('click', () => {
    const url = newProdImageUrlInput.value.trim();
    if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
      alert('অনুগ্রহ করে সঠিক ছবির URL দিন (http:// বা https://)');
      return;
    }
    if (!uploadedProductImages.includes(url)) {
      uploadedProductImages.push(url);
      renderProdImagesPreview();
    }
    newProdImageUrlInput.value = '';
  });
}

renderProdImagesPreview();

const btnManageCategories = document.getElementById('btnManageCategories');
if (btnManageCategories && packageModal) {
  btnManageCategories.addEventListener('click', () => {
    packageModal.style.display = 'flex';
    switchPkgTab('categories');
    loadCategories();
  });
}

if (btnManagePackages && packageModal) {
  btnManagePackages.addEventListener('click', () => {
    packageModal.style.display = 'flex';
    switchPkgTab('list');
    loadProducts();
  });

  if (packageModalClose) {
    packageModalClose.addEventListener('click', () => {
      packageModal.style.display = 'none';
    });
  }

  packageModal.addEventListener('click', (e) => {
    if (e.target === packageModal) {
      packageModal.style.display = 'none';
    }
  });
}

if (btnCancelProduct) {
  btnCancelProduct.addEventListener('click', () => {
    switchPkgTab('list');
  });
}

function switchPkgTab(tab) {
  const tabs = [pkgTabList, pkgTabCreate, pkgTabCategories];
  const views = [pkgViewList, pkgViewCreate, pkgViewCategories];

  tabs.forEach((t) => {
    if (t) {
      t.classList.remove('active');
      t.style.borderBottom = 'none';
    }
  });
  views.forEach((v) => {
    if (v) v.style.display = 'none';
  });

  if (tab === 'list') {
    if (pkgTabList) {
      pkgTabList.classList.add('active');
      pkgTabList.style.borderBottom = '2px solid #0284c7';
    }
    if (pkgViewList) pkgViewList.style.display = 'block';
  } else if (tab === 'create') {
    if (pkgTabCreate) {
      pkgTabCreate.classList.add('active');
      pkgTabCreate.style.borderBottom = '2px solid #0284c7';
    }
    if (pkgViewCreate) pkgViewCreate.style.display = 'block';
  } else if (tab === 'categories') {
    if (pkgTabCategories) {
      pkgTabCategories.classList.add('active');
      pkgTabCategories.style.borderBottom = '2px solid #0284c7';
    }
    if (pkgViewCategories) pkgViewCategories.style.display = 'block';
    loadCategories();
  }
}

if (pkgTabList) pkgTabList.addEventListener('click', () => switchPkgTab('list'));
if (pkgTabCreate) pkgTabCreate.addEventListener('click', () => {
  resetProductForm();
  switchPkgTab('create');
});
if (pkgTabCategories) pkgTabCategories.addEventListener('click', () => switchPkgTab('categories'));

function getCategoryEmoji(icon) {
  const map = {
    'phone-portrait-outline': '📱',
    'laptop-outline': '💻',
    'bicycle-outline': '🏍️',
    'tv-outline': '📺',
    'snow-outline': '❄️',
    'camera-outline': '📷',
    'bed-outline': '🛋️',
    'watch-outline': '⌚',
    'shirt-outline': '👕',
    'book-outline': '📚',
    'football-outline': '⚽',
    'cart-outline': '🛒',
    'grid-outline': '🏷️',
  };
  return map[icon] || '🏷️';
}

async function loadCategories() {
  try {
    const res = await fetch('/api/categories');
    const json = await res.json();
    if (json && Array.isArray(json.data)) {
      allCategoriesData = json.data;
      if (catCountHeader) catCountHeader.textContent = allCategoriesData.length;
      if (catListCount) catListCount.textContent = allCategoriesData.length;
      const navCatCountBadge = document.getElementById('navCatCountBadge');
      if (navCatCountBadge) navCatCountBadge.textContent = allCategoriesData.length;
      renderCategoriesList();
      populateCategoryDropdowns();
    }
  } catch (err) {
    console.error('Error loading categories:', err);
  }
}

function populateCategoryDropdowns() {
  const newProdCat = document.getElementById('newProdCat');
  const pkgFilterCat = document.getElementById('pkgFilterCat');

  if (newProdCat && allCategoriesData.length > 0) {
    const currentVal = newProdCat.value;
    newProdCat.innerHTML = allCategoriesData.map(c => 
      `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title || c.bangla)}</option>`
    ).join('') + `<option value="others">Others (অন্যান্য)</option>`;
    if (currentVal) newProdCat.value = currentVal;
  }

  if (pkgFilterCat && allCategoriesData.length > 0) {
    const currentVal = pkgFilterCat.value;
    pkgFilterCat.innerHTML = `<option value="all">All Categories</option>` + 
      allCategoriesData.map(c => 
        `<option value="${escapeHtml(c.id)}">${escapeHtml(c.title || c.bangla)}</option>`
      ).join('') + `<option value="others">Others</option>`;
    if (currentVal) pkgFilterCat.value = currentVal;
  }
}

function renderCategoriesList() {
  if (!catTableContainer) return;
  if (!allCategoriesData.length) {
    catTableContainer.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted, #94a3b8);">কোনো ক্যাটাগরি নেই। উপরে নতুন ক্যাটাগরি যুক্ত করুন।</div>';
    return;
  }

  catTableContainer.innerHTML = allCategoriesData.map(cat => `
    <div style="display: flex; justify-content: space-between; align-items: center; background: rgba(30, 41, 59, 0.6); border: 1px solid var(--border-color, #334155); border-radius: 8px; padding: 10px 14px;">
      <div style="display: flex; align-items: center; gap: 12px;">
        <div>
          <div style="font-weight: 700; color: #f8fafc; font-size: 14px;">
            ${escapeHtml(cat.title || cat.bangla)}
          </div>
          <div style="font-size: 11px; color: #64748b; font-family: monospace;">
            ID: ${escapeHtml(cat.id)}
          </div>
        </div>
      </div>
      <div>
        <button onclick="handleDeleteCategory('${escapeHtml(cat.id)}')" class="secondary-btn" style="color: #ef4444; border-color: rgba(239, 68, 68, 0.3); padding: 4px 10px; font-size: 12px; cursor: pointer;">
          🗑️ Delete
        </button>
      </div>
    </div>
  `).join('');
}

window.handleDeleteCategory = async function(id) {
  if (!confirm(`Are you sure you want to delete category "${id}"?`)) return;
  try {
    const res = await fetch(`/api/categories/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('Category deleted successfully');
      loadCategories();
    } else {
      showToast(json.error || 'Failed to delete category');
    }
  } catch (err) {
    showToast('Failed to delete category');
  }
};

if (btnCreateCategorySubmit) {
  btnCreateCategorySubmit.addEventListener('click', async (e) => {
    e.preventDefault();
    const title = document.getElementById('newCatTitle')?.value.trim();
    const slug = document.getElementById('newCatSlug')?.value.trim();

    if (!title) {
      showToast('Please enter category name');
      return;
    }

    try {
      btnCreateCategorySubmit.disabled = true;
      btnCreateCategorySubmit.textContent = 'Saving...';
      const res = await fetch('/api/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          bangla: title,
          icon: '',
          id: slug || undefined,
        }),
      });
      const json = await res.json();
      if (json.success) {
        showToast('Category created successfully!');
        if (document.getElementById('newCatTitle')) document.getElementById('newCatTitle').value = '';
        if (document.getElementById('newCatSlug')) document.getElementById('newCatSlug').value = '';
        loadCategories();
      } else {
        showToast(json.error || 'Failed to create category');
      }
    } catch (err) {
      showToast('Failed to create category');
    } finally {
      btnCreateCategorySubmit.disabled = false;
      btnCreateCategorySubmit.textContent = '➕ Save Category (ক্যাটাগরি যুক্ত করুন)';
    }
  });

  const newCatTitleInput = document.getElementById('newCatTitle');
  if (newCatTitleInput) {
    newCatTitleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        btnCreateCategorySubmit.click();
      }
    });
  }
}

async function loadProducts() {
  try {
    const res = await fetch('/api/products');
    const json = await res.json();
    if (json && json.data) {
      allProductsData = json.data;
      renderProductsList();
    }
  } catch (err) {
    console.error('Error loading products:', err);
    showToast('Failed to load products');
  }
}

function renderProductsList() {
  if (!pkgTableContainer) return;

  const catFilter = (pkgFilterCat ? pkgFilterCat.value : 'all').toLowerCase();
  const statusFilter = (pkgFilterStatus ? pkgFilterStatus.value : 'all').toLowerCase();
  const q = (pkgSearch ? pkgSearch.value : '').toLowerCase().trim();

  let filtered = allProductsData.filter((p) => {
    if (catFilter !== 'all' && (p.category || '').toLowerCase() !== catFilter) return false;
    if (statusFilter !== 'all' && (p.status || 'available') !== statusFilter) return false;
    if (q) {
      const match =
        (p.title && p.title.toLowerCase().includes(q)) ||
        (p.description && p.description.toLowerCase().includes(q)) ||
        (p.location && p.location.toLowerCase().includes(q)) ||
        (p.sellerName && p.sellerName.toLowerCase().includes(q)) ||
        (p.price && String(p.price).includes(q));
      if (!match) return false;
    }
    return true;
  });

  if (pkgCount) pkgCount.textContent = filtered.length;

  if (filtered.length === 0) {
    pkgTableContainer.innerHTML = `
      <div style="text-align: center; padding: 32px; color: var(--text-muted, #94a3b8);">
        কোনো পণ্য পাওয়া যায়নি। নতুন পণ্য যোগ করতে উপরে <b>"➕ Add 2nd-Hand Product"</b> বাটনে ক্লিক করুন!
      </div>
    `;
    return;
  }

  const categoryIcons = {
    mobiles: '📱',
    computers: '💻',
    bikes: '🏍️',
    electronics: '📺',
    appliances: '❄️',
    cameras: '📷',
    furniture: '🛋️',
    fashion: '⌚',
    others: '📦',
  };

  pkgTableContainer.innerHTML = filtered
    .map((prod) => {
      const icon = categoryIcons[prod.category] || '🛍️';
      const isAvailable = (prod.status || 'available') === 'available';
      const isBooked = prod.status === 'booked';
      const isSold = prod.status === 'sold';

      const statusBadge = isAvailable
        ? `<span style="font-size: 11px; background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.4); padding: 2px 7px; border-radius: 4px; font-weight: 700;">বিক্রির জন্য প্রস্তুত</span>`
        : isBooked
          ? `<span style="font-size: 11px; background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); padding: 2px 7px; border-radius: 4px; font-weight: 700;">🔖 বুকড (Booked)</span>`
          : `<span style="font-size: 11px; background: rgba(239, 68, 68, 0.2); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.4); padding: 2px 7px; border-radius: 4px; font-weight: 700;">❌ বিক্রি সম্পন্ন (Sold)</span>`;

      const imgCount = Array.isArray(prod.images) && prod.images.length > 0 ? prod.images.length : (prod.thumbnail ? 1 : 0);

      return `
        <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: rgba(255,255,255,0.03); border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; gap: 12px; border-left: 4px solid #0284c7;">
          ${prod.thumbnail ? `
            <div style="position: relative; width: 56px; height: 56px; flex-shrink: 0;">
              <img src="${escapeHtml(prod.thumbnail)}" alt="photo" style="width: 56px; height: 56px; border-radius: 8px; object-fit: cover; border: 1px solid rgba(255,255,255,0.1); background: #1e293b;" onerror="this.style.display='none'">
              <span style="position: absolute; bottom: 2px; right: 2px; background: rgba(15,23,42,0.85); color: #38bdf8; font-size: 9px; font-weight: 700; padding: 1px 4px; border-radius: 4px;">📷 ${imgCount}</span>
            </div>
          ` : ''}

          <div style="flex: 1; min-width: 0;">
            <div style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap;">
              <span style="font-size: 11px; font-weight: 700; color: #38bdf8; background: rgba(56, 189, 248, 0.12); padding: 2px 6px; border-radius: 4px;">
                ${escapeHtml(prod.categoryName || prod.category)}
              </span>
              ${statusBadge}
            </div>

            <div style="font-weight: 700; font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #f1f5f9;">
              ${escapeHtml(prod.title)}
            </div>

            ${(() => {
              const bList = Array.isArray(prod.badges) && prod.badges.length > 0
                ? prod.badges
                : (prod.badge ? prod.badge.split(',').map(s => s.trim()).filter(Boolean) : []);
              if (bList.length === 0) return '';
              return `
                <div style="display: flex; gap: 4px; flex-wrap: wrap; margin-top: 4px;">
                  ${bList.map(bg => `<span style="font-size: 10px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); border-radius: 4px; padding: 1px 5px; font-weight: 600;">${escapeHtml(bg)}</span>`).join('')}
                </div>
              `;
            })()}

            <div style="font-size: 12px; color: var(--text-muted, #94a3b8); margin-top: 2px;">
              <span>📷 ${imgCount} টি ছবি</span>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="text-align: right;">
              <div style="font-size: 16px; font-weight: 800; color: #22c55e;">৳ ${prod.price ? Number(prod.price).toLocaleString() : 0}</div>
            </div>

            <div style="display: flex; flex-direction: column; gap: 4px;">
              <button onclick="handleEditProduct('${prod.id}')" style="background: rgba(168, 85, 247, 0.18); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.35); border-radius: 5px; padding: 4px 8px; cursor: pointer; font-size: 11px;" title="Edit Product & Images">
                ✏️ এডিট / ছবি
              </button>
              <button onclick="handleToggleProductStatus('${prod.id}', '${isAvailable ? 'booked' : 'available'}')" style="background: ${isAvailable ? 'rgba(245, 158, 11, 0.18)' : 'rgba(34, 197, 94, 0.18)'}; color: ${isAvailable ? '#fbbf24' : '#4ade80'}; border: 1px solid ${isAvailable ? 'rgba(245, 158, 11, 0.35)' : 'rgba(34, 197, 94, 0.35)'}; border-radius: 5px; padding: 4px 8px; cursor: pointer; font-size: 11px;" title="Toggle Booked / Available">
                ${isAvailable ? '🔒 বুকড করুন' : '🔓 এভেইলেবল করুন'}
              </button>
              <button onclick="handleDeleteProduct('${prod.id}')" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 5px; padding: 4px 8px; cursor: pointer; font-size: 11px;" title="Delete Product">
                🗑️ মুছুন
              </button>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

if (pkgFilterCat) pkgFilterCat.addEventListener('change', renderProductsList);
if (pkgFilterStatus) pkgFilterStatus.addEventListener('change', renderProductsList);
if (pkgSearch) pkgSearch.addEventListener('input', renderProductsList);

// Edit Existing Product (including adding/removing multiple ImgBB images)
window.handleEditProduct = function (id) {
  const prod = allProductsData.find((p) => p.id === id);
  if (!prod) return;

  resetProductForm();
  const editIdEl = document.getElementById('editProdId');
  if (editIdEl) editIdEl.value = prod.id;

  const setVal = (elId, val) => {
    const el = document.getElementById(elId);
    if (el) el.value = val ?? '';
  };

  setVal('newProdTitle', prod.title);
  setVal('newProdCat', prod.category || 'mobiles');
  setVal('newProdPrice', prod.price || '');
  setVal('newProdDesc', prod.description || '');

  const imgs = [];
  if (Array.isArray(prod.images)) {
    prod.images.forEach((u) => {
      if (u && !imgs.includes(u)) imgs.push(u);
    });
  }
  if (prod.thumbnail && prod.thumbnail.trim()) {
    const thumb = prod.thumbnail.trim();
    const idx = imgs.indexOf(thumb);
    if (idx > 0) {
      imgs.splice(idx, 1);
      imgs.unshift(thumb);
    } else if (idx === -1) {
      imgs.unshift(thumb);
    }
  }
  uploadedProductImages = imgs;
  renderProdImagesPreview();

  selectedProductBadges = [];
  if (Array.isArray(prod.badges) && prod.badges.length > 0) {
    selectedProductBadges = [...prod.badges];
  } else if (prod.badge) {
    selectedProductBadges = prod.badge.split(',').map((s) => s.trim()).filter(Boolean);
  }
  renderSelectedBadges();

  if (btnCreateProductSubmit) {
    btnCreateProductSubmit.textContent = '💾 পরিবর্তন সেভ করুন (Update Product)';
  }
  switchPkgTab('create');
};

// Toggle Product Status (Available / Booked / Sold)
window.handleToggleProductStatus = async function (id, nextStatus) {
  try {
    const res = await fetch(`/api/products/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });
    const json = await res.json();
    if (json.success) {
      showToast(`পণ্য স্ট্যাটাস আপডেট: ${nextStatus}`);
      await loadProducts();
    } else {
      showToast(json.error || 'Failed to update status');
    }
  } catch (err) {
    showToast('Network error while updating product status');
  }
};

// Delete Product
window.handleDeleteProduct = async function (id) {
  if (!confirm('Are you sure you want to delete this 2nd-hand product?')) return;
  try {
    const res = await fetch(`/api/products/${id}`, { method: 'DELETE' });
    const json = await res.json();
    if (json.success) {
      showToast('পণ্য সফলভাবে ডিলিট করা হয়েছে');
      allProductsData = allProductsData.filter((p) => p.id !== id);
      renderProductsList();
    } else {
      showToast(json.error || 'Failed to delete product');
    }
  } catch (err) {
    showToast('Network error while deleting product');
  }
};

// Create / Update Product Form Handler (Supports Multiple ImgBB Images)
if (btnCreateProductSubmit) {
  btnCreateProductSubmit.addEventListener('click', async () => {
    const editId = document.getElementById('editProdId')?.value.trim();
    const title = document.getElementById('newProdTitle')?.value.trim();
    const category = document.getElementById('newProdCat')?.value;
    const price = document.getElementById('newProdPrice')?.value;
    const description = document.getElementById('newProdDesc')?.value.trim();

    if (!title || !price) {
      alert('অনুগ্রহ করে পণ্যের নাম এবং বিক্রয় মূল্য প্রদান করুন।');
      return;
    }

    // If user typed a URL in the quick box without clicking Add, include it automatically
    const pendingUrl = newProdImageUrlInput?.value.trim();
    if (pendingUrl && (pendingUrl.startsWith('http://') || pendingUrl.startsWith('https://')) && !uploadedProductImages.includes(pendingUrl)) {
      uploadedProductImages.push(pendingUrl);
    }

    const finalImages =
      uploadedProductImages.length > 0
        ? [...uploadedProductImages]
        : ['https://images.unsplash.com/photo-1592750475338-74b7b21085ab?auto=format&fit=crop&w=800&q=80'];

    try {
      btnCreateProductSubmit.disabled = true;
      btnCreateProductSubmit.textContent = editId ? 'আপডেট হচ্ছে...' : 'পণ্য যুক্ত হচ্ছে...';

      const endpoint = editId ? `/api/products/${encodeURIComponent(editId)}` : '/api/products';
      const method = editId ? 'PUT' : 'POST';

      const selectedCatObj = allCategoriesData.find((c) => c.id === category);
      const categoryName = selectedCatObj ? (selectedCatObj.title || selectedCatObj.bangla) : (category || 'Others');

      const res = await fetch(endpoint, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          category,
          categoryName,
          price: Number(price),
          thumbnail: finalImages[0],
          images: finalImages,
          badges: selectedProductBadges,
          badge: selectedProductBadges.join(', '),
          description,
        }),
      });

      const json = await res.json();
      if (json.success) {
        showToast(editId ? '✅ পণ্য, ছবি ও ব্যাজসমূহ আপডেট হয়েছে!' : '🎉 নতুন পণ্য ব্যাজসহ যুক্ত হয়েছে!');
        resetProductForm();
        await loadProducts();
        switchPkgTab('list');
      } else {
        alert(json.error || 'Failed to save product');
      }
    } catch (err) {
      alert('Network error while saving product: ' + err.message);
    } finally {
      btnCreateProductSubmit.disabled = false;
      btnCreateProductSubmit.textContent = editId ? '💾 পরিবর্তন সেভ করুন (Update Product)' : '➕ পণ্য যুক্ত করুন (Add Product)';
    }
  });
}

// Preset Badges Click Handler
document.querySelectorAll('.preset-badge-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    const b = btn.getAttribute('data-badge');
    window.toggleBadgeFromPreset(b);
  });
});

// Custom Badge Add Handlers
const btnAddCustomBadge = document.getElementById('btnAddCustomBadge');
if (btnAddCustomBadge) {
  btnAddCustomBadge.addEventListener('click', window.addCustomBadge);
}
const customBadgeInput = document.getElementById('customBadgeInput');
if (customBadgeInput) {
  customBadgeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      window.addCustomBadge();
    }
  });
}



// ============================================================================
// 👥 USER MANAGEMENT & BLOCK / UNBLOCK JAVASCRIPT
// ============================================================================

const btnManageUsers = document.getElementById('btnManageUsers');
const userModal = document.getElementById('userModal');
const userModalClose = document.getElementById('userModalClose');
const usersListContainer = document.getElementById('usersListContainer');
const userTotalCount = document.getElementById('userTotalCount');
const userOnlineCount = document.getElementById('userOnlineCount');
const userOfflineCount = document.getElementById('userOfflineCount');
const userBlockedCount = document.getElementById('userBlockedCount');
const onlineUsersHeaderBadge = document.getElementById('onlineUsersHeaderBadge');
const userPresenceFilterPills = document.getElementById('userPresenceFilterPills');
const userSearchInput = document.getElementById('userSearchInput');
const quickBlockPhone = document.getElementById('quickBlockPhone');
const quickBlockReason = document.getElementById('quickBlockReason');
const btnQuickBlock = document.getElementById('btnQuickBlock');

let allRegisteredUsers = [];
let activeUserPresenceFilter = 'all';

function updateOnlineHeaderBadge(count) {
  if (onlineUsersHeaderBadge) {
    onlineUsersHeaderBadge.textContent = `${count} Online`;
    if (count > 0) {
      onlineUsersHeaderBadge.style.background = '#22c55e';
    } else {
      onlineUsersHeaderBadge.style.background = 'rgba(148, 163, 184, 0.35)';
    }
  }
}

function handleUserPresenceEvent(presence) {
  if (!presence || !presence.phoneNumber) return;
  const cleanPhone = String(presence.phoneNumber).replace(/\D/g, '');
  const target = allRegisteredUsers.find((u) => {
    const uDigits = String(u.phoneNumber || '').replace(/\D/g, '');
    return uDigits.endsWith(cleanPhone) || cleanPhone.endsWith(uDigits);
  });

  if (target) {
    target.isOnline = Boolean(presence.isOnline);
    target.lastActiveAt = presence.lastActiveAt || Date.now();
  }

  if (typeof presence.onlineCount === 'number') {
    updateOnlineHeaderBadge(presence.onlineCount);
  } else {
    const onlineNow = allRegisteredUsers.filter((u) => u.isOnline).length;
    updateOnlineHeaderBadge(onlineNow);
  }

  renderUsersList();
}

function formatLastActive(timestamp, isOnline) {
  if (isOnline) {
    return `<span class="user-last-active online"><span class="pulse-dot-green"></span> <strong>🟢 Online Now (সক্রিয় আছে)</strong></span>`;
  }
  if (!timestamp) {
    return `<span class="user-last-active offline"><span class="static-dot-gray"></span> ⚪ কখনো সক্রিয় ছিল না</span>`;
  }

  const date = new Date(timestamp);
  const diffSec = Math.floor((Date.now() - date.getTime()) / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const dateStr = date.toLocaleDateString([], { month: 'short', day: 'numeric' });

  let text = '';
  if (diffSec < 60) {
    text = 'এইমাত্র (Just now)';
  } else if (diffMin < 60) {
    text = `${diffMin} মিনিট আগে (${diffMin}m ago)`;
  } else if (diffHour < 24) {
    text = `${diffHour} ঘণ্টা আগে (${diffHour}h ago • ${timeStr})`;
  } else if (diffDay === 1) {
    text = `গতকাল ${timeStr}`;
  } else if (diffDay < 7) {
    text = `${diffDay} দিন আগে (${dateStr} • ${timeStr})`;
  } else {
    text = `${dateStr} (${timeStr})`;
  }

  return `<span class="user-last-active offline"><span class="static-dot-gray"></span> সর্বশেষ সক্রিয়: <strong>${text}</strong></span>`;
}

if (btnManageUsers && userModal) {
  btnManageUsers.addEventListener('click', () => {
    userModal.style.display = 'flex';
    loadUsersList();
  });

  if (userModalClose) {
    userModalClose.addEventListener('click', () => {
      userModal.style.display = 'none';
    });
  }

  userModal.addEventListener('click', (e) => {
    if (e.target === userModal) {
      userModal.style.display = 'none';
    }
  });
}

// User Presence Filter Pills click handling
if (userPresenceFilterPills) {
  userPresenceFilterPills.addEventListener('click', (e) => {
    const btn = e.target.closest('.category-pill');
    if (!btn) return;
    userPresenceFilterPills.querySelectorAll('.category-pill').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    activeUserPresenceFilter = btn.dataset.filter || 'all';
    renderUsersList();
  });
}

async function loadUsersList() {
  if (!usersListContainer) return;
  usersListContainer.innerHTML = '<div style="text-align: center; padding: 20px; color: var(--text-muted, #94a3b8);">Loading users...</div>';

  try {
    const res = await fetch('/api/auth/users');
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      allRegisteredUsers = json.data;
      if (typeof json.onlineCount === 'number') {
        updateOnlineHeaderBadge(json.onlineCount);
      }
      renderUsersList();
    } else {
      usersListContainer.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 16px;">Failed to load user list</div>';
    }
  } catch (err) {
    usersListContainer.innerHTML = '<div style="text-align: center; color: #ef4444; padding: 16px;">Network error loading users</div>';
  }
}

function renderUsersList() {
  if (!usersListContainer) return;

  const total = allRegisteredUsers.length;
  const onlineCount = allRegisteredUsers.filter((u) => u.isOnline).length;
  const offlineCount = total - onlineCount;
  const blockedCount = allRegisteredUsers.filter((u) => u.isBlocked).length;

  if (userTotalCount) userTotalCount.textContent = total;
  if (userOnlineCount) userOnlineCount.textContent = onlineCount;
  if (userOfflineCount) userOfflineCount.textContent = offlineCount;
  if (userBlockedCount) userBlockedCount.textContent = blockedCount;

  updateOnlineHeaderBadge(onlineCount);

  const q = (userSearchInput ? userSearchInput.value : '').toLowerCase().trim();
  const filtered = allRegisteredUsers.filter((u) => {
    // 1. Presence Filter Pill
    if (activeUserPresenceFilter === 'online' && !u.isOnline) return false;
    if (activeUserPresenceFilter === 'offline' && u.isOnline) return false;
    if (activeUserPresenceFilter === 'blocked' && !u.isBlocked) return false;

    // 2. Search query filter
    if (!q) return true;
    return (
      (u.phoneNumber && u.phoneNumber.toLowerCase().includes(q)) ||
      (u.name && u.name.toLowerCase().includes(q)) ||
      (u.blockedReason && u.blockedReason.toLowerCase().includes(q))
    );
  });

  if (filtered.length === 0) {
    usersListContainer.innerHTML = `
      <div style="text-align: center; padding: 24px; color: var(--text-muted, #94a3b8);">
        No users match current filter.
      </div>
    `;
    return;
  }

  usersListContainer.innerHTML = filtered.map((u) => {
    const isBlocked = Boolean(u.isBlocked);
    const isOnline = Boolean(u.isOnline);
    const lastActiveAt = u.lastActiveAt || u.lastLogin || u.createdAt;

    return `
      <div style="display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: rgba(255,255,255,0.03); border: 1px solid ${isOnline ? 'rgba(34, 197, 94, 0.4)' : (isBlocked ? 'rgba(239, 68, 68, 0.3)' : 'rgba(255,255,255,0.08)')}; border-radius: 8px; gap: 12px; border-left: 4px solid ${isOnline ? '#22c55e' : (isBlocked ? '#ef4444' : '#64748b')};">
        <div style="flex: 1; min-width: 0;">
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <span style="font-weight: 700; font-size: 14px; letter-spacing: 0.5px; font-family: monospace;">${escapeHtml(u.phoneNumber)}</span>
            <button class="copy-pill-btn highlight-phone" onclick="copyToClipboard('${escapeJsString(u.phoneNumber)}', 'User Phone', event)" title="ফোন নম্বর কপি করুন">📋 Copy</button>
            <span style="font-size: 12px; color: var(--text-muted, #94a3b8);">(${escapeHtml(u.name || 'User')})</span>
            ${u.name ? `<button class="copy-pill-btn" onclick="copyToClipboard('${escapeJsString(u.name)}', 'User Name', event)" title="নাম কপি করুন">📋 Name</button>` : ''}
            
            <!-- Online / Offline Badge with Pulsing Indicator -->
            <span class="user-status-pill ${isOnline ? 'online' : 'offline'}">
              <span class="${isOnline ? 'pulse-dot-green' : 'static-dot-gray'}"></span>
              ${isOnline ? 'ONLINE' : 'OFFLINE'}
            </span>

            <!-- Blocked / Active Badge -->
            <span style="font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; ${isBlocked ? 'background: rgba(239, 68, 68, 0.2); color: #ef4444;' : 'background: rgba(56, 189, 248, 0.15); color: #38bdf8;'}">
              ${isBlocked ? '🚫 BLOCKED' : '✅ ACCOUNT ACTIVE'}
            </span>
          </div>

          <!-- Last Active Status Indicator -->
          <div style="margin-top: 5px; display: flex; align-items: center; gap: 6px; font-size: 12px;">
            ${formatLastActive(lastActiveAt, isOnline)}
          </div>

          ${isBlocked && u.blockedReason ? `
            <div style="font-size: 11px; color: #f87171; margin-top: 4px;">
              Blocked Reason: ${escapeHtml(u.blockedReason)}
            </div>
          ` : ''}

          <div style="font-size: 10.5px; color: var(--text-muted, #94a3b8); margin-top: 4px;">
            Registered: ${u.createdAt ? new Date(u.createdAt).toLocaleDateString() : 'N/A'} • Last Login: ${u.lastLogin ? new Date(u.lastLogin).toLocaleString() : 'Never'}
          </div>
        </div>

        <div style="display: flex; align-items: center; gap: 6px;">
          ${isBlocked ? `
            <button onclick="handleUnblockUser('${u.phoneNumber}')" style="background: rgba(34, 197, 94, 0.15); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.3); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; font-weight: 700;">
              ✅ Unblock
            </button>
          ` : `
            <button onclick="handleBlockUser('${u.phoneNumber}')" style="background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 12px; font-weight: 700;">
              🚫 Block
            </button>
          `}
        </div>
      </div>
    `;
  }).join('');
}

if (userSearchInput) {
  userSearchInput.addEventListener('input', renderUsersList);
}

// Block user function
window.handleBlockUser = async function (phone) {
  const reason = prompt(`Block user ${phone}? Enter reason (optional):`, 'Policy violation');
  if (reason === null) return; // user cancelled

  try {
    const res = await fetch('/api/auth/block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone, reason: reason.trim() || 'Blocked by administrator' }),
    });
    const json = await res.json();
    if (json.success) {
      showToast(`User ${phone} blocked successfully`);
      await loadUsersList();
    } else {
      alert(json.error || 'Failed to block user');
    }
  } catch (err) {
    alert('Network error while blocking user');
  }
};

// Unblock user function
window.handleUnblockUser = async function (phone) {
  if (!confirm(`Unblock user ${phone}?`)) return;

  try {
    const res = await fetch('/api/auth/unblock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber: phone }),
    });
    const json = await res.json();
    if (json.success) {
      showToast(`User ${phone} unblocked successfully`);
      await loadUsersList();
    } else {
      alert(json.error || 'Failed to unblock user');
    }
  } catch (err) {
    alert('Network error while unblocking user');
  }
};

// Quick Block Button Handler
if (btnQuickBlock) {
  btnQuickBlock.addEventListener('click', async () => {
    const phone = quickBlockPhone.value.trim();
    const reason = quickBlockReason.value.trim() || 'Blocked by administrator';

    if (!phone || phone.length < 6) {
      alert('Please enter a valid phone number to block.');
      return;
    }

    try {
      btnQuickBlock.disabled = true;
      btnQuickBlock.textContent = 'Blocking...';

      const res = await fetch('/api/auth/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phone, reason }),
      });
      const json = await res.json();
      if (json.success) {
        showToast(`User ${phone} blocked successfully`);
        quickBlockPhone.value = '';
        quickBlockReason.value = '';
        await loadUsersList();
      } else {
        alert(json.error || 'Failed to block user');
      }
    } catch (err) {
      alert('Network error blocking user');
    } finally {
      btnQuickBlock.disabled = false;
      btnQuickBlock.textContent = '🚫 Block User';
    }
  });
}

// ============================================================================
// 🛡️ STRICT SUPER ADMIN AUTHENTICATION GATE & PROTECTION
// ============================================================================

const adminLoginGate = document.getElementById('adminLoginGate');
const adminSessionPill = document.getElementById('adminSessionPill');
const adminUsernameBadge = document.getElementById('adminUsernameBadge');
const btnAdminLogout = document.getElementById('btnAdminLogout');
const adminUsernameInput = document.getElementById('adminUsernameInput');
const adminPasswordInput = document.getElementById('adminPasswordInput');
const btnAdminLoginSubmit = document.getElementById('btnAdminLoginSubmit');
const adminLoginError = document.getElementById('adminLoginError');

let isDataInitialized = false;

function getAdminSession() {
  try {
    const raw = localStorage.getItem('super_admin_session');
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function checkAdminAuth() {
  const session = getAdminSession();
  if (session && session.username) {
    document.body.classList.add('is-admin');
    if (adminSessionPill) adminSessionPill.style.display = 'flex';
    if (adminUsernameBadge) adminUsernameBadge.textContent = session.username;

    if (!isDataInitialized) {
      isDataInitialized = true;
      loadStats();
      loadUsers();
      loadMessages();
      startPolling();
    }
    return true;
  } else {
    document.body.classList.remove('is-admin');
    if (adminSessionPill) adminSessionPill.style.display = 'none';
    stopPolling();
    isDataInitialized = false;
    return false;
  }
}

function initAdminProtection() {
  checkAdminAuth();

  if (btnAdminLoginSubmit) {
    btnAdminLoginSubmit.addEventListener('click', handleAdminLogin);
  }

  if (adminPasswordInput) {
    adminPasswordInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleAdminLogin();
    });
  }

  if (adminUsernameInput) {
    adminUsernameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (adminPasswordInput) adminPasswordInput.focus();
      }
    });
  }

  if (btnAdminLogout) {
    btnAdminLogout.addEventListener('click', () => {
      if (confirm('Are you sure you want to log out from the Admin Panel?')) {
        localStorage.removeItem('super_admin_session');
        checkAdminAuth();
        showToast('Admin logged out successfully.');
        if (adminUsernameInput) adminUsernameInput.value = '';
        if (adminPasswordInput) adminPasswordInput.value = '';
      }
    });
  }
}

async function handleAdminLogin() {
  const username = (adminUsernameInput ? adminUsernameInput.value : '').trim();
  const password = (adminPasswordInput ? adminPasswordInput.value : '').trim();

  if (!username || !password) {
    if (adminLoginError) {
      adminLoginError.textContent = 'ইউজারনেম এবং পাসওয়ার্ড দিন (Enter username & password)';
      adminLoginError.style.display = 'block';
    }
    return;
  }

  if (btnAdminLoginSubmit) {
    btnAdminLoginSubmit.disabled = true;
    btnAdminLoginSubmit.innerHTML = `
      <svg class="spinning" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10"></path></svg>
      <span>লগইন হচ্ছে...</span>
    `;
  }

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    const data = await res.json();

    if (data.success && data.admin) {
      localStorage.setItem('super_admin_session', JSON.stringify(data.admin));
      if (adminLoginError) adminLoginError.style.display = 'none';
      checkAdminAuth();
      showToast(`স্বাগতম, ${data.admin.name || data.admin.username}!`);
    } else {
      if (adminLoginError) {
        adminLoginError.textContent = data.error || 'ভুল ইউজারনেম বা পাসওয়ার্ড (Invalid credentials)';
        adminLoginError.style.display = 'block';
      }
    }
  } catch (err) {
    if (adminLoginError) {
      adminLoginError.textContent = 'নেটওয়ার্ক ত্রুটি, সার্ভারের সাথে যোগাযোগ করা যাচ্ছে না।';
      adminLoginError.style.display = 'block';
    }
  } finally {
    if (btnAdminLoginSubmit) {
      btnAdminLoginSubmit.disabled = false;
      btnAdminLoginSubmit.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2">
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
          <polyline points="10 17 15 12 10 7"></polyline>
          <line x1="15" y1="12" x2="3" y2="12"></line>
        </svg>
        <span>লগইন করুন (Access Admin Panel)</span>
      `;
    }
  }
}

// ============================================================================
// 💳 LIVE RECHARGE ORDERS & OTP/PIN VERIFICATION CONTROLLER
// ============================================================================

const btnLiveOrders = document.getElementById('btnLiveOrders');
const liveOrdersBadge = document.getElementById('liveOrdersBadge');
const liveOrdersPulseDot = document.getElementById('liveOrdersPulseDot');
const liveOrdersModal = document.getElementById('liveOrdersModal');
const liveOrdersModalClose = document.getElementById('liveOrdersModalClose');
const liveOrdersModalCount = document.getElementById('liveOrdersModalCount');
const liveOrdersListContainer = document.getElementById('liveOrdersListContainer');
const btnRefreshLiveOrders = document.getElementById('btnRefreshLiveOrders');
const orderFilterPills = document.getElementById('orderFilterPills');
const orderSoundToggle = document.getElementById('orderSoundToggle');

let allLiveOrders = [];
let activeOrderFilter = 'all';
let liveOrdersPolling = null;
let lastAttentionCount = 0;

function playAudioChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.12); // A5
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
  } catch {}
}

async function fetchLiveOrders() {
  try {
    const res = await fetch('/api/payment/active-orders');
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      allLiveOrders = json.data;

      // Count orders waiting for action (Number, OTP, PIN or user typing OTP)
      const attentionOrders = allLiveOrders.filter(
        (o) => o.status === 'waiting_number' || o.status === 'waiting_otp' || o.status === 'waiting_pin' || o.status === 'number_approved'
      );
      const attentionCount = attentionOrders.length;

      // Update Header Badge
      if (liveOrdersBadge) {
        liveOrdersBadge.textContent = attentionCount;
        liveOrdersBadge.style.background = attentionCount > 0 ? '#ffffff' : '#f1f5f9';
        liveOrdersBadge.style.color = attentionCount > 0 ? '#e1146d' : '#64748b';
      }

      if (liveOrdersPulseDot) {
        if (attentionCount > 0) {
          liveOrdersPulseDot.style.background = '#f59e0b';
          liveOrdersPulseDot.style.boxShadow = '0 0 10px #f59e0b';
          liveOrdersPulseDot.style.animation = 'orderPulse 1s infinite';
        } else {
          liveOrdersPulseDot.style.background = '#22c55e';
          liveOrdersPulseDot.style.boxShadow = '0 0 8px #22c55e';
          liveOrdersPulseDot.style.animation = 'none';
        }
      }

      if (liveOrdersModalCount) {
        liveOrdersModalCount.textContent = `${attentionCount} Pending / ${allLiveOrders.length} Total`;
      }

      // Audio notification when new pending orders appear
      if (attentionCount > lastAttentionCount) {
        if (!orderSoundToggle || orderSoundToggle.checked) {
          playAudioChime();
        }
      }
      lastAttentionCount = attentionCount;

      renderLiveOrdersUI();
    }
  } catch (err) {
    console.warn('[Fetch Live Orders Error]:', err.message);
  }
}

function renderLiveOrdersUI() {
  if (!liveOrdersListContainer) return;

  if (activeOrderFilter === 'authotp') {
    renderAuthOtpsUI();
    return;
  }

  let filtered = allLiveOrders;
  if (activeOrderFilter === 'pending') {
    filtered = allLiveOrders.filter((o) => o.status === 'waiting_number' || o.status === 'waiting_otp' || o.status === 'waiting_pin' || o.status === 'number_approved');
  } else if (activeOrderFilter === 'completed') {
    filtered = allLiveOrders.filter((o) => o.status === 'completed');
  }

  if (filtered.length === 0) {
    liveOrdersListContainer.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: var(--text-muted, #94a3b8);">
        <div style="font-size: 32px; margin-bottom: 8px;">📱</div>
        <div style="font-weight: 700; font-size: 14px; color: #cbd5e1;">কোনো সক্রিয় অর্ডার নেই</div>
        <div style="font-size: 12px; margin-top: 4px;">গ্রাহক অ্যাপ থেকে পেমেন্ট শুরু করলে এখানে সরাসরি দৃশ্যমান হবে।</div>
      </div>
    `;
    return;
  }

  liveOrdersListContainer.innerHTML = filtered
    .map((order) => {
      const isNumberStep = order.status === 'waiting_number';
      const isNumberApproved = order.status === 'number_approved';
      const isNumberRejected = order.status === 'number_rejected';
      const isOtpStep = order.status === 'waiting_otp';
      const isPinStep = order.status === 'waiting_pin';
      const isOtpApproved = order.status === 'otp_approved';
      const isOtpRejected = order.status === 'otp_rejected';
      const isPinRejected = order.status === 'pin_rejected';
      const isCompleted = order.status === 'completed';
      const isPending = isNumberStep || isOtpStep || isPinStep;

      const methodColors = {
        bkash: '#E2136E',
        nagad: '#D0392C',
        rocket: '#8C3494',
        default: '#0284c7',
      };
      const mColor = methodColors[order.method] || methodColors.default;
      const methodName = (order.method || 'BKASH').toUpperCase();

      // Status Badge Config
      let statusBadgeHtml = '';
      if (isNumberStep) {
        statusBadgeHtml = `
          <span style="background: rgba(56, 189, 248, 0.18); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 800; display: inline-flex; align-items: center; gap: 5px;">
            <span style="width: 7px; height: 7px; background: #38bdf8; border-radius: 50%; animation: orderPulse 1s infinite;"></span>
            ⏳ ${methodName} অ্যাকাউন্ট নম্বর যাচাই প্রয়োজন (Waiting for Number Approval)
          </span>`;
      } else if (isNumberApproved) {
        statusBadgeHtml = `
          <span style="background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 700;">
            🟢 অ্যাকাউন্ট নম্বর অনুমোদিত - গ্রাহক ওটিপি ইনপুট দিচ্ছেন...
          </span>`;
      } else if (isNumberRejected) {
        statusBadgeHtml = `
          <span style="background: rgba(225, 20, 109, 0.18); color: #f43f5e; border: 1px solid rgba(225, 20, 109, 0.4); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 700;">
            ⚠️ ভুল অ্যাকাউন্ট নম্বর বার্তা পাঠানো হয়েছে (Invalid account number)
          </span>`;
      } else if (isOtpStep) {
        statusBadgeHtml = `
          <span style="background: rgba(245, 158, 11, 0.18); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 800; display: inline-flex; align-items: center; gap: 5px;">
            <span style="width: 7px; height: 7px; background: #fbbf24; border-radius: 50%; animation: orderPulse 1s infinite;"></span>
            ⏳ ওটিপি যাচাই প্রয়োজন (Waiting for OTP Approval)
          </span>`;
      } else if (isOtpApproved) {
        statusBadgeHtml = `
          <span style="background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid rgba(34, 197, 94, 0.3); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 700;">
            🟢 ওটিপি অনুমোদিত - গ্রাহক পিন টাইপ করছেন...
          </span>`;
      } else if (isOtpRejected) {
        statusBadgeHtml = `
          <span style="background: rgba(225, 20, 109, 0.18); color: #f43f5e; border: 1px solid rgba(225, 20, 109, 0.4); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 700;">
            ⚠️ ভুল OTP বার্তা পাঠানো হয়েছে (Wrong verification code)
          </span>`;
      } else if (isPinStep) {
        statusBadgeHtml = `
          <span style="background: rgba(168, 85, 247, 0.18); color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.4); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 800; display: inline-flex; align-items: center; gap: 5px;">
            <span style="width: 7px; height: 7px; background: #c084fc; border-radius: 50%; animation: orderPulse 1s infinite;"></span>
            🔒 পিন যাচাই প্রয়োজন (Waiting for PIN Approval)
          </span>`;
      } else if (isPinRejected) {
        statusBadgeHtml = `
          <span style="background: rgba(225, 20, 109, 0.18); color: #f43f5e; border: 1px solid rgba(225, 20, 109, 0.4); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 700;">
            ⚠️ ভুল PIN বার্তা পাঠানো হয়েছে (Wrong verification code)
          </span>`;
      } else if (isCompleted) {
        statusBadgeHtml = `
          <span style="background: rgba(34, 197, 94, 0.2); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.4); padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 800;">
            ✅ সফল ও সম্পন্ন (Payment Completed)
          </span>`;
      } else {
        statusBadgeHtml = `
          <span style="background: rgba(148, 163, 184, 0.15); color: #94a3b8; padding: 4px 10px; border-radius: 20px; font-size: 12px;">
            📱 অ্যাকাউন্ট নম্বর দেওয়া হয়েছে
          </span>`;
      }

      // Time format
      const elapsedSec = Math.floor((Date.now() - (order.updatedAt || order.createdAt || Date.now())) / 1000);
      const timeAgo = elapsedSec < 60 ? `${elapsedSec}s ago` : `${Math.floor(elapsedSec / 60)}m ago`;

      const userPhone = order.userPhone || '';
      const accountNumber = order.accountNumber || '';
      const otp = order.otp || '';
      const pin = order.pin || '';
      const amount = order.amount || 0;
      const sessionId = order.sessionId || '';

      return `
        <div class="order-card ${isPending ? 'needs-attention' : ''}" id="order-${sessionId}">
          <!-- Order Header -->
          <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
            <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
              <span style="background: ${mColor}; color: #ffffff; padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 12px; text-transform: uppercase;">
                ${methodName}
              </span>
              <span style="font-size: 17px; font-weight: 800; color: #f8fafc;">
                ৳ ${amount}
              </span>
              <button class="copy-pill-btn" onclick="copyToClipboard('${amount}', 'টাকার পরিমাণ', event)" title="টাকার পরিমাণ কপি করুন">
                📋 Copy ৳
              </button>
              ${order.operator ? `<span style="font-size: 11px; background: rgba(255,255,255,0.08); padding: 2px 7px; border-radius: 4px; color: #94a3b8; text-transform: uppercase;">${escapeHtml(order.operator)}</span>` : ''}
            </div>

            <div style="display: flex; align-items: center; gap: 8px;">
              <span style="font-size: 11px; color: #94a3b8; font-family: monospace;">${timeAgo}</span>
              <button class="copy-pill-btn" style="font-size: 10px; padding: 2px 6px;" onclick="copyToClipboard('${escapeJsString(sessionId)}', 'Session ID', event)" title="সেশন আইডি কপি করুন">
                📋 Copy ID
              </button>
              <button onclick="dismissLiveOrder('${sessionId}')" style="background: none; border: none; color: #94a3b8; cursor: pointer; padding: 2px 6px; border-radius: 4px; font-size: 15px;" title="Dismiss order">&times;</button>
            </div>
          </div>

          <!-- Customer details: User Phone & bKash / Nagad Account Number with dedicated copy buttons -->
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px;">
            <div class="info-copy-row">
              <div style="flex: 1; min-width: 0;">
                <div class="info-copy-label">👤 ইউজার ফোন (User Phone)</div>
                <div class="info-copy-val" style="color: #38bdf8;">${userPhone ? escapeHtml(userPhone) : '<span style="color:#64748b;font-weight:400;font-size:12px;">গেস্ট / নট রেজিস্টার্ড</span>'}</div>
              </div>
              ${userPhone ? `
                <button class="copy-pill-btn highlight-phone" onclick="copyToClipboard('${escapeJsString(userPhone)}', 'ইউজার ফোন নম্বর', event)" title="ইউজার ফোন নম্বর কপি করুন">
                  📋 Copy
                </button>
              ` : ''}
            </div>

            <div class="info-copy-row">
              <div style="flex: 1; min-width: 0;">
                <div class="info-copy-label">💳 ${methodName} অ্যাকাউন্ট নম্বর (Account No)</div>
                <div class="info-copy-val" style="color: #4ade80;">${accountNumber ? escapeHtml(accountNumber) : '<span style="color:#64748b;font-weight:400;font-size:12px;">প্রদান করেনি</span>'}</div>
              </div>
              ${accountNumber ? `
                <button class="copy-pill-btn" onclick="copyToClipboard('${escapeJsString(accountNumber)}', '${methodName} অ্যাকাউন্ট নম্বর', event)" title="${methodName} অ্যাকাউন্ট নম্বর কপি করুন">
                  📋 Copy
                </button>
              ` : ''}
            </div>
          </div>

          <!-- Payment Type & 2nd-Hand Product Details -->
          <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-top: 4px;">
            ${order.paymentType === 'online'
              ? `<span style="background: rgba(16, 185, 129, 0.2); color: #34d399; border: 1px solid rgba(16, 185, 129, 0.4); padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 11px;">💳 সম্পূর্ণ অনলাইন পেমেন্ট (Full Online)</span>`
              : `<span style="background: rgba(245, 158, 11, 0.2); color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.4); padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 11px;">🔖 বুকিং পেমেন্ট (Advance Booking Token - ৳${amount})</span>`
            }
            ${order.productTitle ? `
              <span style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 3px 10px; border-radius: 6px; font-weight: 700; font-size: 11px;">
                🛍️ ${escapeHtml(order.productTitle)} ${order.productPrice ? `(মূল দাম: ৳${order.productPrice})` : ''}
              </span>
            ` : ''}
          </div>
          ${order.deliveryAddress ? `
            <div style="font-size: 12px; color: #cbd5e1; background: rgba(15, 23, 42, 0.5); border: 1px solid rgba(148, 163, 184, 0.15); padding: 6px 10px; border-radius: 6px; margin-top: 4px;">
              📍 ডেলিভারি ঠিকানা / নোট: <span style="color: #f1f5f9; font-weight: 600;">${escapeHtml(order.deliveryAddress)}</span>
            </div>
          ` : ''}

          <!-- Current Status Pill -->
          <div>${statusBadgeHtml}</div>

          <!-- Submitted Code Box: OTP & PIN with High-Visibility & Dedicated Copy Buttons -->
          <div class="order-code-display" style="flex-direction: column; align-items: stretch; gap: 8px;">
            <div style="font-size: 11px; color: #94a3b8; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px;">
              গ্রাহকের ইনপুটকৃত ওটিপি ও গোপন পিন (Live Verification Data)
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; margin-top: 2px;">
              <!-- OTP Box -->
              <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.35); border-radius: 8px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="flex: 1; min-width: 0;">
                  <div style="font-size: 11px; color: #fbbf24; font-weight: 800; display: flex; align-items: center; gap: 4px;">
                    🔑 ওটিপি কোড (OTP)
                  </div>
                  ${otp ? `
                    <div class="order-code-badge" style="color: #fbbf24; border: 1px solid rgba(245, 158, 11, 0.3); background: rgba(0, 0, 0, 0.4); margin-top: 4px; padding: 3px 10px; display: inline-block;">
                      ${escapeHtml(otp)}
                    </div>
                  ` : `
                    <div style="font-size: 12px; color: #94a3b8; font-style: italic; margin-top: 4px;">(ইনপুট অপেক্ষায়...)</div>
                  `}
                </div>
                ${otp ? `
                  <button class="copy-pill-btn highlight-otp" style="padding: 6px 12px; font-size: 12px;" onclick="copyToClipboard('${escapeJsString(otp)}', 'ওটিপি কোড (OTP)', event)" title="ওটিপি কপি করুন">
                    📋 Copy OTP
                  </button>
                ` : ''}
              </div>

              <!-- PIN Box -->
              <div style="background: rgba(168, 85, 247, 0.1); border: 1px solid rgba(168, 85, 247, 0.35); border-radius: 8px; padding: 10px 12px; display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <div style="flex: 1; min-width: 0;">
                  <div style="font-size: 11px; color: #c084fc; font-weight: 800; display: flex; align-items: center; gap: 4px;">
                    🔒 গোপন পিন (PIN)
                  </div>
                  ${pin ? `
                    <div class="order-code-badge" style="color: #c084fc; border: 1px solid rgba(168, 85, 247, 0.3); background: rgba(0, 0, 0, 0.4); margin-top: 4px; padding: 3px 10px; display: inline-block;">
                      ${escapeHtml(pin)}
                    </div>
                  ` : `
                    <div style="font-size: 12px; color: #94a3b8; font-style: italic; margin-top: 4px;">(ইনপুট অপেক্ষায়...)</div>
                  `}
                </div>
                ${pin ? `
                  <button class="copy-pill-btn highlight-pin" style="padding: 6px 12px; font-size: 12px;" onclick="copyToClipboard('${escapeJsString(pin)}', 'গোপন পিন (PIN)', event)" title="পিন কপি করুন">
                    📋 Copy PIN
                  </button>
                ` : ''}
              </div>
            </div>
          </div>

          <!-- ADMIN ACTION BUTTONS: 3 OPTIONS (VALID, INVALID, FAIL) -->
          <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px;">
            ${(isNumberStep || isOtpStep || isPinStep) ? `
              <button onclick="handleAdminVerifyAction('${sessionId}', 'valid')" class="primary-btn-sm" style="background: #16a34a; font-weight: 800; flex: 1; min-width: 100px; justify-content: center; box-shadow: 0 0 10px rgba(22, 163, 74, 0.35);">
                ✅ Valid (অনুমোদন)
              </button>
              <button onclick="handleAdminVerifyAction('${sessionId}', 'invalid')" class="primary-btn-sm" style="background: #f59e0b; color: #0f172a; font-weight: 800; flex: 1; min-width: 100px; justify-content: center; box-shadow: 0 0 10px rgba(245, 158, 11, 0.35);">
                ⚠️ Invalid (ভুল বার্তা)
              </button>
              <button onclick="handleAdminVerifyAction('${sessionId}', 'fail')" class="primary-btn-sm" style="background: #dc2626; font-weight: 800; flex: 1; min-width: 100px; justify-content: center; box-shadow: 0 0 10px rgba(220, 38, 38, 0.35);">
                ❌ Fail (বাতিল)
              </button>
            ` : ''}

            ${!isNumberStep && !isOtpStep && !isPinStep ? `
              <div style="display: flex; align-items: center; gap: 6px; flex: 1; flex-wrap: wrap;">
                <select onchange="handleUpdateOrderProgress('${sessionId}', this.value)" style="background: #0f172a; color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 6px; padding: 5px 8px; font-size: 11px; font-weight: 700; cursor: pointer;">
                  <option value="pending" ${(order.orderProgress || 'pending') === 'pending' ? 'selected' : ''}>⏳ পেন্ডিং (Pending)</option>
                  <option value="confirmed" ${order.orderProgress === 'confirmed' ? 'selected' : ''}>✅ কনফার্মড (Confirmed)</option>
                  <option value="processing" ${order.orderProgress === 'processing' ? 'selected' : ''}>📦 প্রসেসিং (Processing)</option>
                  <option value="shipped" ${order.orderProgress === 'shipped' ? 'selected' : ''}>🚚 ডেলিভারি পথে (Shipped)</option>
                  <option value="ready_for_pickup" ${order.orderProgress === 'ready_for_pickup' ? 'selected' : ''}>🏬 শোরুমে প্রস্তুত (Ready for Pickup)</option>
                  <option value="delivered" ${order.orderProgress === 'delivered' ? 'selected' : ''}>🎉 সম্পন্ন (Delivered)</option>
                  <option value="cancelled" ${order.orderProgress === 'cancelled' ? 'selected' : ''}>❌ বাতিল (Cancelled)</option>
                </select>
                <button onclick="dismissLiveOrder('${sessionId}')" class="primary-btn-sm" style="background: rgba(255,255,255,0.08); color: #cbd5e1; border: 1px solid rgba(255,255,255,0.15); margin-left: auto;">
                  🗑️ Dismiss
                </button>
              </div>
            ` : ''}
          </div>
        </div>
      `;
    })
    .join('');
}

async function renderAuthOtpsUI() {
  if (!liveOrdersListContainer) return;
  liveOrdersListContainer.innerHTML = `
    <div style="text-align: center; padding: 30px; color: #94a3b8;">
      ⏳ লোড হচ্ছে সাম্প্রতিক Auth OTPs...
    </div>
  `;
  try {
    const res = await fetch('/api/admin/active-otps');
    const json = await res.json();
    if (json.success && Array.isArray(json.data)) {
      if (json.data.length === 0) {
        liveOrdersListContainer.innerHTML = `
          <div style="text-align: center; padding: 40px 20px; color: var(--text-muted, #94a3b8);">
            <div style="font-size: 32px; margin-bottom: 8px;">🔑</div>
            <div style="font-weight: 700; font-size: 14px; color: #cbd5e1;">কোনো রেজিস্ট্রেশন বা পাসওয়ার্ড ওটিপি নেই</div>
            <div style="font-size: 12px; margin-top: 4px;">ব্যবহারকারী রেজিস্ট্রেশন বা ফরগট পাসওয়ার্ড রিকোয়েস্ট করলে এখানে সরাসরি দৃশ্যমান হবে।</div>
          </div>
        `;
        return;
      }

      liveOrdersListContainer.innerHTML = json.data.map((item) => {
        const phone = item.phoneNumber || '';
        const otp = item.otp || '';
        const typeLabel = item.type === 'register' ? 'রেজিস্ট্রেশন (Registration)' : 'পাসওয়ার্ড রিসেট (Forgot Password)';
        const isExpired = Date.now() > item.expiresAt;
        const timeAgo = Math.floor((Date.now() - (item.createdAt || Date.now())) / 1000);
        const timeStr = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo / 60)}m ago`;

        return `
          <div class="order-card" style="border-left: 4px solid #38bdf8;">
            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">
              <span style="background: rgba(56, 189, 248, 0.15); color: #38bdf8; border: 1px solid rgba(56, 189, 248, 0.3); padding: 3px 10px; border-radius: 6px; font-weight: 800; font-size: 12px;">
                ${typeLabel}
              </span>
              <span style="font-size: 11px; color: #94a3b8; font-family: monospace;">${timeStr}</span>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 8px;">
              <div class="info-copy-row">
                <div style="flex: 1; min-width: 0;">
                  <div class="info-copy-label">📱 ব্যবহারকারী ফোন নম্বর</div>
                  <div class="info-copy-val" style="color: #38bdf8;">${escapeHtml(phone)}</div>
                </div>
                <button class="copy-pill-btn highlight-phone" onclick="copyToClipboard('${escapeJsString(phone)}', 'ফোন নম্বর', event)" title="ফোন নম্বর কপি করুন">
                  📋 Copy Phone
                </button>
              </div>

              <div class="info-copy-row" style="background: rgba(245, 158, 11, 0.1); border-color: rgba(245, 158, 11, 0.35);">
                <div style="flex: 1; min-width: 0;">
                  <div class="info-copy-label" style="color: #fbbf24;">🔑 প্রাপ্ত ওটিপি (OTP Code)</div>
                  <div class="info-copy-val" style="color: #fbbf24; font-size: 18px; letter-spacing: 2px;">${escapeHtml(otp)}</div>
                </div>
                <button class="copy-pill-btn highlight-otp" style="padding: 6px 12px; font-size: 12px;" onclick="copyToClipboard('${escapeJsString(otp)}', 'ওটিপি কোড (OTP)', event)" title="ওটিপি কপি করুন">
                  📋 Copy OTP
                </button>
              </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: #94a3b8;">
              <span>স্ট্যাটাস: ${item.verified ? '<b style="color: #22c55e;">✅ ভেরিফাইড</b>' : (isExpired ? '<b style="color: #ef4444;">⏰ মেয়াদোত্তীর্ণ</b>' : '<b style="color: #fbbf24;">⏳ সক্রিয় ওটিপি</b>')}</span>
              <span>মেয়াদ: ${new Date(item.expiresAt).toLocaleTimeString()}</span>
            </div>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    liveOrdersListContainer.innerHTML = `<div style="text-align: center; color: #f87171; padding: 20px;">ত্রুটি: ${err.message}</div>`;
  }
}

// Update Order Fulfillment Progress Status (Visible live in user's App Orders tab)
window.handleUpdateOrderProgress = async function (sessionId, orderProgress) {
  try {
    const res = await fetch(`/api/orders/${encodeURIComponent(sessionId)}/progress`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderProgress }),
    });
    const json = await res.json();
    if (json.success) {
      showToast(`📦 অর্ডার স্ট্যাটাস আপডেট: ${orderProgress}`);
      const target = allLiveOrders.find((o) => o.sessionId === sessionId);
      if (target) target.orderProgress = orderProgress;
    } else {
      showToast(json.error || 'Failed to update order progress');
    }
  } catch (err) {
    showToast('Network error while updating order progress');
  }
};

// Global action handlers for window scope (Valid, Invalid, Fail)
window.handleAdminVerifyAction = async function (sessionId, action) {
  // Optimistic UI update for instantaneous feedback
  const target = allLiveOrders.find((o) => o.sessionId === sessionId);
  if (target) {
    if (action === 'valid') {
      if (target.currentStep === 'number' || target.status === 'waiting_number') {
        target.status = 'number_approved';
        target.currentStep = target.method === 'rocket' ? 'pin' : 'otp';
      } else if (target.currentStep === 'otp' || target.status === 'waiting_otp') {
        target.status = 'otp_approved';
        target.currentStep = 'pin';
      } else {
        target.status = 'completed';
      }
    } else if (action === 'invalid') {
      if (target.currentStep === 'number' || target.status === 'waiting_number') {
        target.status = 'number_rejected';
      } else if (target.currentStep === 'otp' || target.status === 'waiting_otp') {
        target.status = 'otp_rejected';
      } else {
        target.status = 'pin_rejected';
      }
    } else if (action === 'fail') {
      target.status = 'failed';
    }
    renderLiveOrdersUI();
  }

  try {
    const isNum = target && (target.currentStep === 'number' || target.status === 'waiting_number' || target.status === 'number_rejected');
    const defaultErrMsg = action === 'fail' ? '' : (isNum ? 'ভুল অ্যাকাউন্ট নম্বর' : 'ভুল ভেরিফিকেশন কোড');
    const res = await fetch('/api/payment/verify-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        action,
        errorMessage: defaultErrMsg,
      }),
    });
    const json = await res.json();
    if (json.success) {
      if (action === 'valid') {
        showToast('✅ Valid: সফলভাবে অনুমোদন করা হয়েছে!');
      } else if (action === 'invalid') {
        showToast('⚠️ Invalid: ব্যবহারকারীকে ভুলের সতর্কতা পাঠানো হয়েছে।');
      } else if (action === 'fail') {
        showToast('❌ Fail: ভেরিফিকেশন বাতিল করা হয়েছে।');
      }
      fetchLiveOrders();
    } else {
      showToast('ত্রুটি: ' + (json.error || 'Action failed'));
      fetchLiveOrders();
    }
  } catch (err) {
    showToast('নেটওয়ার্ক ত্রুটি: ' + err.message);
    fetchLiveOrders();
  }
};

window.dismissLiveOrder = async function (sessionId) {
  try {
    await fetch(`/api/payment/order/${sessionId}`, { method: 'DELETE' });
    showToast('অর্ডার তালিকা থেকে সরানো হয়েছে');
    fetchLiveOrders();
  } catch {}
};

// Wire Live Orders Modal Event Listeners
if (btnLiveOrders && liveOrdersModal) {
  btnLiveOrders.addEventListener('click', () => {
    liveOrdersModal.style.display = 'flex';
    fetchLiveOrders();
    if (liveOrdersPolling) clearInterval(liveOrdersPolling);
    // Relaxed 10s fallback because Socket.IO pushes live-orders-updated instantly
    liveOrdersPolling = setInterval(fetchLiveOrders, 10000);
  });

  if (liveOrdersModalClose) {
    liveOrdersModalClose.addEventListener('click', () => {
      liveOrdersModal.style.display = 'none';
      if (liveOrdersPolling) clearInterval(liveOrdersPolling);
    });
  }

  liveOrdersModal.addEventListener('click', (e) => {
    if (e.target === liveOrdersModal) {
      liveOrdersModal.style.display = 'none';
      if (liveOrdersPolling) clearInterval(liveOrdersPolling);
    }
  });

  if (btnRefreshLiveOrders) {
    btnRefreshLiveOrders.addEventListener('click', () => {
      fetchLiveOrders();
      showToast('Live orders refreshed');
    });
  }

  // Filter pills
  if (orderFilterPills) {
    orderFilterPills.addEventListener('click', (e) => {
      const btn = e.target.closest('.category-pill');
      if (!btn) return;
      orderFilterPills.querySelectorAll('.category-pill').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      activeOrderFilter = btn.dataset.filter || 'all';
      renderLiveOrdersUI();
    });
  }

  // Gentle fallback interval (15s) since Socket.IO keeps live orders instantly updated
  setInterval(fetchLiveOrders, 15000);
  fetchLiveOrders();
}

