'use strict';

// public/admin.js —— 商家后台（v4）
// 金额以「分」显示和提交；登录口令只存在服务端 config.json。

const TOKEN_KEY = 'h5_admin_token';
const POLL_INTERVAL = 15000;
const NEW_ORDER_HIGHLIGHT_MS = 30000;

function readSavedAdminToken() {
  try {
    const saved = localStorage.getItem(TOKEN_KEY) || '';
    if (saved) return saved;

    const legacy = sessionStorage.getItem(TOKEN_KEY) || '';
    if (legacy) {
      localStorage.setItem(TOKEN_KEY, legacy);
      sessionStorage.removeItem(TOKEN_KEY);
    }
    return legacy;
  } catch (err) {
    return '';
  }
}

function clearSavedAdminToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  } catch (err) {
    // 忽略本机存储错误
  }
}

const STATUS_TEXT = {
  pending: '待接单',
  making: '制作中',
  completed: '已完成',
  cancelled: '已取消',
};

const state = {
  token: readSavedAdminToken(),
  orders: [],
  menu: [],
  categories: [],
  couponTemplates: [],
  issuedCoupons: [],
  customers: [],
  activeTab: 'orders',
  activeFilter: 'all',
  pollTimer: null,
  loadingOrders: null,
  knownPendingIds: new Set(),
  newOrderSince: new Map(),
  audioCtx: null,
  editingDishId: '',
  dishImageUrl: '',
  dishTiers: [],
  editingCouponId: '',
  detailOrderId: '',
  dishQuery: '',
};

const $ = (id) => document.getElementById(id);
const els = {};

function cacheElements() {
  [
    'loginView', 'loginForm', 'passwordInput', 'loginBtn', 'loginError',
    'dashboardView', 'lastRefresh', 'exportBtn', 'testSoundBtn', 'refreshBtn', 'logoutBtn',
    'pendingBadge', 'ordersPanel', 'menuPanel', 'couponsPanel',
    'orderFilters', 'ordersList', 'filterPendingCount', 'addDishBtn',
    'dishForm', 'dishFormTitle', 'dishId', 'dishName', 'dishCategory',
    'dishPrice', 'dishUnit', 'dishEmoji', 'dishTag', 'dishDesc',
    'addDishTierBtn', 'dishTierList',
    'dishImagePreview', 'chooseDishImageBtn', 'removeDishImageBtn',
    'dishImageInput',
    'dishSoldOut', 'dishEnabled', 'cancelDishBtn', 'saveDishBtn',
    'adminMenuList', 'dishSearchInput', 'addCouponBtn', 'couponForm', 'couponFormTitle',
    'couponId', 'couponName', 'couponThreshold', 'couponDiscount',
    'couponAutoIssue', 'couponOnlyFirstOrder', 'couponEnabled',
    'cancelCouponBtn', 'saveCouponBtn', 'adminCouponList',
    'couponIssueTemplate', 'couponIssuePhone', 'issueToPhoneBtn',
    'adminCustomers', 'adminIssuedCoupons', 'orderDetailOverlay',
    'closeOrderDetailBtn', 'orderDetailBody', 'toast',
  ].forEach((id) => {
    els[id] = $(id);
  });
}

// ==================== 通用 ====================

function money(cents) {
  return '¥' + (Math.round(Number(cents) || 0) / 100).toFixed(2);
}

function centsToInput(cents) {
  const n = Math.round(Number(cents) || 0) / 100;
  return n ? String(n) : '';
}

function compactPrice(cents) {
  return money(cents).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function formatDishPricing(dish) {
  const unit = dish.unit || '份';
  const tiers = Array.isArray(dish.bundleTiers) ? dish.bundleTiers : [];
  const base = compactPrice(dish.priceCents) + '/' + unit;

  if (tiers.length === 0) return base;

  return base + ' · ' + tiers
    .map((tier) => tier.quantity + unit + compactPrice(tier.totalPriceCents))
    .join(' · ');
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(Number(timestamp));
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    (d.getMonth() + 1) + '月' + d.getDate() + '日 ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function avatarIsImage(avatar) {
  return /^(?:data:image\/|https?:\/\/)/.test(String(avatar || ''));
}

function setAvatar(element, avatar) {
  if (!element) return;
  const value = String(avatar || '🍢');

  element.innerHTML = '';

  if (avatarIsImage(value)) {
    const img = document.createElement('img');
    img.src = value;
    img.alt = '头像';
    img.loading = 'lazy';
    element.appendChild(img);
  } else {
    element.textContent = value || '🍢';
  }
}

function setDishImagePreview(imageUrl) {
  const preview = els.dishImagePreview;
  if (!preview) return;

  preview.innerHTML = '';

  if (imageUrl) {
    const img = document.createElement('img');
    img.src = imageUrl;
    img.alt = '菜品图片预览';
    preview.appendChild(img);
  } else {
    preview.appendChild(make('span', null, '暂无图片'));
  }

  els.removeDishImageBtn.classList.toggle('hidden', !imageUrl);
}

function renderDishTiers() {
  const list = els.dishTierList;
  if (!list) return;

  list.innerHTML = '';

  if (state.dishTiers.length === 0) {
    list.appendChild(
      make('p', 'dish-tier-empty', '暂无数量优惠，顾客按基础单价购买')
    );
    return;
  }

  state.dishTiers.forEach((tier, index) => {
    const row = make('div', 'dish-tier-row');
    row.dataset.tierIndex = String(index);

    const quantityLabel = make('label', 'dish-tier-field');
    quantityLabel.appendChild(make('span', null, '购买数量'));
    const quantity = document.createElement('input');
    quantity.type = 'number';
    quantity.min = '2';
    quantity.max = '99';
    quantity.step = '1';
    quantity.inputMode = 'numeric';
    quantity.dataset.tierField = 'quantity';
    quantity.placeholder = '3';
    quantity.value = tier.quantity;
    quantityLabel.appendChild(quantity);
    row.appendChild(quantityLabel);

    const unit = make('span', 'dish-tier-unit', els.dishUnit.value.trim() || '个');
    row.appendChild(unit);

    const priceLabel = make('label', 'dish-tier-field');
    priceLabel.appendChild(make('span', null, '合计金额（元）'));
    const totalPrice = document.createElement('input');
    totalPrice.type = 'number';
    totalPrice.min = '0.01';
    totalPrice.step = '0.01';
    totalPrice.inputMode = 'decimal';
    totalPrice.dataset.tierField = 'totalPrice';
    totalPrice.placeholder = '10';
    totalPrice.value = tier.totalPrice;
    priceLabel.appendChild(totalPrice);
    row.appendChild(priceLabel);

    const remove = make('button', 'small-button danger', '删除');
    remove.type = 'button';
    remove.dataset.removeTier = String(index);
    row.appendChild(remove);

    list.appendChild(row);
  });
}

const MAX_DISH_IMAGE_CHARS = 85000;

function fileToDishImage(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\/(?:jpeg|png|webp)$/.test(file.type || '')) {
      reject(new Error('请选择 JPG、PNG 或 WebP 图片'));
      return;
    }

    if (file.size > 12 * 1024 * 1024) {
      reject(new Error('原图太大，请选择 12MB 以内的图片'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('图片读取失败'));

    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('图片格式不支持'));

      img.onload = () => {
        let maxSide = 720;
        let quality = 0.76;

        for (let attempt = 0; attempt < 8; attempt += 1) {
          const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
          const width = Math.max(1, Math.round(img.width * scale));
          const height = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;

          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff8f0';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          const dataUrl = canvas.toDataURL('image/jpeg', quality);
          if (dataUrl.length <= MAX_DISH_IMAGE_CHARS) {
            resolve(dataUrl);
            return;
          }

          maxSide = Math.max(320, Math.round(maxSide * 0.82));
          quality = Math.max(0.55, quality - 0.05);
        }

        reject(new Error('图片压缩后仍然太大，请换一张图片'));
      };

      img.src = String(reader.result || '');
    };

    reader.readAsDataURL(file);
  });
}

