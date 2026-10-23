'use strict';

// public/app.js —— 顾客端 H5 外卖点单逻辑
// 金额全部使用「分」；客户端只提交菜品 id、数量、优惠券 id 和配送信息，
// 最终价格（含配送费）由服务端重新计算。

const STORAGE_CART = 'h5_order_cart_v1';
const STORAGE_USER_TOKEN = 'h5_user_token';
const STORAGE_MENU_CACHE = 'h5_order_menu_cache_v1';
const POLL_INTERVAL = 10000;
const MENU_REFRESH_INTERVAL = 15000;

const STATUS_TEXT = {
  pending: '待接单',
  making: '制作中',
  completed: '已完成',
  cancelled: '已取消',
};

const PRESET_AVATARS = ['🍢', '🥩', '🌶️', '🍗', '🐱', '🐶', '🐼', '😎'];

const state = {
  store: {},
  menu: [],
  menuById: new Map(),
  categories: ['全部'],
  currentCategory: '全部',
  cart: {},
  coupons: [],
  selectedCouponId: '',
  currentOrder: null,
  history: [],
  pollTimer: null,
  menuTimer: null,
  submitting: false,
  loadingMenu: false,
  loadingMenuPromise: null,
  user: null,
  authConfig: {},
  autoLoginInFlight: false,
  profileAvatar: '',
  addressLocation: null,
  locating: false,
  menuQuery: '',
  recommendations: { recent: [], popular: [] },
  ignoreHash: false,
  successReturn: 'menu',
  eventsBound: false,
};

const $ = (id) => document.getElementById(id);
const els = {};

function cacheElements() {
  [
    'authView', 'authLoginStep', 'authProfileStep', 'entryStatus',
    'entryRetryBtn', 'authError', 'avatarPreview', 'avatarUploadBtn',
    'avatarFileInput', 'avatarPresets', 'nicknameInput', 'authPhoneInput',
    'saveProfileBtn', 'profileError', 'phoneFrame', 'storeName',
    'storeHours', 'storeNotice', 'menuSearchInput', 'clearMenuSearchBtn',
    'recommendationArea', 'openOrdersBtn', 'headerAvatar',
    'headerNickname', 'categoryBar', 'menuList', 'menuLoading',
    'cartSummaryBtn', 'cartBadge', 'cartTotal', 'checkoutBtn',
    'cartOverlay', 'cartItemList', 'sheetTotal', 'clearCartBtn',
    'sheetCheckoutBtn', 'closeCartBtn', 'checkoutView', 'checkoutBackBtn',
    'checkoutItems', 'checkoutSubtotal', 'checkoutDeliveryFee',
    'deliveryFeeHint', 'couponList', 'couponEmpty', 'checkoutDiscountRow',
    'checkoutDiscount', 'checkoutTotal', 'recipientNameInput', 'phoneInput',
    'addressInput', 'noteInput', 'locateBtn', 'locateHint',
    'submitOrderBtn', 'successView', 'successBackBtn', 'successRefreshBtn',
    'pickupNo', 'successTip', 'statusBadge', 'successInfo',
    'successItems', 'successSubtotal', 'successDeliveryFee',
    'successDiscountRow', 'successDiscount', 'successTotal',
    'continueOrderBtn', 'successMyOrdersBtn', 'ordersView', 'ordersBackBtn',
    'profileAvatar', 'profileNickname', 'profilePhone', 'ordersList',
    'toast',
  ].forEach((id) => {
    els[id] = $(id);
  });
}

// ==================== 通用 ====================

function getToken() {
  try {
    return localStorage.getItem(STORAGE_USER_TOKEN) || '';
  } catch (err) {
    return '';
  }
}

function setToken(token) {
  try {
    localStorage.setItem(STORAGE_USER_TOKEN, token);
  } catch (err) {
    // 忽略
  }
}

function clearToken() {
  try {
    localStorage.removeItem(STORAGE_USER_TOKEN);
  } catch (err) {
    // 忽略
  }
}

async function api(url, options) {
  const opts = options || {};
  const headers = Object.assign(
    { 'Content-Type': 'application/json' },
    opts.headers || {}
  );
  const token = getToken();

  if (token) headers['x-user-token'] = token;

  const response = await fetch(url, {
    method: opts.method || 'GET',
    headers,
    body: opts.body,
    cache: 'no-store',
  });

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请稍后重试');
    error.status = response.status;

    if (response.status === 401 && !opts.skipAuthRedirect) {
      handleSessionExpired();
    }

    throw error;
  }

  return data;
}

function money(cents) {
  const n = Math.round(Number(cents) || 0);
  return '¥' + (n / 100).toFixed(2);
}

function formatTime(timestamp) {
  if (!timestamp) return '';
  const d = new Date(Number(timestamp));
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (
    d.getMonth() + 1 + '月' + d.getDate() + '日 ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes())
  );
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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

function isTerminal(status) {
  return status === 'completed' || status === 'cancelled';
}

function statusText(status) {
  return STATUS_TEXT[status] || '处理中';
}

function updateBodyLock() {
  if (!els.cartOverlay) return;

  const locked = !els.cartOverlay.classList.contains('hidden') ||
    !els.checkoutView.classList.contains('hidden') ||
    !els.successView.classList.contains('hidden') ||
    !els.ordersView.classList.contains('hidden');
  document.body.classList.toggle('no-scroll', locked);
}

function blurInside(element) {
  if (
    document.activeElement &&
    element &&
    element.contains(document.activeElement) &&
    typeof document.activeElement.blur === 'function'
  ) {
    document.activeElement.blur();
  }
}

function maskPhone(phone) {
  const value = String(phone || '');
  return /^\d{11}$/.test(value)
    ? value.slice(0, 3) + '****' + value.slice(7)
    : value;
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

function deliverySettings() {
  const store = state.store || {};
  let fee = Number(store.deliveryFeeCents);
  let threshold = Number(store.freeDeliveryThresholdCents);

  if (!Number.isFinite(fee)) fee = Number(state.authConfig.deliveryFeeCents);
  if (!Number.isFinite(threshold)) {
    threshold = Number(state.authConfig.freeDeliveryThresholdCents);
  }

  if (!Number.isFinite(fee)) fee = 300;
  if (!Number.isFinite(threshold)) threshold = 5000;

  return { feeCents: fee, thresholdCents: threshold };
}

// ==================== 登录 / 资料 ====================

async function loadAuthConfig() {
  try {
    const data = await api('/api/auth/config', { skipAuthRedirect: true });
    state.authConfig = data || {};
  } catch (err) {
    state.authConfig = {};
  }
}

function cleanUrlParams() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('loginCode');
    url.searchParams.delete('authError');
    window.history.replaceState(
      null,
      '',
      url.pathname + url.search + url.hash
    );
  } catch (err) {
    // 忽略
  }
}

function showEntryLoading(message) {
  stopPolling();
  els.authView.classList.remove('hidden');
  els.authLoginStep.classList.remove('hidden');
  els.authProfileStep.classList.add('hidden');
  els.phoneFrame.classList.add('hidden');
  els.entryRetryBtn.classList.add('hidden');
  els.entryStatus.textContent = message || '正在进入点单页面...';
  els.authError.textContent = '';
  updateBodyLock();
}

function showEntryError(message) {
  showEntryLoading('暂时无法进入点单页面');
  els.entryRetryBtn.classList.remove('hidden');
  els.authError.textContent = message || '请检查网络后重试';
}

function showProfileStep(message) {
  const user = state.user || {};

  els.authView.classList.remove('hidden');
  els.authLoginStep.classList.add('hidden');
  els.authProfileStep.classList.remove('hidden');
  els.phoneFrame.classList.add('hidden');
  els.profileError.textContent = message || '';

  els.nicknameInput.value =
    user.prefillNickname || user.nickname || '';
  els.authPhoneInput.value = user.phone || '';
  state.profileAvatar =
    user.prefillAvatar || user.avatar || PRESET_AVATARS[0];

  renderProfileAvatar();
  renderAvatarPresets();
  updateBodyLock();
}

function renderProfileAvatar() {
  setAvatar(els.avatarPreview, state.profileAvatar || '🍢');
}

function renderAvatarPresets() {
  els.avatarPresets.innerHTML = '';

  PRESET_AVATARS.forEach((emoji) => {
    const button = make('button', 'avatar-choice', emoji);
    button.type = 'button';
    button.dataset.avatar = emoji;
    button.setAttribute('aria-label', '选择头像 ' + emoji);

    if (state.profileAvatar === emoji) {
      button.classList.add('active');
    }

    els.avatarPresets.appendChild(button);
  });
}

async function exchangeLoginCode(code) {
  const data = await api('/api/auth/exchange', {
    method: 'POST',
    body: JSON.stringify({ code }),
    skipAuthRedirect: true,
  });

  setToken(data.token);
  state.user = data.user;
}

async function autoLogin(fallbackMessage) {
  if (state.autoLoginInFlight) return;

  state.autoLoginInFlight = true;
  showEntryLoading('正在进入点单页面...');

  try {
    // 静默进入，不显示任何微信登录界面。
    // localOnly 确保即使配置了公众号，自动进入也不会跳转微信授权。
    const data = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ localOnly: true }),
      skipAuthRedirect: true,
    });

    if (!data.token || !data.user) {
      throw new Error('进入失败，请重试');
    }

    setToken(data.token);
    state.user = data.user;

    if (state.user.profileComplete) {
      await startApp();
    } else {
      showProfileStep('');
    }
  } catch (err) {
    showEntryError(
      err.message || fallbackMessage || '网络连接失败，请重试'
    );
  } finally {
    state.autoLoginInFlight = false;
  }
}

async function saveProfile() {
  const nickname = els.nicknameInput.value.trim();
  const phone = els.authPhoneInput.value.trim();

  els.profileError.textContent = '';

  if (!nickname) {
    els.profileError.textContent = '请填写昵称';
    els.nicknameInput.focus();
    return;
  }

  if (!/^1[3-9]\d{9}$/.test(phone)) {
    els.profileError.textContent = '请输入正确的 11 位手机号';
    els.authPhoneInput.focus();
    return;
  }

  if (!state.profileAvatar) {
    els.profileError.textContent = '请选择头像';
    return;
  }

  const button = els.saveProfileBtn;
  button.disabled = true;
  button.textContent = '保存中...';

  try {
    const data = await api('/api/auth/profile', {
      method: 'POST',
      body: JSON.stringify({
        nickname,
        phone,
        avatar: state.profileAvatar,
      }),
    });

    state.user = data.user;
    await startApp();
    showToast('资料已保存');
  } catch (err) {
    if (err.status === 401) {
      handleSessionExpired();
      return;
    } else if (err.status === 409 && err.message.indexOf('不可修改') >= 0) {
      // 其他页面已经完成过资料设置
      try {
        const me = await api('/api/me', { skipAuthRedirect: true });
        state.user = me.user;
        if (state.user.profileComplete) {
          await startApp();
          return;
        }
      } catch (refreshErr) {
        // 忽略，显示原错误
      }
      els.profileError.textContent = err.message;
    } else {
      els.profileError.textContent = err.message || '保存失败，请重试';
    }
  } finally {
    button.disabled = false;
    button.textContent = '完成，开始点单';
  }
}

function fileToAvatar(file) {
  return new Promise((resolve, reject) => {
    if (!file || !/^image\//.test(file.type || '')) {
      reject(new Error('请选择图片文件'));
      return;
    }

    if (file.size > 10 * 1024 * 1024) {
      reject(new Error('图片太大，请选择 10MB 以内的图片'));
      return;
    }

    const reader = new FileReader();

    reader.onerror = () => reject(new Error('图片读取失败'));

    reader.onload = () => {
      const img = new Image();

      img.onerror = () => reject(new Error('图片格式不支持'));

      img.onload = () => {
        try {
          const size = 160;
          const side = Math.min(img.width, img.height);
          const sx = Math.max(0, (img.width - side) / 2);
          const sy = Math.max(0, (img.height - side) / 2);
          const canvas = document.createElement('canvas');
          canvas.width = size;
          canvas.height = size;

          const ctx = canvas.getContext('2d');
          ctx.fillStyle = '#fff8f0';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);

          resolve(canvas.toDataURL('image/jpeg', 0.82));
        } catch (err) {
          reject(new Error('图片处理失败'));
        }
      };

      img.src = String(reader.result || '');
    };

    reader.readAsDataURL(file);
  });
}

function handleAvatarFile(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;

  fileToAvatar(file)
    .then((dataUrl) => {
      state.profileAvatar = dataUrl;
      renderProfileAvatar();
      renderAvatarPresets();
      els.profileError.textContent = '';
    })
    .catch((err) => {
      els.profileError.textContent = err.message || '头像处理失败';
    });
}

async function handleUserState() {
  if (state.user && state.user.profileComplete) {
    await startApp();
  } else {
    showProfileStep('');
  }
}

function handleSessionExpired() {
  clearToken();
  state.user = null;
  stopPolling();
  els.phoneFrame.classList.add('hidden');
  els.cartOverlay.classList.add('hidden');
  els.checkoutView.classList.add('hidden');
  els.successView.classList.add('hidden');
  els.ordersView.classList.add('hidden');
  autoLogin('登录状态已失效，请重试');
}

// ==================== 菜单 ====================