let toastTimer = null;

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.remove('hidden');

  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.classList.add('hidden');
  }, 2400);
}

async function api(url, options) {
  const opts = options || {};
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    opts.headers || {}
  );

  if (state.token) headers['x-admin-token'] = state.token;

  const response = await fetch(url, Object.assign({}, opts, { headers }));
  let data = {};

  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  if (response.status === 401) {
    showLogin('登录已过期，请重新登录');
    const error = new Error(data.error || '请先登录');
    error.status = 401;
    throw error;
  }

  if (!response.ok) {
    const error = new Error(data.error || '请求失败');
    error.status = response.status;
    throw error;
  }

  return data;
}

// ==================== 登录 ====================

function showLogin(message) {
  stopPolling();
  state.token = '';
  clearSavedAdminToken();
  state.orders = [];
  state.menu = [];
  state.couponTemplates = [];
  state.issuedCoupons = [];
  state.customers = [];
  state.knownPendingIds = new Set();
  state.newOrderSince.clear();
  state.editingDishId = '';
  state.editingCouponId = '';
  state.detailOrderId = '';
  state.dishQuery = '';
  if (els.dishSearchInput) els.dishSearchInput.value = '';
  closeOrderDetail();

  els.dashboardView.classList.add('hidden');
  els.loginView.classList.remove('hidden');
  els.loginError.textContent = message || '';
  els.passwordInput.value = '';
  els.passwordInput.focus();
}

function showDashboard() {
  els.loginView.classList.add('hidden');
  els.dashboardView.classList.remove('hidden');
}

async function handleLogin(event) {
  event.preventDefault();

  const password = els.passwordInput.value.trim();
  if (!password) {
    els.loginError.textContent = '请输入管理口令';
    return;
  }

  ensureAudio();

  els.loginBtn.disabled = true;
  els.loginBtn.textContent = '登录中...';
  els.loginError.textContent = '';

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });

    let data = {};
    try {
      data = await response.json();
    } catch (err) {
      data = {};
    }

    if (!response.ok) throw new Error(data.error || '登录失败');

    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, data.token);
    sessionStorage.removeItem(TOKEN_KEY);
    await enterDashboard();
  } catch (err) {
    els.loginError.textContent = err.message || '登录失败';
  } finally {
    els.loginBtn.disabled = false;
    els.loginBtn.textContent = '登录';
  }
}

async function handleLogout() {
  if (!window.confirm('确定退出商家后台吗？')) return;

  try {
    await api('/api/admin/logout', { method: 'POST' });
  } catch (err) {
    // 忽略退出接口错误
  }

  showLogin('');
  showToast('已退出登录');
}

async function enterDashboard() {
  showDashboard();
  els.lastRefresh.textContent = '正在加载订单...';

  try {
    await loadOrders();
  } catch (err) {
    if (err.status !== 401) {
      showToast(err.message || '订单加载失败');
      els.lastRefresh.textContent = '加载失败，请点刷新重试';
    }
    return;
  }

  startPolling();

  // 菜品和优惠券加载失败不影响订单轮询
  loadMenu().catch((err) => {
    if (err.status !== 401) console.warn('菜品加载失败', err);
  });
  loadCouponsAdmin().catch((err) => {
    if (err.status !== 401) console.warn('优惠券加载失败', err);
  });
}

// ==================== 订单 ====================

async function loadOrders(force) {
  if (state.loadingOrders) {
    if (!force) return state.loadingOrders;

    try {
      await state.loadingOrders;
    } catch (err) {
      // 忽略上一次失败
    }
  }

  if (state.loadingOrders) return state.loadingOrders;

  state.loadingOrders = doLoadOrders();

  try {
    return await state.loadingOrders;
  } finally {
    state.loadingOrders = null;
  }
}

async function doLoadOrders() {
  const data = await api('/api/admin/orders');
  const list = Array.isArray(data.orders) ? data.orders : [];

  const pendingIds = new Set(
    list.filter((order) => order.status === 'pending').map((order) => order.id)
  );

  const newIds = [];
  pendingIds.forEach((id) => {
    if (!state.knownPendingIds.has(id)) newIds.push(id);
  });

  state.knownPendingIds = pendingIds;
  state.orders = list;

  if (newIds.length > 0) {
    const now = Date.now();

    newIds.forEach((id) => {
      state.newOrderSince.set(id, now);

      setTimeout(() => {
        state.newOrderSince.delete(id);
        renderOrders();
      }, NEW_ORDER_HIGHLIGHT_MS);
    });

    playBeep(false);
    if (navigator.vibrate) {
      try {
        navigator.vibrate([200, 100, 200]);
      } catch (err) {
        // 忽略震动失败
      }
    }

    showToast(
      newIds.length > 1
        ? '有 ' + newIds.length + ' 个新订单，请及时接单'
        : '有新订单，请及时接单'
    );
  }

  renderOrders();
  renderOrderDetail();
  els.lastRefresh.textContent = '上次刷新 ' + formatTime(Date.now());
}