function readMenuCache() {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_MENU_CACHE) || 'null');
    if (
      !value ||
      !Array.isArray(value.menu) ||
      value.menu.length === 0 ||
      !value.store
    ) {
      return null;
    }
    return value;
  } catch (err) {
    return null;
  }
}

function writeMenuCache(data) {
  try {
    localStorage.setItem(
      STORAGE_MENU_CACHE,
      JSON.stringify({
        store: data.store || {},
        menu: data.menu || [],
        categories: data.categories || ['全部'],
        savedAt: Date.now(),
      })
    );
  } catch (err) {
    // 本机缓存失败不影响在线菜单
  }
}

function applyMenuData(data, useRemoteRecommendations) {
  state.store = data.store || {};
  state.menu = Array.isArray(data.menu) ? data.menu : [];
  state.menuById = new Map(state.menu.map((dish) => [dish.id, dish]));
  state.categories = Array.isArray(data.categories) && data.categories.length
    ? data.categories
    : ['全部'];

  if (useRemoteRecommendations) {
    state.recommendations = data.recommendations || {
      recent: [],
      popular: [],
    };
  }

  if (state.categories.indexOf(state.currentCategory) === -1) {
    state.currentCategory = '全部';
  }

  pruneCart();
  saveCart();
  renderStore();
  renderCategories();
  renderMenu();
  updateSearchUI();
  updateCartUI();

  if (!els.cartOverlay.classList.contains('hidden')) {
    renderCartSheet();
  }
  if (!els.checkoutView.classList.contains('hidden')) {
    renderCheckoutItems();
    renderCoupons();
    recomputeCheckoutTotals();
  }
}

async function loadMenu(silent) {
  if (state.loadingMenuPromise) return state.loadingMenuPromise;
  state.loadingMenu = true;

  if (!silent) {
    els.menuLoading.classList.remove('hidden');
    els.menuLoading.textContent = '菜单加载中...';
  }

  state.loadingMenuPromise = (async () => {
    const cached = readMenuCache();
    if (cached && state.menu.length === 0) {
      applyMenuData(cached, false);
      els.menuLoading.classList.add('hidden');
    }

    try {
      const data = await api('/api/menu');
      writeMenuCache(data);
      applyMenuData(data, true);
      els.menuLoading.classList.add('hidden');
    } catch (err) {
      if (!silent) {
        els.menuLoading.textContent = state.menu.length
          ? '当前显示上次菜单，正在重试...'
          : '菜单加载失败，请刷新页面重试';
        showToast(err.message || '菜单加载失败');
      }
    } finally {
      state.loadingMenu = false;
      state.loadingMenuPromise = null;
    }
  })();

  return state.loadingMenuPromise;
}

function renderStore() {
  const store = state.store || {};
  const settings = deliverySettings();
  const freeText = settings.thresholdCents > 0
    ? '满 ' + (settings.thresholdCents / 100).toFixed(0) + ' 元免配送费'
    : '免配送费';

  els.storeName.textContent = store.storeName || '嘎嘎香 乐山油炸串串';
  els.storeHours.textContent = store.hours || '';
  els.storeNotice.textContent =
    (store.notice || '外卖配送，提交订单后商家会电话联系确认，线下支付') +
    ' · ' + freeText +
    (store.shopPhone ? ' · 咨询 ' + store.shopPhone : '');
}

function renderCategories() {
  els.categoryBar.innerHTML = '';

  state.categories.forEach((category) => {
    const button = make('button', 'category-chip', category);
    button.type = 'button';
    button.dataset.category = category;
    if (category === state.currentCategory) {
      button.classList.add('active');
    }
    els.categoryBar.appendChild(button);
  });
}

function updateSearchUI() {
  const searching = !!state.menuQuery;

  els.clearMenuSearchBtn.classList.toggle('hidden', !searching);
  els.categoryBar.classList.toggle('hidden', searching);
  renderRecommendations();
}

function setMenuQuery(value) {
  state.menuQuery = String(value || '').trim();

  if (state.menuQuery && state.currentCategory !== '全部') {
    state.currentCategory = '全部';
    renderCategories();
  }

  updateSearchUI();
  renderMenu();
}

function recommendationDishes(ids, excludeIds) {
  const excluded = excludeIds || new Set();

  return (Array.isArray(ids) ? ids : [])
    .filter((id) => !excluded.has(id))
    .map((id) => state.menuById.get(id))
    .filter(
      (dish) =>
        dish &&
        dish.enabled !== false &&
        !dish.soldOut
    )
    .slice(0, 6);
}

function renderRecommendations() {
  const area = els.recommendationArea;
  if (!area) return;

  area.innerHTML = '';

  if (state.menuQuery || state.currentCategory !== '全部') {
    area.classList.add('hidden');
    return;
  }

  const recent = recommendationDishes(
    state.recommendations && state.recommendations.recent
  );
  const recentIds = new Set(recent.map((dish) => dish.id));
  const popular = recommendationDishes(
    state.recommendations && state.recommendations.popular,
    recentIds
  );

  if (recent.length === 0 && popular.length === 0) {
    area.classList.add('hidden');
    return;
  }

  if (recent.length > 0) {
    area.appendChild(renderRecommendationBlock('最近点过', '🕘', recent));
  }

  if (popular.length > 0) {
    area.appendChild(renderRecommendationBlock('销量较高', '🔥', popular));
  }

  area.classList.remove('hidden');
}

function renderRecommendationBlock(title, icon, dishes) {
  const block = make('section', 'rec-block');
  const header = make('div', 'rec-header');
  header.appendChild(make('h3', 'rec-title', icon + ' ' + title));
  block.appendChild(header);

  const track = make('div', 'rec-track');

  dishes.forEach((dish) => {
    const card = make('article', 'rec-card');
    card.appendChild(make('span', 'rec-emoji', dish.emoji || '🍢'));

    const info = make('div', 'rec-info');
    info.appendChild(make('div', 'rec-name', dish.name));
    info.appendChild(
      make(
        'div',
        'rec-price',
        money(dish.priceCents) + '/' + dish.unit
      )
    );
    card.appendChild(info);

    const add = make('button', 'rec-add', '+');
    add.type = 'button';
    add.dataset.action = 'add';
    add.dataset.id = dish.id;
    add.setAttribute('aria-label', '把 ' + dish.name + ' 加入购物车');
    card.appendChild(add);

    track.appendChild(card);
  });

  block.appendChild(track);
  return block;
}