function sortOrders(list) {
  const priority = {
    pending: 0,
    making: 1,
    completed: 2,
    cancelled: 3,
  };

  return list.slice().sort((a, b) => {
    const pa = priority[a.status] == null ? 9 : priority[a.status];
    const pb = priority[b.status] == null ? 9 : priority[b.status];
    if (pa !== pb) return pa - pb;
    return b.createdAt - a.createdAt;
  });
}

function renderOrders() {
  const pendingCount = state.orders.filter(
    (order) => order.status === 'pending'
  ).length;

  els.pendingBadge.textContent = String(pendingCount);
  els.filterPendingCount.textContent = String(pendingCount);

  const filtered = state.activeFilter === 'all'
    ? state.orders
    : state.orders.filter((order) => order.status === state.activeFilter);

  const sorted = sortOrders(filtered);
  els.ordersList.innerHTML = '';

  if (sorted.length === 0) {
    els.ordersList.appendChild(make('p', 'orders-empty', '暂时没有订单'));
    return;
  }

  sorted.forEach((order) => {
    els.ordersList.appendChild(renderOrderCard(order));
  });
}

function renderOrderCard(order) {
  const isNew = state.newOrderSince.has(order.id);
  const card = make(
    'article',
    'order-card status-' + order.status + (isNew ? ' is-new' : '')
  );
  card.dataset.orderId = order.id;

  const header = make('div', 'order-card-header');
  const titleWrap = make('div', 'order-title-wrap');
  titleWrap.appendChild(
    make('div', 'order-pickup', '订单号 ' + (order.pickupNo || '--'))
  );
  titleWrap.appendChild(make('div', 'order-time', formatTime(order.createdAt)));
  header.appendChild(titleWrap);
  header.appendChild(
    make(
      'span',
      'status-badge status-' + order.status,
      (STATUS_TEXT[order.status] || '处理中') + (isNew ? ' · 新' : '')
    )
  );
  card.appendChild(header);

  const meta = make('div', 'order-meta');
  meta.appendChild(make('span', 'order-type', '外卖配送'));
  meta.appendChild(
    make('span', 'order-item-count', '共 ' + order.itemCount + ' 份')
  );
  card.appendChild(meta);

  if (order.accountNickname) {
    card.appendChild(
      make(
        'div',
        'order-customer',
        '顾客 ' + order.accountNickname +
        (order.accountPhone ? ' · ' + order.accountPhone : '')
      )
    );
  }

  const contact = make('div', 'order-contact');
  contact.appendChild(
    make(
      'span',
      'recipient-name',
      '收货 ' + (order.recipientName || '未填写')
    )
  );
  if (order.phone) {
    const phoneLink = document.createElement('a');
    phoneLink.href = 'tel:' + order.phone;
    phoneLink.className = 'phone-link';
    phoneLink.textContent = '电话 ' + order.phone;
    contact.appendChild(phoneLink);
  } else {
    contact.appendChild(make('span', 'muted-text', '未留手机号'));
  }
  card.appendChild(contact);

  card.appendChild(
    make(
      'div',
      'order-address',
      '配送至 ' + (order.address || '（旧订单没有配送地址）')
    )
  );

  if (order.note) {
    card.appendChild(make('div', 'order-note', '备注：' + order.note));
  }

  const items = make('div', 'order-items');
  (order.items || []).forEach((item) => {
    const row = make('div', 'order-item-row');
    row.appendChild(make('span', 'order-item-name', item.name));
    row.appendChild(make('span', 'order-item-count-text', '×' + item.count));
    row.appendChild(
      make('span', 'order-item-subtotal', money(item.subtotalCents))
    );
    items.appendChild(row);
  });
  card.appendChild(items);

  if (order.discountCents > 0) {
    card.appendChild(
      make(
        'div',
        'order-discount',
        '优惠券 ' + (order.coupon ? order.coupon.name : '') +
        '：-' + money(order.discountCents)
      )
    );
  }

  const footer = make('div', 'order-footer');
  const totalWrap = make('div', 'order-total-wrap');
  totalWrap.appendChild(
    make('div', 'order-total', '合计 ' + money(order.totalCents))
  );
  totalWrap.appendChild(
    make(
      'div',
      'order-fee',
      Number(order.deliveryFeeCents) > 0
        ? '含配送费 ' + money(order.deliveryFeeCents)
        : '免配送费'
    )
  );
  footer.appendChild(totalWrap);

  const actions = make('div', 'order-actions');

  if (order.status === 'pending') {
    const cancel = make('button', 'small-button danger', '取消');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.dataset.id = order.id;
    actions.appendChild(cancel);

    const accept = make('button', 'small-button primary', '接单');
    accept.type = 'button';
    accept.dataset.action = 'accept';
    accept.dataset.id = order.id;
    actions.appendChild(accept);
  } else if (order.status === 'making') {
    const cancel = make('button', 'small-button danger', '取消');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.dataset.id = order.id;
    actions.appendChild(cancel);

    const complete = make('button', 'small-button primary', '出餐完成');
    complete.type = 'button';
    complete.dataset.action = 'complete';
    complete.dataset.id = order.id;
    actions.appendChild(complete);
  }

  footer.appendChild(actions);
  card.appendChild(footer);

  card.appendChild(
    make('div', 'order-detail-cue', '点击查看完整订单详情 ›')
  );

  return card;
}

async function changeOrderStatus(id, action, sourceButton) {
  const statusMap = {
    accept: 'making',
    complete: 'completed',
    cancel: 'cancelled',
  };

  const nextStatus = statusMap[action];
  if (!nextStatus) return;

  if (action === 'cancel' && !window.confirm('确定取消这笔订单吗？')) {
    return;
  }

  const button = sourceButton || document.querySelector(
    '[data-action="' + action + '"][data-id="' + id + '"]'
  );

  if (button) {
    button.disabled = true;
    button.textContent = '处理中...';
  }

  try {
    await api(
      '/api/admin/orders/' + encodeURIComponent(id) + '/status',
      {
        method: 'POST',
        body: JSON.stringify({ status: nextStatus }),
      }
    );

    const text = {
      making: '已接单',
      completed: '已完成',
      cancelled: '已取消',
    };
    showToast(text[nextStatus] || '已更新');

    await loadOrders(true);
  } catch (err) {
    showToast(err.message || '操作失败');

    if (button) {
      button.disabled = false;
      button.textContent = action === 'accept'
        ? '接单'
        : action === 'complete'
          ? '出餐完成'
          : '取消';
    }
  }
}