function renderMenu() {
  els.menuList.innerHTML = '';

  const query = state.menuQuery.toLowerCase();
  const dishes = query
    ? state.menu.filter((dish) => {
        return [dish.name, dish.category, dish.tag, dish.desc]
          .join(' ')
          .toLowerCase()
          .includes(query);
      })
    : state.menu.filter((dish) => {
        return state.currentCategory === '全部' ||
          dish.category === state.currentCategory;
      });

  if (dishes.length === 0) {
    els.menuList.appendChild(
      make(
        'div',
        'menu-empty',
        query ? '没有找到相关菜品' : '这个分类暂时没有菜品'
      )
    );
    return;
  }

  const fragment = document.createDocumentFragment();

  dishes.forEach((dish) => {
    const count = state.cart[dish.id] || 0;
    const card = make('article', 'dish-card' + (dish.soldOut ? ' sold-out' : ''));
    card.dataset.dishId = dish.id;

    const emojiWrap = make('div', 'dish-emoji-wrap');
    emojiWrap.appendChild(make('span', 'dish-emoji', dish.emoji || '🍢'));
    if (dish.soldOut) {
      emojiWrap.appendChild(make('span', 'sold-out-mask', '售罄'));
    }
    card.appendChild(emojiWrap);

    const nameRow = make('div', 'dish-name-row');
    nameRow.appendChild(make('h3', 'dish-name', dish.name));
    if (dish.tag) nameRow.appendChild(make('span', 'dish-tag', dish.tag));
    card.appendChild(nameRow);

    if (dish.desc) {
      card.appendChild(make('p', 'dish-desc', dish.desc));
    }

    const bottom = make('div', 'dish-bottom');
    const price = make('div', 'dish-price', money(dish.priceCents));
    price.appendChild(make('span', 'dish-unit', '/' + dish.unit));
    bottom.appendChild(price);

    const stepper = make('div', 'stepper');

    if (dish.soldOut) {
      stepper.appendChild(make('span', 'sold-out-text', '售罄'));
    } else {
      const minus = make('button', 'step-btn minus', '−');
      minus.type = 'button';
      minus.dataset.action = 'minus';
      minus.dataset.id = dish.id;
      minus.disabled = count <= 0;

      const number = make('span', 'step-count', String(count));

      const plus = make('button', 'step-btn plus', '+');
      plus.type = 'button';
      plus.dataset.action = 'add';
      plus.dataset.id = dish.id;

      stepper.appendChild(minus);
      stepper.appendChild(number);
      stepper.appendChild(plus);
    }

    bottom.appendChild(stepper);
    card.appendChild(bottom);
    fragment.appendChild(card);
  });

  els.menuList.appendChild(fragment);
}

function pruneCart() {
  Object.keys(state.cart).forEach((id) => {
    if (!state.menuById.has(id)) delete state.cart[id];
  });
}

// ==================== 购物车 ====================

function loadCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_CART) || '{}');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;

    state.cart = {};
    Object.keys(raw).forEach((id) => {
      const count = Math.floor(Number(raw[id]) || 0);
      if (count > 0) state.cart[id] = Math.min(count, 99);
    });
  } catch (err) {
    state.cart = {};
  }
}

function saveCart() {
  try {
    localStorage.setItem(STORAGE_CART, JSON.stringify(state.cart));
  } catch (err) {
    // 忽略
  }
}

function cartTotals() {
  let count = 0;
  let totalCents = 0;

  Object.keys(state.cart).forEach((id) => {
    const dish = state.menuById.get(id);
    if (!dish) return;

    const itemCount = state.cart[id] || 0;
    count += itemCount;
    totalCents += dish.priceCents * itemCount;
  });

  return { count, totalCents };
}

function changeCount(id, delta) {
  const dish = state.menuById.get(id);
  if (!dish) return;

  const current = state.cart[id] || 0;
  const next = current + delta;

  if (delta > 0 && dish.soldOut) {
    showToast('这个菜品已售罄');
    return;
  }

  if (next <= 0) {
    delete state.cart[id];
  } else {
    state.cart[id] = Math.min(next, 99);
  }

  saveCart();
  renderMenu();
  updateCartUI();

  if (!els.cartOverlay.classList.contains('hidden')) {
    renderCartSheet();
  }
  if (!els.checkoutView.classList.contains('hidden')) {
    renderCheckoutItems();
    renderCoupons();
    recomputeCheckoutTotals();
  }
}

function updateCartUI() {
  const totals = cartTotals();

  els.cartBadge.textContent = String(totals.count);
  els.cartBadge.classList.toggle('hidden', totals.count === 0);
  els.cartTotal.textContent = money(totals.totalCents);
  els.checkoutBtn.disabled = totals.count === 0;
  els.sheetTotal.textContent = money(totals.totalCents);
  els.sheetCheckoutBtn.disabled = totals.count === 0;
}

function openCart() {
  if (cartTotals().count === 0) {
    showToast('购物车还是空的');
    return;
  }

  renderCartSheet();
  els.cartOverlay.classList.remove('hidden');
  els.cartOverlay.setAttribute('aria-hidden', 'false');
  updateBodyLock();
}

function closeCart() {
  blurInside(els.cartOverlay);
  els.cartOverlay.classList.add('hidden');
  els.cartOverlay.setAttribute('aria-hidden', 'true');
  updateBodyLock();
}

function renderCartSheet() {
  els.cartItemList.innerHTML = '';

  const ids = Object.keys(state.cart);
  if (ids.length === 0) {
    els.cartItemList.appendChild(make('p', 'empty-text', '购物车是空的'));
    updateCartUI();
    return;
  }

  ids.forEach((id) => {
    const dish = state.menuById.get(id);
    if (!dish) return;

    const count = state.cart[id];
    const row = make('div', 'cart-row');

    const info = make('div', 'cart-row-info');
    info.appendChild(make('div', 'cart-row-name', dish.emoji + ' ' + dish.name));
    info.appendChild(
      make('div', 'cart-row-price', money(dish.priceCents) + ' / ' + dish.unit)
    );
    row.appendChild(info);

    const stepper = make('div', 'stepper');

    const minus = make('button', 'step-btn minus', '−');
    minus.type = 'button';
    minus.dataset.action = 'minus';
    minus.dataset.id = id;
    minus.disabled = count <= 0;

    const number = make('span', 'step-count', String(count));
    const plus = make('button', 'step-btn plus', '+');
    plus.type = 'button';
    plus.dataset.action = 'add';
    plus.dataset.id = id;
    plus.disabled = !!dish.soldOut;

    stepper.appendChild(minus);
    stepper.appendChild(number);
    stepper.appendChild(plus);
    row.appendChild(stepper);

    els.cartItemList.appendChild(row);
  });

  updateCartUI();
}

function clearCart() {
  if (cartTotals().count === 0) return;
  if (!window.confirm('确定清空购物车吗？')) return;

  state.cart = {};
  saveCart();
  renderMenu();
  updateCartUI();
  closeCart();
  showToast('购物车已清空');
}

// ==================== 优惠券 ====================

async function loadCoupons() {
  try {
    const data = await api('/api/coupons');
    state.coupons = Array.isArray(data.coupons) ? data.coupons : [];

    if (
      state.selectedCouponId &&
      !state.coupons.some((coupon) => coupon.id === state.selectedCouponId)
    ) {
      state.selectedCouponId = '';
    }

    if (!els.checkoutView.classList.contains('hidden')) {
      renderCoupons();
      recomputeCheckoutTotals();
    }
  } catch (err) {
    state.coupons = [];
    if (!els.checkoutView.classList.contains('hidden')) {
      renderCoupons();
      recomputeCheckoutTotals();
    }
  }
}

function couponState(coupon, subtotalCents) {
  const threshold = Number(coupon.thresholdCents) || 0;
  const minSpendOk = subtotalCents >= threshold;
  const blocked = !!coupon.blockedByFirstOrder;

  return {
    minSpendOk,
    blocked,
    gapCents: Math.max(0, threshold - subtotalCents),
    eligible: minSpendOk && !blocked,
  };
}

function selectedCoupon(subtotalCents) {
  const coupon = state.coupons.find(
    (item) => item.id === state.selectedCouponId
  );
  if (!coupon) return null;

  return couponState(coupon, subtotalCents).eligible ? coupon : null;
}

function renderCoupons() {
  const subtotal = cartTotals().totalCents;
  els.couponList.innerHTML = '';

  if (state.coupons.length === 0) {
    els.couponEmpty.classList.remove('hidden');
    return;
  }

  els.couponEmpty.classList.add('hidden');

  state.coupons.forEach((coupon) => {
    const info = couponState(coupon, subtotal);
    const selected = state.selectedCouponId === coupon.id;

    const card = make('div', 'coupon-card');
    const main = make('div', 'coupon-card-main');
    main.appendChild(make('div', 'coupon-name', '🎟️ ' + coupon.name));
    main.appendChild(
      make(
        'div',
        'coupon-desc',
        '满 ' + money(coupon.thresholdCents) +
        ' 减 ' + money(coupon.discountCents)
      )
    );

    if (info.blocked) {
      main.appendChild(make('div', 'coupon-hint danger', '仅限首单使用'));
    } else if (!info.minSpendOk) {
      main.appendChild(
        make('div', 'coupon-hint', '还差 ' + money(info.gapCents) + ' 可用')
      );
    }

    card.appendChild(main);

    const button = make(
      'button',
      'coupon-button' +
        (selected ? ' selected' : '') +
        (info.eligible ? '' : ' disabled'),
      selected ? '取消' : '使用'
    );
    button.type = 'button';
    button.dataset.couponId = coupon.id;
    button.disabled = !info.eligible;
    card.appendChild(button);

    els.couponList.appendChild(card);
  });
}

function onCouponClick(id) {
  const subtotal = cartTotals().totalCents;
  const coupon = state.coupons.find((item) => item.id === id);
  if (!coupon) return;

  const info = couponState(coupon, subtotal);

  if (info.blocked) {
    showToast('该优惠券仅限首单使用');
    return;
  }
  if (!info.minSpendOk) {
    showToast('还差 ' + money(info.gapCents) + ' 才能使用');
    return;
  }

  state.selectedCouponId =
    state.selectedCouponId === id ? '' : id;

  renderCoupons();
  recomputeCheckoutTotals();
}

function recomputeCheckoutTotals() {
  const subtotal = cartTotals().totalCents;
  const settings = deliverySettings();
  const deliveryFeeCents = subtotal >= settings.thresholdCents
    ? 0
    : settings.feeCents;
  let coupon = selectedCoupon(subtotal);

  // 购物车变化后，已选优惠券可能不再满足门槛
  if (state.selectedCouponId && !coupon) {
    state.selectedCouponId = '';
    renderCoupons();
    coupon = null;
  }

  const discountCents = coupon
    ? Math.min(coupon.discountCents, subtotal)
    : 0;
  const totalCents = Math.max(
    0,
    subtotal + deliveryFeeCents - discountCents
  );

  els.checkoutSubtotal.textContent = money(subtotal);

  if (deliveryFeeCents === 0) {
    els.checkoutDeliveryFee.textContent = '免配送费';
    els.deliveryFeeHint.textContent = '已满 ' +
      (settings.thresholdCents / 100).toFixed(0) + ' 元，免配送费';
  } else {
    els.checkoutDeliveryFee.textContent = money(deliveryFeeCents);
    els.deliveryFeeHint.textContent = '再买 ' +
      money(Math.max(0, settings.thresholdCents - subtotal)) +
      ' 可免配送费';
  }

  els.checkoutDiscountRow.classList.toggle(
    'hidden',
    discountCents <= 0
  );
  els.checkoutDiscount.textContent = '-' + money(discountCents);
  els.checkoutTotal.textContent = money(totalCents);

  return {
    subtotalCents: subtotal,
    deliveryFeeCents,
    discountCents,
    totalCents,
    coupon,
  };
}

// ==================== 结算 ====================

function openCheckout() {
  const totals = cartTotals();

  if (totals.count === 0) {
    showToast('请先选择菜品');
    return;
  }

  const soldOutItems = Object.keys(state.cart).filter((id) => {
    const dish = state.menuById.get(id);
    return !dish || dish.soldOut;
  });

  if (soldOutItems.length > 0) {
    showToast('有菜品已售罄，请先调整购物车');
    openCart();
    return;
  }

  closeCart();

  if (!els.recipientNameInput.value) {
    els.recipientNameInput.value = (state.user && state.user.recipientName) || '';
  }
  if (!els.phoneInput.value) {
    els.phoneInput.value = (state.user && state.user.phone) || '';
  }
  if (!els.addressInput.value) {
    els.addressInput.value = (state.user && state.user.address) || '';
    state.addressLocation = state.user && state.user.location
      ? state.user.location
      : null;
  }

  els.locateHint.textContent =
    '定位后请补充楼栋和门牌号；定位需要浏览器允许位置权限';
  els.locateBtn.disabled = false;
  els.locateBtn.textContent = '📍 自动定位';

  renderCheckoutItems();
  renderCoupons();
  recomputeCheckoutTotals();

  els.submitOrderBtn.disabled = false;
  els.submitOrderBtn.textContent = '提交订单';

  els.checkoutView.classList.remove('hidden');
  els.checkoutView.setAttribute('aria-hidden', 'false');
  updateBodyLock();
  els.checkoutView.scrollTop = 0;
  setHash('#checkout');

  // 每次进结算页都刷新一次优惠券，商家刚发的新券也能看到
  loadCoupons();
}