// ==================== 订单详情 ====================

function detailRow(label, value) {
  const row = make('div', 'detail-row');
  row.appendChild(make('span', 'detail-label', label));
  const content = make('span', 'detail-value');
  if (value instanceof Node) content.appendChild(value);
  else content.textContent = value == null || value === '' ? '—' : String(value);
  row.appendChild(content);
  return row;
}

function openOrderDetail(id) {
  state.detailOrderId = id;
  renderOrderDetail();

  els.orderDetailOverlay.classList.remove('hidden');
  els.orderDetailOverlay.setAttribute('aria-hidden', 'false');
  document.body.classList.add('no-scroll');
}

function closeOrderDetail() {
  state.detailOrderId = '';

  if (els.orderDetailOverlay) {
    els.orderDetailOverlay.classList.add('hidden');
    els.orderDetailOverlay.setAttribute('aria-hidden', 'true');
  }

  document.body.classList.remove('no-scroll');
}

function renderOrderDetail() {
  if (!state.detailOrderId) return;

  const order = state.orders.find(
    (item) => item.id === state.detailOrderId
  );

  if (!order) {
    closeOrderDetail();
    return;
  }

  els.orderDetailBody.innerHTML = '';

  const summary = make('div', 'detail-summary');
  const summaryMain = make('div', 'detail-summary-main');
  summaryMain.appendChild(
    make('div', 'detail-pickup', '订单号 ' + (order.pickupNo || '--'))
  );
  summaryMain.appendChild(
    make(
      'div',
      'detail-time',
      '下单 ' + formatTime(order.createdAt) +
      ' · 更新 ' + formatTime(order.updatedAt)
    )
  );
  summary.appendChild(summaryMain);
  summary.appendChild(
    make(
      'span',
      'status-badge status-' + order.status,
      STATUS_TEXT[order.status] || '处理中'
    )
  );
  els.orderDetailBody.appendChild(summary);

  const customer = make('section', 'detail-section');
  customer.appendChild(make('h3', null, '顾客与配送'));

  customer.appendChild(
    detailRow(
      '顾客账号',
      (order.accountNickname || '—') +
      (order.accountPhone ? ' · ' + order.accountPhone : '')
    )
  );
  customer.appendChild(
    detailRow('收货人', order.recipientName || '—')
  );

  if (order.phone) {
    const phoneLink = document.createElement('a');
    phoneLink.href = 'tel:' + order.phone;
    phoneLink.className = 'phone-link';
    phoneLink.textContent = order.phone + '（点击拨打）';
    customer.appendChild(detailRow('收货电话', phoneLink));
  } else {
    customer.appendChild(detailRow('收货电话', '—'));
  }

  const addressWrap = make('span', 'detail-address');
  addressWrap.appendChild(
    document.createTextNode(order.address || '（旧订单没有配送地址）')
  );

  if (
    order.location &&
    Number.isFinite(Number(order.location.lat)) &&
    Number.isFinite(Number(order.location.lng))
  ) {
    const mapLink = document.createElement('a');
    mapLink.className = 'map-link';
    mapLink.target = '_blank';
    mapLink.rel = 'noopener';
    mapLink.href =
      'https://uri.amap.com/marker?position=' +
      encodeURIComponent(order.location.lng + ',' + order.location.lat) +
      '&name=' + encodeURIComponent('送货地址') +
      '&coordinate=gps&callnative=1';
    mapLink.textContent = '打开地图导航';
    addressWrap.appendChild(mapLink);
  }

  customer.appendChild(detailRow('配送地址', addressWrap));
  customer.appendChild(detailRow('订单备注', order.note || '无'));
  els.orderDetailBody.appendChild(customer);

  const items = make('section', 'detail-section');
  items.appendChild(make('h3', null, '菜品明细'));

  const itemHead = make('div', 'detail-item-row head');
  itemHead.appendChild(make('span', null, '菜品'));
  itemHead.appendChild(make('span', null, '计价'));
  itemHead.appendChild(make('span', null, '小计'));
  items.appendChild(itemHead);

  (order.items || []).forEach((item) => {
    const row = make('div', 'detail-item-row');
    row.appendChild(make('span', 'detail-item-name', item.name));
    row.appendChild(
      make(
        'span',
        null,
        item.priceSummary ||
          (money(item.priceCents) + ' × ' + item.count)
      )
    );
    row.appendChild(make('span', null, money(item.subtotalCents)));
    items.appendChild(row);
  });

  const totals = make('div', 'detail-totals');
  totals.appendChild(
    detailTotalRow('商品小计', money(order.subtotalCents))
  );
  totals.appendChild(
    detailTotalRow(
      '配送费',
      Number(order.deliveryFeeCents) > 0
        ? money(order.deliveryFeeCents)
        : '免配送费'
    )
  );

  if (order.discountCents > 0) {
    totals.appendChild(
      detailTotalRow(
        '优惠券' + (order.coupon ? '（' + order.coupon.name + '）' : ''),
        '-' + money(order.discountCents)
      )
    );
  }

  const totalRow = make('div', 'detail-total-row grand');
  totalRow.appendChild(make('span', null, '合计'));
  totalRow.appendChild(
    make('strong', null, money(order.totalCents))
  );
  totals.appendChild(totalRow);
  items.appendChild(totals);
  els.orderDetailBody.appendChild(items);

  const actions = make('section', 'detail-actions');

  if (order.status === 'pending') {
    const cancel = make('button', 'small-button danger', '取消订单');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.dataset.id = order.id;
    actions.appendChild(cancel);

    const accept = make('button', 'small-button primary', '接单');
    accept.type = 'button';
    accept.dataset.action = 'accept';
    accept.dataset.id = order.id;
    actions.appendChild(accept);
  } else if (order.status === 'making') {
    const cancel = make('button', 'small-button danger', '取消订单');
    cancel.type = 'button';
    cancel.dataset.action = 'cancel';
    cancel.dataset.id = order.id;
    actions.appendChild(cancel);

    const complete = make('button', 'small-button primary', '出餐完成');
    complete.type = 'button';
    complete.dataset.action = 'complete';
    complete.dataset.id = order.id;
    actions.appendChild(complete);
  } else {
    actions.appendChild(
      make(
        'p',
        'muted-text',
        order.status === 'completed'
          ? '该订单已完成'
          : '该订单已取消'
      )
    );
  }

  els.orderDetailBody.appendChild(actions);
}