function closeCheckout() {
  blurInside(els.checkoutView);
  els.checkoutView.classList.add('hidden');
  els.checkoutView.setAttribute('aria-hidden', 'true');
  updateBodyLock();
  setHash('#menu');
}

function renderCheckoutItems() {
  els.checkoutItems.innerHTML = '';

  Object.keys(state.cart).forEach((id) => {
    const dish = state.menuById.get(id);
    if (!dish) return;

    const count = state.cart[id];
    const row = make('div', 'checkout-item');
    row.appendChild(make('span', 'checkout-item-name', dish.name));
    row.appendChild(make('span', 'checkout-item-count', '×' + count));
    row.appendChild(
      make(
        'span',
        'checkout-item-subtotal',
        money(dish.priceCents * count)
      )
    );
    els.checkoutItems.appendChild(row);
  });
}

function geolocationErrorMessage(err) {
  if (!err) return '定位失败，请手动填写地址';

  if (err.code === 1) {
    return '定位权限被拒绝，请在浏览器设置中允许定位，或手动填写地址';
  }
  if (err.code === 2) {
    return '暂时无法获取位置，请手动填写地址';
  }
  if (err.code === 3) {
    return '定位超时，请重试或手动填写地址';
  }

  return err.message || '定位失败，请手动填写地址';
}

async function locateAddress() {
  if (state.locating) return;

  if (!navigator.geolocation) {
    showToast('当前浏览器不支持定位，请手动填写地址');
    return;
  }

  state.locating = true;
  els.locateBtn.disabled = true;
  els.locateBtn.textContent = '定位中...';
  els.locateHint.textContent = '正在获取位置...';

  try {
    const position = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true,
        timeout: 12000,
        maximumAge: 60000,
      });
    });

    const lat = position.coords.latitude;
    const lng = position.coords.longitude;

    const data = await api(
      '/api/geocode?lat=' + encodeURIComponent(lat) +
      '&lng=' + encodeURIComponent(lng)
    );

    const address = String(data.address || '').trim();
    if (!address) throw new Error('没有解析出地址，请手动填写');

    const current = els.addressInput.value.trim();
    let useLocation = true;

    if (!current) {
      els.addressInput.value = address;
    } else if (current !== address) {
      const replace = window.confirm(
        '定位到：\n' + address +
        '\n\n是否替换已填写的地址？\n点“取消”保留原地址，同时不记录本次定位。'
      );

      if (replace) {
        els.addressInput.value = address;
      } else {
        useLocation = false;
      }
    }

    if (useLocation) {
      state.addressLocation = { lat, lng };
      els.locateHint.textContent =
        '定位成功，请补充小区、楼栋和门牌号';
      showToast('已自动定位');
    } else {
      state.addressLocation = null;
      els.locateHint.textContent =
        '已保留原地址，本次定位坐标未记录';
      showToast('已保留原地址');
    }

    els.addressInput.focus();
  } catch (err) {
    const message = err && err.code
      ? geolocationErrorMessage(err)
      : (err.message || '定位失败，请手动填写地址');
    els.locateHint.textContent = message;
    showToast(message);
  } finally {
    state.locating = false;
    els.locateBtn.disabled = false;
    els.locateBtn.textContent = '📍 自动定位';
  }
}

async function submitOrder() {
  if (state.submitting) return;

  const items = Object.keys(state.cart).map((id) => ({
    id,
    count: state.cart[id],
  }));

  if (items.length === 0) {
    showToast('请先选择菜品');
    return;
  }

  const recipientName = els.recipientNameInput.value.trim();
  const phone = els.phoneInput.value.trim();
  const address = els.addressInput.value.trim();
  const note = els.noteInput.value.trim();

  if (!recipientName) {
    showToast('请填写收货人姓名');
    els.recipientNameInput.focus();
    return;
  }

  if (!/^1[3-9]\d{9}$/.test(phone)) {
    showToast('请输入正确的 11 位手机号');
    els.phoneInput.focus();
    return;
  }

  if (address.length < 5) {
    showToast('请填写完整的配送地址');
    els.addressInput.focus();
    return;
  }

  const totals = recomputeCheckoutTotals();
  const couponId = totals.coupon ? totals.coupon.id : '';

  state.submitting = true;
  els.submitOrderBtn.disabled = true;
  els.submitOrderBtn.textContent = '提交中...';

  try {
    const data = await api('/api/order', {
      method: 'POST',
      body: JSON.stringify({
        items,
        recipientName,
        phone,
        address,
        note,
        location: state.addressLocation,
        couponId,
      }),
    });

    state.cart = {};
    state.selectedCouponId = '';
    saveCart();
    renderMenu();
    updateCartUI();

    if (state.user) {
      state.user.recipientName = data.recipientName || recipientName;
      state.user.address = data.address || address;
      state.user.location = data.location || state.addressLocation;
    }

    closeCheckout();
    showSuccessView(data, 'menu');
    showToast('下单成功');
    loadCoupons();
    loadMenu(true);
  } catch (err) {
    showToast(err.message || '下单失败，请重试');

    if (err.status === 409 || err.status === 400) {
      loadMenu();
      loadCoupons();
    }
  } finally {
    state.submitting = false;
    els.submitOrderBtn.disabled = false;
    els.submitOrderBtn.textContent = '提交订单';
  }
}

// ==================== 订单状态 ====================

function showSuccessView(order, returnTo) {
  state.currentOrder = order;
  state.successReturn = returnTo || 'menu';

  renderSuccess();
  blurInside(els.checkoutView);
  blurInside(els.ordersView);
  blurInside(els.cartOverlay);
  els.checkoutView.classList.add('hidden');
  els.ordersView.classList.add('hidden');
  els.successView.classList.remove('hidden');
  els.successView.setAttribute('aria-hidden', 'false');
  updateBodyLock();
  els.successView.scrollTop = 0;
  setHash('#order/' + encodeURIComponent(order.id));

  startPolling();

  if (state.currentOrder.token) {
    refreshCurrentOrder();
  }
}

function hideSuccessView() {
  const returnTo = state.successReturn;
  stopPolling();
  blurInside(els.successView);
  els.successView.classList.add('hidden');
  els.successView.setAttribute('aria-hidden', 'true');
  updateBodyLock();

  if (returnTo === 'orders') {
    showOrdersView();
  } else {
    setHash('#menu');
  }
}