function detailTotalRow(label, value) {
  const row = make('div', 'detail-total-row');
  row.appendChild(make('span', null, label));
  row.appendChild(make('strong', null, value));
  return row;
}

// ==================== 菜品管理 ====================

async function loadMenu() {
  const data = await api('/api/admin/menu');
  state.menu = Array.isArray(data.menu) ? data.menu : [];
  state.categories = Array.isArray(data.categories) ? data.categories : [];
  renderMenu();
}

function renderMenu() {
  els.adminMenuList.innerHTML = '';

  const query = state.dishQuery.trim().toLowerCase();
  const filtered = query
    ? state.menu.filter((dish) => {
        return [dish.name, dish.category, dish.tag, dish.desc]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
    : state.menu;

  if (filtered.length === 0) {
    els.adminMenuList.appendChild(
      make('p', 'admin-menu-empty', '没有找到匹配的菜品')
    );
    return;
  }

  const categories = state.categories.filter((category) =>
    filtered.some((dish) => dish.category === category)
  );

  categories.forEach((category) => {
    const items = filtered
      .filter((dish) => dish.category === category)
      .sort((a, b) => a.sort - b.sort);

    if (items.length === 0) return;

    const section = make('section', 'menu-group');
    section.appendChild(make('h2', 'menu-group-title', category));

    items.forEach((dish) => {
      const row = make('div', 'admin-dish-row');

      const thumb = make(
        'span',
        'admin-dish-emoji' + (dish.imageUrl ? ' admin-dish-photo' : ''),
        dish.imageUrl ? '' : (dish.emoji || '🍢')
      );
      if (dish.imageUrl) {
        const img = document.createElement('img');
        img.src = dish.imageUrl;
        img.alt = dish.name;
        img.loading = 'lazy';
        thumb.appendChild(img);
      }
      row.appendChild(thumb);

      const info = make('div', 'admin-dish-info');
      info.appendChild(make('div', 'admin-dish-name', dish.name));
      info.appendChild(
        make(
          'div',
          'admin-dish-meta',
          formatDishPricing(dish) +
          (dish.tag ? ' · ' + dish.tag : '')
        )
      );
      row.appendChild(info);

      let statusText = '在售';
      let statusClass = 'status-completed';

      if (!dish.enabled) {
        statusText = '已下架';
        statusClass = 'status-cancelled';
      } else if (dish.soldOut) {
        statusText = '已售罄';
        statusClass = 'status-pending';
      }

      row.appendChild(
        make('span', 'status-badge ' + statusClass, statusText)
      );

      const actions = make('div', 'dish-row-actions');

      const edit = make('button', 'small-button', '编辑');
      edit.type = 'button';
      edit.dataset.action = 'edit-dish';
      edit.dataset.id = dish.id;
      actions.appendChild(edit);

      const soldOut = make(
        'button',
        'small-button ' + (dish.soldOut ? 'primary' : 'danger'),
        dish.soldOut ? '恢复' : '标售罄'
      );
      soldOut.type = 'button';
      soldOut.dataset.action = 'toggle-soldout';
      soldOut.dataset.id = dish.id;
      actions.appendChild(soldOut);

      const enabled = make(
        'button',
        'small-button ' + (dish.enabled ? 'danger' : 'primary'),
        dish.enabled ? '下架' : '上架'
      );
      enabled.type = 'button';
      enabled.dataset.action = 'toggle-enabled';
      enabled.dataset.id = dish.id;
      actions.appendChild(enabled);

      row.appendChild(actions);
      section.appendChild(row);
    });

    els.adminMenuList.appendChild(section);
  });
}

function openDishForm(dish) {
  state.editingDishId = dish ? dish.id : '';
  state.dishImageUrl = dish ? dish.imageUrl || '' : '';
  state.dishTiers = dish && Array.isArray(dish.bundleTiers)
    ? dish.bundleTiers.map((tier) => ({
        quantity: String(tier.quantity),
        totalPrice: centsToInput(tier.totalPriceCents),
      }))
    : [];

  els.dishFormTitle.textContent = dish ? '编辑菜品' : '新增菜品';
  els.dishId.value = dish ? dish.id : '';
  els.dishName.value = dish ? dish.name : '';
  els.dishCategory.value = dish ? dish.category : '';
  els.dishPrice.value = dish ? centsToInput(dish.priceCents) : '';
  els.dishUnit.value = dish ? dish.unit : '份';
  els.dishEmoji.value = dish ? dish.emoji : '🍢';
  els.dishTag.value = dish ? dish.tag || '' : '';
  els.dishDesc.value = dish ? dish.desc || '' : '';
  setDishImagePreview(state.dishImageUrl);
  renderDishTiers();
  els.dishSoldOut.checked = dish ? !!dish.soldOut : false;
  els.dishEnabled.checked = dish ? dish.enabled !== false : true;

  els.dishForm.classList.remove('hidden');
  els.dishName.focus();
}

function closeDishForm() {
  state.editingDishId = '';
  state.dishTiers = [];
  els.dishForm.classList.add('hidden');
}

function readDishTiers(priceCents) {
  const rows = state.dishTiers.filter(
    (tier) => String(tier.quantity).trim() || String(tier.totalPrice).trim()
  );
  const seen = new Set();

  return rows.map((tier) => {
    const quantity = Number(tier.quantity);
    const totalPriceCents = Math.round(Number(tier.totalPrice) * 100);

    if (
      !Number.isInteger(quantity) ||
      quantity < 2 ||
      quantity > 99 ||
      !(totalPriceCents > 0)
    ) {
      throw new Error('请完整填写数量优惠，数量需为 2–99 的整数');
    }

    if (seen.has(quantity)) {
      throw new Error('数量优惠中有重复数量');
    }
    seen.add(quantity);

    if (totalPriceCents >= priceCents * quantity) {
      throw new Error(
        `买 ${quantity} 个的合计金额需低于 ` +
        compactPrice(priceCents * quantity)
      );
    }

    return { quantity, totalPriceCents };
  });
}

async function saveDish(event) {
  event.preventDefault();

  const name = els.dishName.value.trim();
  const category = els.dishCategory.value.trim();
  const priceCents = Math.round(Number(els.dishPrice.value) * 100);

  if (!name) return showToast('请填写菜品名称');
  if (!category) return showToast('请填写菜品分类');
  if (!(priceCents > 0)) return showToast('价格必须大于 0');

  let bundleTiers = [];
  try {
    bundleTiers = readDishTiers(priceCents);
  } catch (err) {
    return showToast(err.message || '数量优惠填写不正确');
  }

  const button = els.saveDishBtn;
  button.disabled = true;
  button.textContent = '保存中...';

  try {
    await api('/api/admin/menu', {
      method: 'POST',
      body: JSON.stringify({
        id: state.editingDishId || undefined,
        name,
        category,
        priceCents,
        unit: els.dishUnit.value.trim() || '份',
        emoji: els.dishEmoji.value.trim() || '🍢',
        tag: els.dishTag.value.trim(),
        desc: els.dishDesc.value.trim(),
        imageUrl: state.dishImageUrl,
        bundleTiers,
        soldOut: els.dishSoldOut.checked,
        enabled: els.dishEnabled.checked,
      }),
    });

    closeDishForm();
    await loadMenu();
    showToast('菜品已保存');
  } catch (err) {
    showToast(err.message || '保存失败');
  } finally {
    button.disabled = false;
    button.textContent = '保存';
  }
}

async function toggleDishStatus(id, field, value) {
  const action = field === 'soldOut' ? 'toggle-soldout' : 'toggle-enabled';
  const button = document.querySelector(
    '[data-action="' + action + '"][data-id="' + id + '"]'
  );

  if (button) button.disabled = true;

  try {
    const payload = {};
    payload[field === 'soldOut' ? 'soldOut' : 'enabled'] = value;

    await api(
      '/api/admin/menu/' + encodeURIComponent(id) + '/status',
      {
        method: 'POST',
        body: JSON.stringify(payload),
      }
    );

    await loadMenu();
    showToast(
      field === 'soldOut'
        ? (value ? '已标售罄' : '已恢复')
        : (value ? '已上架' : '已下架')
    );
  } catch (err) {
    showToast(err.message || '操作失败');
    if (button) button.disabled = false;
  }
}

// ==================== 优惠券管理 ====================

async function loadCouponsAdmin() {
  const data = await api('/api/admin/coupons');
  state.couponTemplates = Array.isArray(data.templates)
    ? data.templates
    : [];
  state.issuedCoupons = Array.isArray(data.issued)
    ? data.issued
    : [];
  state.customers = Array.isArray(data.customers) ? data.customers : [];

  renderCouponsAdmin();
  renderCustomers();
  renderIssuedCoupons();
}

function renderCouponsAdmin() {
  els.adminCouponList.innerHTML = '';

  state.couponTemplates.forEach((template) => {
    const card = make('div', 'coupon-admin-card');

    const main = make('div', 'coupon-admin-main');
    main.appendChild(make('div', 'coupon-admin-name', template.name));
    main.appendChild(
      make(
        'div',
        'coupon-admin-meta',
        '满 ' + money(template.thresholdCents) +
        ' 减 ' + money(template.discountCents)
      )
    );
    main.appendChild(
      make(
        'div',
        'coupon-admin-flags',
        [
          template.autoIssue ? '新人自动发' : '手动发放',
          template.onlyFirstOrder ? '仅限首单' : '不限首单',
          template.enabled ? '启用' : '停用',
        ].join(' · ')
      )
    );
    card.appendChild(main);

    const actions = make('div', 'coupon-admin-actions');

    const edit = make('button', 'small-button', '编辑');
    edit.type = 'button';
    edit.dataset.action = 'edit-coupon';
    edit.dataset.id = template.id;
    actions.appendChild(edit);

    const toggle = make(
      'button',
      'small-button ' + (template.enabled ? 'danger' : 'primary'),
      template.enabled ? '停用' : '启用'
    );
    toggle.type = 'button';
    toggle.dataset.action = 'toggle-coupon';
    toggle.dataset.id = template.id;
    actions.appendChild(toggle);

    card.appendChild(actions);
    els.adminCouponList.appendChild(card);
  });

  // 发放下拉框
  const previous = els.couponIssueTemplate.value;
  els.couponIssueTemplate.innerHTML = '';

  state.couponTemplates
    .filter((template) => template.enabled)
    .forEach((template) => {
      const option = document.createElement('option');
      option.value = template.id;
      option.textContent =
        template.name + '（满 ' + money(template.thresholdCents) +
        ' 减 ' + money(template.discountCents) + '）';
      els.couponIssueTemplate.appendChild(option);
    });

  if (previous) els.couponIssueTemplate.value = previous;
}

function renderCustomers() {
  els.adminCustomers.innerHTML = '';

  if (state.customers.length === 0) {
    els.adminCustomers.appendChild(
      make('p', 'muted-text', '还没有完成登录的顾客')
    );
    return;
  }

  state.customers.slice(0, 100).forEach((customer) => {
    const row = make('div', 'customer-row');

    const avatar = make('span', 'customer-avatar');
    setAvatar(avatar, customer.avatar);
    row.appendChild(avatar);

    const info = make('div', 'customer-info');
    info.appendChild(
      make(
        'div',
        'customer-name',
        customer.nickname + ' · ' + customer.phone
      )
    );
    info.appendChild(
      make(
        'div',
        'customer-meta',
        '订单 ' + customer.orderCount + ' 笔' +
        (customer.lastOrderAt
          ? ' · 最近 ' + formatTime(customer.lastOrderAt)
          : ' · 还没有下单')
      )
    );
    row.appendChild(info);

    const fill = make('button', 'small-button', '填入');
    fill.type = 'button';
    fill.dataset.phone = customer.phone;
    row.appendChild(fill);

    els.adminCustomers.appendChild(row);
  });
}

function renderIssuedCoupons() {
  els.adminIssuedCoupons.innerHTML = '';

  if (state.issuedCoupons.length === 0) {
    els.adminIssuedCoupons.appendChild(
      make('p', 'muted-text', '还没有发放记录')
    );
    return;
  }

  state.issuedCoupons.slice(0, 50).forEach((coupon) => {
    const row = make('div', 'issued-row');
    row.appendChild(
      make(
        'span',
        'issued-name',
        coupon.name + '（满 ' + money(coupon.thresholdCents) +
        ' 减 ' + money(coupon.discountCents) + '）'
      )
    );
    row.appendChild(
      make(
        'span',
        'issued-status ' + (coupon.status === 'unused' ? 'unused' : 'used'),
        coupon.status === 'unused' ? '未使用' : '已使用'
      )
    );

    const target = coupon.accountNickname
      ? coupon.accountNickname + ' · ' + (coupon.phone || '')
      : (coupon.phone || (coupon.legacyDeviceId ? '旧设备券' : '未知账号'));

    row.appendChild(
      make('span', 'issued-target', target)
    );
    els.adminIssuedCoupons.appendChild(row);
  });
}

function openCouponForm(template) {
  state.editingCouponId = template ? template.id : '';

  els.couponFormTitle.textContent = template ? '编辑优惠券' : '新增优惠券';
  els.couponId.value = template ? template.id : '';
  els.couponName.value = template ? template.name : '';
  els.couponThreshold.value = template
    ? centsToInput(template.thresholdCents)
    : '';
  els.couponDiscount.value = template
    ? centsToInput(template.discountCents)
    : '';
  els.couponAutoIssue.checked = template ? !!template.autoIssue : false;
  els.couponOnlyFirstOrder.checked = template
    ? !!template.onlyFirstOrder
    : false;
  els.couponEnabled.checked = template ? template.enabled !== false : true;

  els.couponForm.classList.remove('hidden');
  els.couponName.focus();
}

function closeCouponForm() {
  state.editingCouponId = '';
  els.couponForm.classList.add('hidden');
}

async function saveCoupon(event) {
  event.preventDefault();

  const name = els.couponName.value.trim();
  const thresholdCents = Math.round(
    Number(els.couponThreshold.value) * 100
  );
  const discountCents = Math.round(
    Number(els.couponDiscount.value) * 100
  );

  if (!name) return showToast('请填写优惠券名称');
  if (!(thresholdCents > 0)) return showToast('门槛必须大于 0');
  if (!(discountCents > 0)) return showToast('优惠金额必须大于 0');
  if (discountCents > thresholdCents) {
    return showToast('优惠金额不能大于门槛');
  }

  const button = els.saveCouponBtn;
  button.disabled = true;
  button.textContent = '保存中...';

  try {
    await api('/api/admin/coupons', {
      method: 'POST',
      body: JSON.stringify({
        id: state.editingCouponId || undefined,
        name,
        thresholdCents,
        discountCents,
        autoIssue: els.couponAutoIssue.checked,
        onlyFirstOrder: els.couponOnlyFirstOrder.checked,
        enabled: els.couponEnabled.checked,
      }),
    });

    closeCouponForm();
    await loadCouponsAdmin();
    showToast('优惠券已保存');
  } catch (err) {
    showToast(err.message || '保存失败');
  } finally {
    button.disabled = false;
    button.textContent = '保存';
  }
}

async function toggleCouponEnabled(template) {
  try {
    await api('/api/admin/coupons', {
      method: 'POST',
      body: JSON.stringify({
        id: template.id,
        name: template.name,
        thresholdCents: template.thresholdCents,
        discountCents: template.discountCents,
        autoIssue: template.autoIssue,
        onlyFirstOrder: template.onlyFirstOrder,
        enabled: !template.enabled,
      }),
    });

    await loadCouponsAdmin();
    showToast(template.enabled ? '已停用' : '已启用');
  } catch (err) {
    showToast(err.message || '操作失败');
  }
}

async function issueCoupon() {
  const templateId = els.couponIssueTemplate.value;
  const phone = els.couponIssuePhone.value.trim();

  if (!templateId) return showToast('请先选择优惠券');
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    return showToast('请输入顾客的 11 位手机号');
  }

  const button = els.issueToPhoneBtn;
  button.disabled = true;
  button.textContent = '发放中...';

  try {
    const data = await api('/api/admin/coupons/issue', {
      method: 'POST',
      body: JSON.stringify({ templateId, phone }),
    });

    await loadCouponsAdmin();
    showToast(data.message || ('已发放 ' + data.issued + ' 张'));
  } catch (err) {
    showToast(err.message || '发放失败');
  } finally {
    button.disabled = false;
    button.textContent = '发给该手机号';
  }
}

// ==================== 提示音 ====================

function ensureAudio() {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) return null;

  if (!state.audioCtx) {
    try {
      state.audioCtx = new AudioCtx();
    } catch (err) {
      return null;
    }
  }

  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume().catch(() => {});
  }

  return state.audioCtx;
}

function playBeep(isTest) {
  const ctx = ensureAudio();

  if (!ctx) {
    if (isTest) showToast('当前浏览器不支持提示音');
    return;
  }

  const now = ctx.currentTime;
  const tones = [
    { freq: 880, start: 0 },
    { freq: 1175, start: 0.2 },
  ];

  tones.forEach((tone) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const start = now + tone.start;

    osc.type = 'sine';
    osc.frequency.setValueAtTime(tone.freq, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.28, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.17);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(start + 0.19);
  });

  if (navigator.vibrate) {
    try {
      navigator.vibrate([200, 100, 200]);
    } catch (err) {
      // 忽略震动失败
    }
  }

  if (isTest) showToast('测试提示音已播放');
}

// ==================== 轮询 / 导航 ====================

function startPolling() {
  stopPolling();

  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (!state.token) return;

    loadOrders().catch((err) => {
      if (err.status !== 401) console.warn('自动刷新订单失败', err);
    });
  }, POLL_INTERVAL);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function switchTab(tab) {
  state.activeTab = tab;

  document.querySelectorAll('.admin-tab').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });

  els.ordersPanel.classList.toggle('hidden', tab !== 'orders');
  els.menuPanel.classList.toggle('hidden', tab !== 'menu');
  els.couponsPanel.classList.toggle('hidden', tab !== 'coupons');

  if (tab === 'menu') {
    loadMenu().catch((err) => {
      if (err.status !== 401) showToast(err.message || '菜品加载失败');
    });
  } else if (tab === 'coupons') {
    loadCouponsAdmin().catch((err) => {
      if (err.status !== 401) showToast(err.message || '优惠券加载失败');
    });
  }
}