function renderSuccess() {
  const order = state.currentOrder;
  if (!order) return;

  const status = order.status || 'pending';

  els.pickupNo.textContent = order.pickupNo || '--';
  els.statusBadge.textContent = statusText(status);
  els.statusBadge.className = 'status-badge status-' + status;

  const tips = {
    pending: '订单已提交，等待商家接单',
    making: '商家已接单，正在制作',
    completed: '感谢惠顾，欢迎下次光临！',
    cancelled: '订单已取消，如有疑问请联系商家',
  };
  els.successTip.textContent = tips[status] || '订单处理中';

  els.successInfo.innerHTML = '';
  appendInfo('下单时间', formatTime(order.createdAt));
  appendInfo(
    '收货人',
    (order.recipientName || '--') + (order.phone ? ' · ' + order.phone : '')
  );
  appendInfo(
    '配送地址',
    order.address || '（旧订单没有配送地址）'
  );
  if (order.coupon && order.discountCents > 0) {
    appendInfo(
      '优惠券',
      order.coupon.name + '（-' + money(order.discountCents) + '）'
    );
  }

  els.successItems.innerHTML = '';
  (order.items || []).forEach((item) => {
    const row = make('div', 'checkout-item');
    row.appendChild(make('span', 'checkout-item-name', item.name));
    row.appendChild(make('span', 'checkout-item-count', '×' + item.count));
    row.appendChild(
      make(
        'span',
        'checkout-item-subtotal',
        money(item.subtotalCents)
      )
    );
    els.successItems.appendChild(row);
  });

  els.successSubtotal.textContent = money(order.subtotalCents);
  els.successDeliveryFee.textContent = Number(order.deliveryFeeCents) > 0
    ? money(order.deliveryFeeCents)
    : '免配送费';
  els.successDiscountRow.classList.toggle(
    'hidden',
    !(order.discountCents > 0)
  );
  els.successDiscount.textContent = '-' + money(order.discountCents);
  els.successTotal.textContent = money(order.totalCents);
}

function appendInfo(label, value) {
  const row = make('div', 'info-line');
  row.appendChild(make('span', 'info-label', label));
  row.appendChild(make('span', 'info-value', value));
  els.successInfo.appendChild(row);
}

function startPolling() {
  stopPolling();

  if (!state.currentOrder || !state.currentOrder.token) return;
  if (isTerminal(state.currentOrder.status)) return;

  state.pollTimer = setInterval(refreshCurrentOrder, POLL_INTERVAL);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function refreshCurrentOrder() {
  const order = state.currentOrder;
  if (!order || !order.token) return;

  if (els.successView.classList.contains('hidden')) {
    stopPolling();
    return;
  }

  try {
    const data = await api(
      '/api/order/' + encodeURIComponent(order.id) +
      '?token=' + encodeURIComponent(order.token)
    );

    const next = Object.assign({}, order, data.order, { token: order.token });
    state.currentOrder = next;
    renderSuccess();

    if (isTerminal(next.status)) {
      stopPolling();
    }
  } catch (err) {
    if (err.status === 404) {
      stopPolling();
    }
  }
}

// ==================== 我的订单 ====================

function updateProfileUI() {
  const user = state.user || {};

  setAvatar(els.headerAvatar, user.avatar || '🍢');
  els.headerNickname.textContent = user.nickname || '我的订单';

  setAvatar(els.profileAvatar, user.avatar || '🍢');
  els.profileNickname.textContent = user.nickname || '顾客';
  els.profilePhone.textContent = user.phone
    ? '手机号 ' + maskPhone(user.phone)
    : '';
}

async function loadMyOrders() {
  const data = await api('/api/my-orders');
  state.history = Array.isArray(data.orders) ? data.orders : [];
  return state.history;
}

async function showOrdersView() {
  stopPolling();
  blurInside(els.successView);
  blurInside(els.checkoutView);
  blurInside(els.cartOverlay);

  els.checkoutView.classList.add('hidden');
  els.successView.classList.add('hidden');
  els.cartOverlay.classList.add('hidden');
  els.ordersView.classList.remove('hidden');
  els.ordersView.setAttribute('aria-hidden', 'false');
  updateBodyLock();
  els.ordersView.scrollTop = 0;
  setHash('#orders');

  updateProfileUI();
  els.ordersList.innerHTML = '';
  els.ordersList.appendChild(make('p', 'orders-empty', '订单加载中...'));

  try {
    await loadMyOrders();
    renderHistoryCards(state.history);
  } catch (err) {
    if (err.status !== 401) {
      els.ordersList.innerHTML = '';
      els.ordersList.appendChild(
        make('p', 'orders-empty', '订单加载失败，请稍后重试')
      );
    }
  }
}

function hideOrdersView() {
  blurInside(els.ordersView);
  els.ordersView.classList.add('hidden');
  els.ordersView.setAttribute('aria-hidden', 'true');
  updateBodyLock();
  setHash('#menu');
}

function renderHistoryCards(history) {
  els.ordersList.innerHTML = '';

  if (!history || history.length === 0) {
    els.ordersList.appendChild(
      make('div', 'orders-empty', '还没有订单，去点一份吧')
    );
    return;
  }

  history.forEach((item) => {
    const card = make('button', 'order-history-card');
    card.type = 'button';
    card.dataset.orderId = item.id;

    const top = make('div', 'order-history-top');
    top.appendChild(
      make('span', 'order-history-no', '订单号 ' + (item.pickupNo || '--'))
    );
    top.appendChild(
      make(
        'span',
        'status-badge status-' + (item.status || 'pending'),
        statusText(item.status)
      )
    );
    card.appendChild(top);

    card.appendChild(
      make(
        'div',
        'order-history-meta',
        formatTime(item.createdAt) + ' · ' +
        (item.itemCount || 0) + ' 份 · ' + money(item.totalCents)
      )
    );

    if (item.address) {
      card.appendChild(
        make('div', 'order-history-address', '配送至 ' + item.address)
      );
    }

    els.ordersList.appendChild(card);
  });
}

async function openOrderById(id, returnTo) {
  let item = state.history.find((entry) => entry.id === id);

  if (!item) {
    try {
      await loadMyOrders();
      item = state.history.find((entry) => entry.id === id);
    } catch (err) {
      item = null;
    }
  }

  if (item) {
    showSuccessView(item, returnTo || 'menu');
  } else {
    showMenuOnly();
    setHash('#menu');
  }
}

// ==================== hash 路由 ====================

function setHash(hash) {
  if (window.location.hash === hash) return;

  state.ignoreHash = true;
  window.location.hash = hash;

  setTimeout(() => {
    state.ignoreHash = false;
  }, 100);
}

function showMenuOnly() {
  stopPolling();
  blurInside(els.checkoutView);
  blurInside(els.successView);
  blurInside(els.ordersView);
  blurInside(els.cartOverlay);

  els.checkoutView.classList.add('hidden');
  els.successView.classList.add('hidden');
  els.ordersView.classList.add('hidden');
  els.cartOverlay.classList.add('hidden');
  updateBodyLock();
}

function routeHash() {
  if (state.ignoreHash) return;
  if (!state.user || !state.user.profileComplete) return;

  const hash = window.location.hash || '';

  if (hash.indexOf('#order/') === 0) {
    const id = decodeURIComponent(hash.slice('#order/'.length));

    if (
      !els.successView.classList.contains('hidden') &&
      state.currentOrder &&
      state.currentOrder.id === id
    ) {
      return;
    }

    openOrderById(id, 'menu');
    return;
  }

  if (hash === '#orders') {
    if (!els.ordersView.classList.contains('hidden')) return;
    showOrdersView();
    return;
  }

  if (hash === '#checkout') {
    if (!els.checkoutView.classList.contains('hidden')) return;

    if (cartTotals().count > 0) {
      openCheckout();
    } else {
      showMenuOnly();
      setHash('#menu');
    }
    return;
  }

  showMenuOnly();
}

// ==================== 事件绑定 ====================

function bindAuthEvents() {
  els.entryRetryBtn.addEventListener('click', () => window.location.reload());
  els.saveProfileBtn.addEventListener('click', saveProfile);

  els.avatarPresets.addEventListener('click', (event) => {
    const button = event.target.closest('[data-avatar]');
    if (!button) return;

    state.profileAvatar = button.dataset.avatar;
    renderProfileAvatar();
    renderAvatarPresets();
    els.profileError.textContent = '';
  });

  els.avatarUploadBtn.addEventListener('click', () => {
    els.avatarFileInput.click();
  });
  els.avatarFileInput.addEventListener('change', handleAvatarFile);

  [els.nicknameInput, els.authPhoneInput].forEach((input) => {
    input.addEventListener('input', () => {
      els.profileError.textContent = '';
    });
  });
}

function bindAppEvents() {
  if (state.eventsBound) return;
  state.eventsBound = true;

  els.menuSearchInput.addEventListener('input', () => {
    setMenuQuery(els.menuSearchInput.value);
  });

  els.clearMenuSearchBtn.addEventListener('click', () => {
    els.menuSearchInput.value = '';
    setMenuQuery('');
    els.menuSearchInput.focus();
  });

  els.recommendationArea.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action="add"]');
    if (button) changeCount(button.dataset.id, 1);
  });

  els.categoryBar.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-category]');
    if (!chip) return;

    state.currentCategory = chip.dataset.category;
    renderCategories();
    renderMenu();
    renderRecommendations();
  });

  els.menuList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const id = button.dataset.id;
    if (button.dataset.action === 'add') {
      changeCount(id, 1);
    } else if (button.dataset.action === 'minus') {
      changeCount(id, -1);
    }
  });

  els.cartItemList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const id = button.dataset.id;
    changeCount(id, button.dataset.action === 'add' ? 1 : -1);
  });

  els.cartSummaryBtn.addEventListener('click', openCart);
  els.checkoutBtn.addEventListener('click', openCheckout);
  els.sheetCheckoutBtn.addEventListener('click', openCheckout);
  els.closeCartBtn.addEventListener('click', closeCart);
  els.clearCartBtn.addEventListener('click', clearCart);

  els.cartOverlay.addEventListener('click', (event) => {
    if (event.target === els.cartOverlay) closeCart();
  });

  els.checkoutBackBtn.addEventListener('click', closeCheckout);
  els.locateBtn.addEventListener('click', locateAddress);

  els.addressInput.addEventListener('input', () => {
    state.addressLocation = null;
    els.locateHint.textContent =
      '地址已手动修改；如需记录定位，请重新点“自动定位”';
  });

  els.couponList.addEventListener('click', (event) => {
    const button = event.target.closest('[data-coupon-id]');
    if (!button || button.disabled) return;
    onCouponClick(button.dataset.couponId);
  });

  els.submitOrderBtn.addEventListener('click', submitOrder);
  els.successBackBtn.addEventListener('click', () => {
    if (state.successReturn === 'orders') {
      showOrdersView();
    } else {
      hideSuccessView();
    }
  });

  els.successRefreshBtn.addEventListener('click', refreshCurrentOrder);
  els.continueOrderBtn.addEventListener('click', () => {
    state.successReturn = 'menu';
    hideSuccessView();
  });
  els.successMyOrdersBtn.addEventListener('click', showOrdersView);

  els.openOrdersBtn.addEventListener('click', showOrdersView);
  els.ordersBackBtn.addEventListener('click', hideOrdersView);

  els.ordersList.addEventListener('click', (event) => {
    const card = event.target.closest('[data-order-id]');
    if (card) openOrderById(card.dataset.orderId, 'orders');
  });

  window.addEventListener('hashchange', routeHash);

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!els.cartOverlay.classList.contains('hidden')) closeCart();
    else if (!els.ordersView.classList.contains('hidden')) hideOrdersView();
    else if (!els.successView.classList.contains('hidden')) hideSuccessView();
    else if (!els.checkoutView.classList.contains('hidden')) closeCheckout();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;

    loadMenu(true);
    loadCoupons();

    if (!els.ordersView.classList.contains('hidden')) {
      loadMyOrders()
        .then(() => renderHistoryCards(state.history))
        .catch(() => {});
    }
  });
}

// ==================== 启动 ====================

async function startApp() {
  if (!state.user || !state.user.profileComplete) {
    showProfileStep('');
    return;
  }

  els.authView.classList.add('hidden');
  els.phoneFrame.classList.remove('hidden');
  updateProfileUI();
  bindAppEvents();

  loadCart();
  await Promise.all([loadMenu(), loadCoupons()]);

  if (window.location.hash) {
    routeHash();
  }

  if (!state.menuTimer) {
    state.menuTimer = setInterval(() => {
      if (!document.hidden) loadMenu(true);
    }, MENU_REFRESH_INTERVAL);
  }
}

async function init() {
  cacheElements();
  bindAuthEvents();

  loadAuthConfig();

  const params = new URLSearchParams(window.location.search);
  const loginCode = String(params.get('loginCode') || '');
  const authError = String(params.get('authError') || '');
  let bootError = authError;

  if (loginCode) {
    try {
      await exchangeLoginCode(loginCode);
    } catch (err) {
      bootError = err.message || '进入失败，请重试';
    }
    cleanUrlParams();
  } else if (authError) {
    cleanUrlParams();
  }

  if (state.user) {
    await handleUserState();
    return;
  }

  const token = getToken();

  if (token) {
    const menuPromise = loadMenu(true);

    try {
      const [data] = await Promise.all([
        api('/api/me', { skipAuthRedirect: true }),
        menuPromise,
      ]);
      state.user = data.user;
      await handleUserState();
      return;
    } catch (err) {
      if (err.status !== 401) {
        showEntryError(err.message || '网络连接失败，请重试');
        return;
      }
      clearToken();
    }
  }

  await autoLogin(bootError);
}

document.addEventListener('DOMContentLoaded', init);