function switchFilter(filter) {
  state.activeFilter = filter;

  document.querySelectorAll('.filter-chip').forEach((button) => {
    button.classList.toggle('active', button.dataset.filter === filter);
  });

  renderOrders();
}

async function refreshCurrentTab() {
  try {
    if (state.activeTab === 'orders') {
      await loadOrders();
    } else if (state.activeTab === 'menu') {
      await loadMenu();
    } else {
      await loadCouponsAdmin();
    }
    showToast('已刷新');
  } catch (err) {
    if (err.status !== 401) showToast(err.message || '刷新失败');
  }
}

async function exportBackup() {
  const button = els.exportBtn;
  button.disabled = true;
  button.textContent = '导出中...';

  try {
    const data = await api('/api/admin/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');

    link.href = url;
    link.download =
      '嘎嘎香备份-' +
      now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) +
      '-' + pad(now.getHours()) + pad(now.getMinutes()) + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('数据备份已下载');
  } catch (err) {
    if (err.status !== 401) showToast(err.message || '备份失败');
  } finally {
    button.disabled = false;
    button.textContent = '备份数据';
  }
}

// ==================== 事件绑定 / 启动 ====================

function bindEvents() {
  els.loginForm.addEventListener('submit', handleLogin);
  els.logoutBtn.addEventListener('click', handleLogout);
  els.refreshBtn.addEventListener('click', refreshCurrentTab);
  els.exportBtn.addEventListener('click', exportBackup);

  els.testSoundBtn.addEventListener('click', () => playBeep(true));

  document.querySelectorAll('.admin-tab').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });

  els.orderFilters.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-filter]');
    if (chip) switchFilter(chip.dataset.filter);
  });

  els.ordersList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (button) {
      changeOrderStatus(button.dataset.id, button.dataset.action, button);
      return;
    }

    const card = event.target.closest('[data-order-id]');
    if (card) openOrderDetail(card.dataset.orderId);
  });

  els.closeOrderDetailBtn.addEventListener('click', closeOrderDetail);
  els.orderDetailOverlay.addEventListener('click', (event) => {
    if (event.target === els.orderDetailOverlay) closeOrderDetail();
  });
  els.orderDetailBody.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    changeOrderStatus(button.dataset.id, button.dataset.action, button);
  });

  // 菜品
  els.addDishBtn.addEventListener('click', () => openDishForm(null));
  els.cancelDishBtn.addEventListener('click', closeDishForm);
  els.dishForm.addEventListener('submit', saveDish);
  els.addDishTierBtn.addEventListener('click', () => {
    if (state.dishTiers.length >= 8) {
      showToast('最多设置 8 档数量优惠');
      return;
    }

    state.dishTiers.push({ quantity: '', totalPrice: '' });
    renderDishTiers();

    const inputs = els.dishTierList.querySelectorAll(
      '[data-tier-field="quantity"]'
    );
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });
  els.dishUnit.addEventListener('input', renderDishTiers);
  els.dishTierList.addEventListener('input', (event) => {
    const field = event.target.dataset.tierField;
    const row = event.target.closest('[data-tier-index]');
    if (!field || !row) return;

    const tier = state.dishTiers[Number(row.dataset.tierIndex)];
    if (!tier) return;
    tier[field] = event.target.value;
  });
  els.dishTierList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-remove-tier]');
    if (!button) return;

    state.dishTiers.splice(Number(button.dataset.removeTier), 1);
    renderDishTiers();
  });
  els.chooseDishImageBtn.addEventListener('click', () => {
    els.dishImageInput.click();
  });
  els.removeDishImageBtn.addEventListener('click', () => {
    state.dishImageUrl = '';
    els.dishImageInput.value = '';
    setDishImagePreview('');
  });
  els.dishImageInput.addEventListener('change', () => {
    const file = els.dishImageInput.files && els.dishImageInput.files[0];
    if (!file) return;

    els.chooseDishImageBtn.disabled = true;
    els.chooseDishImageBtn.textContent = '处理中...';

    fileToDishImage(file)
      .then((dataUrl) => {
        state.dishImageUrl = dataUrl;
        setDishImagePreview(dataUrl);
      })
      .catch((err) => showToast(err.message || '图片处理失败'))
      .finally(() => {
        els.dishImageInput.value = '';
        els.chooseDishImageBtn.disabled = false;
        els.chooseDishImageBtn.textContent = '选择图片';
      });
  });
  els.dishSearchInput.addEventListener('input', () => {
    state.dishQuery = els.dishSearchInput.value.trim();
    renderMenu();
  });

  els.adminMenuList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const dish = state.menu.find((item) => item.id === button.dataset.id);
    if (!dish) return;

    if (button.dataset.action === 'edit-dish') {
      openDishForm(dish);
    } else if (button.dataset.action === 'toggle-soldout') {
      toggleDishStatus(dish.id, 'soldOut', !dish.soldOut);
    } else if (button.dataset.action === 'toggle-enabled') {
      toggleDishStatus(dish.id, 'enabled', dish.enabled === false);
    }
  });

  // 优惠券
  els.addCouponBtn.addEventListener('click', () => openCouponForm(null));
  els.cancelCouponBtn.addEventListener('click', closeCouponForm);
  els.couponForm.addEventListener('submit', saveCoupon);

  els.adminCouponList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const template = state.couponTemplates.find(
      (item) => item.id === button.dataset.id
    );
    if (!template) return;

    if (button.dataset.action === 'edit-coupon') {
      openCouponForm(template);
    } else if (button.dataset.action === 'toggle-coupon') {
      toggleCouponEnabled(template);
    }
  });

  els.adminCustomers.addEventListener('click', (event) => {
    const button = event.target.closest('[data-phone]');
    if (!button) return;
    els.couponIssuePhone.value = button.dataset.phone;
    els.couponIssuePhone.focus();
  });

  els.issueToPhoneBtn.addEventListener('click', issueCoupon);

  document.addEventListener('click', () => ensureAudio(), { once: true });

  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      !els.orderDetailOverlay.classList.contains('hidden')
    ) {
      closeOrderDetail();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (
      !document.hidden &&
      state.token &&
      !els.dashboardView.classList.contains('hidden')
    ) {
      loadOrders().catch(() => {});
    }
  });
}

async function init() {
  cacheElements();
  bindEvents();

  if (!state.token) {
    showLogin('');
    return;
  }

  await enterDashboard();
}

document.addEventListener('DOMContentLoaded', init);
