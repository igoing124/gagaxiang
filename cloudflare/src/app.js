'use strict';

// Cloudflare Workers 版核心逻辑
// 与 h5-order/server.js 的接口、算价规则、优惠券规则保持一致；
// 数据保存在 Durable Object 的 SQLite 里（docs 表），等价于原来的 data/*.json。

import MENU_SEED from './seed/menu.js';
import COUPON_SEED from './seed/coupons.js';

const STATUS = {
  PENDING: 'pending', // 待接单
  MAKING: 'making', // 制作中
  COMPLETED: 'completed', // 已完成
  CANCELLED: 'cancelled', // 已取消
};

const ALLOWED_TRANSITIONS = {
  pending: ['making', 'cancelled'],
  making: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_BLOCK_MS = 10 * 60 * 1000;
const ORDER_RATE_LIMIT = 30;
const ORDER_RATE_WINDOW_MS = 60 * 1000;
const AUTH_RATE_LIMIT = 30;
const AUTH_RATE_WINDOW_MS = 60 * 60 * 1000;
const GEOCODE_RATE_LIMIT = 20;
const GEOCODE_RATE_WINDOW_MS = 60 * 1000;
const MAX_ITEMS = 50;
const MAX_ITEM_COUNT = 99;
const MAX_AVATAR_LENGTH = 200000;
const MAX_TOKENS_PER_USER = 5;
const MAX_BODY_LENGTH = 256 * 1024;
const SHOP_TZ_OFFSET_MIN = 8 * 60; // 门店按北京时间切分“当天”和取餐号

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ==================== 通用工具 ====================

function randomBytesHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

function randomId(prefix) {
  return prefix + crypto.randomUUID().replace(/-/g, '');
}

function safeEqual(a, b) {
  const encoder = new TextEncoder();
  const left = encoder.encode(String(a == null ? '' : a));
  const right = encoder.encode(String(b == null ? '' : b));
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left[i] ^ right[i];
  return diff === 0;
}

function localDateKey(timestamp) {
  const shifted = new Date((timestamp || Date.now()) + SHOP_TZ_OFFSET_MIN * 60000);
  return shifted.toISOString().slice(0, 10);
}

function cleanText(raw, maxLength) {
  return String(raw == null ? '' : raw)
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function yuanToCents(value) {
  return Math.round((Number(value) || 0) * 100);
}

function validatePhone(raw) {
  const phone = String(raw || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    throw new HttpError(400, '请输入正确的 11 位手机号');
  }
  return phone;
}

function normalizeLocation(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const lat = Number(raw.lat);
  const lng = Number(raw.lng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return {
    lat: Math.round(lat * 1000000) / 1000000,
    lng: Math.round(lng * 1000000) / 1000000,
  };
}

function normalizeMenu(rawList, legacyState) {
  const legacy = legacyState || {};

  return rawList
    .map((raw, index) => {
      const id = String(raw.id || '');
      const priceCents =
        raw.priceCents != null
          ? Math.round(Number(raw.priceCents))
          : yuanToCents(raw.price);

      const legacySoldOut = !!(legacy[id] && legacy[id].soldOut);

      return {
        id,
        emoji: String(raw.emoji || '🍢'),
        name: String(raw.name || '').trim(),
        category: String(raw.category || '其他').trim(),
        desc: String(raw.desc || '').trim(),
        priceCents,
        unit: String(raw.unit || '份').trim(),
        tag: String(raw.tag || '').trim(),
        soldOut: raw.soldOut != null ? !!raw.soldOut : legacySoldOut,
        enabled: raw.enabled !== false,
        sort: Number(raw.sort != null ? raw.sort : index * 10) || 0,
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
      };
    })
    .filter((dish) => dish.id && dish.name && dish.priceCents > 0);
}

function normalizeUserRecord(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const tokens = Array.isArray(source.tokens)
    ? source.tokens
        .filter((token) => typeof token === 'string' && token.length >= 20)
        .slice(0, MAX_TOKENS_PER_USER)
    : [];

  if (typeof source.token === 'string' && source.token.length >= 20) {
    tokens.push(source.token);
  }

  return {
    id: String(source.id || randomId('u_')),
    tokens: Array.from(new Set(tokens)).slice(0, MAX_TOKENS_PER_USER),
    openid: String(source.openid || ''),
    nickname: cleanText(source.nickname, 16),
    avatar: String(source.avatar || ''),
    phone: String(source.phone || ''),
    profileComplete: !!source.profileComplete,
    prefillNickname: cleanText(source.prefillNickname, 16),
    prefillAvatar: String(source.prefillAvatar || ''),
    recipientName: cleanText(source.recipientName, 20),
    address: cleanText(source.address, 200),
    location: normalizeLocation(source.location),
    createdAt: Number(source.createdAt) || Date.now(),
    updatedAt: Number(source.updatedAt) || Date.now(),
    lastLoginAt: Number(source.lastLoginAt) || 0,
  };
}

// ==================== 地址解析 ====================

function nominatimAddress(data) {
  const address = data && data.address ? data.address : {};
  const parts = [
    address.country,
    address.state,
    address.city,
    address.district || address.county,
    address.suburb || address.town || address.village,
    address.road || address.pedestrian || address.neighbourhood,
    address.house_number,
  ]
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .filter((part, index, list) => list.indexOf(part) === index);

  if (parts.length > 0) return parts.join('');

  const display = String((data && data.display_name) || '').trim();
  return display.slice(0, 200);
}

// 浏览器定位是 WGS84，高德地图使用 GCJ-02，直接传会有几百米偏移
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function outOfChina(lng, lat) {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}

function transformLat(x, y) {
  let ret =
    -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3;
  ret +=
    ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3;
  return ret;
}

function transformLng(x, y) {
  let ret =
    300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3;
  ret += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3;
  ret +=
    ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3;
  return ret;
}

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };

  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);

  const radLat = (lat / 180) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);

  return { lat: lat + dLat, lng: lng + dLng };
}

// ==================== HTTP 工具 ====================

function securityHeaders(headers) {
  const next = new Headers(headers || {});
  next.set('X-Content-Type-Options', 'nosniff');
  next.set('Referrer-Policy', 'same-origin');
  return next;
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: securityHeaders({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }),
  });
}

function text(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: securityHeaders({ 'content-type': 'text/html; charset=utf-8' }),
  });
}

function errorResponse(err) {
  if (err instanceof HttpError) {
    return json({ error: err.message }, err.status);
  }

  console.error('[服务器错误]', (err && err.stack) || err);
  return json({ error: (err && err.message) || '服务器内部错误' }, 500);
}

async function fetchJson(url, options) {
  const response = await fetch(
    url,
    Object.assign({}, options || {}, {
      signal: AbortSignal.timeout(8000),
    })
  );

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  if (!response.ok) {
    const error = new Error(
      (data && (data.errmsg || data.message)) || '网络请求失败'
    );
    error.data = data;
    throw error;
  }

  return data;
}

// ==================== 配置 ====================

function readInt(value, fallback) {
  if (value == null || String(value).trim() === '') return fallback;
  const num = Math.round(Number(value));
  return Number.isFinite(num) && num >= 0 ? num : fallback;
}

export function readConfig(env) {
  return {
    storeName: String(env.STORE_NAME || '嘎嘎香 乐山油炸串串'),
    shopPhone: String(env.SHOP_PHONE || '15528775725'),
    hours: String(env.HOURS || '每天 17:00 - 次日 00:30'),
    notice: String(env.NOTICE || '外卖配送，提交订单后商家会电话联系确认，线下支付'),
    adminPassword: String(env.SHOP_ADMIN_PASSWORD || env.ADMIN_PASSWORD || ''),
    deliveryFeeCents: readInt(env.DELIVERY_FEE_CENTS, 300),
    freeDeliveryThresholdCents: readInt(env.FREE_DELIVERY_THRESHOLD_CENTS, 5000),
    amapKey: String(env.SHOP_AMAP_KEY || env.AMAP_KEY || '').trim(),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || '').trim(),
  };
}

// ==================== 应用 ====================

export function createShop({ store, config }) {
  validateConfig();

  // ---------- 状态（等价于 server.js 里的模块级变量） ----------
  let menu = loadMenu();
  let orders = loadList('orders.json');
  let couponTemplates = loadCouponTemplates();
  let userCoupons = loadList('user-coupons.json');
  let users = loadUsers();

  let menuById = new Map(menu.map((dish) => [dish.id, dish]));

  const sessions = new Map();
  const loginAttempts = new Map();
  const orderAttempts = new Map();
  const authAttempts = new Map();
  const geocodeAttempts = new Map();

  function validateConfig() {
    if (!config.adminPassword) {
      console.error(
        '[配置] 没有设置 ADMIN_PASSWORD，商家后台将无法登录；请在 wrangler 配置里填写'
      );
    }
  }

  // ---------- 持久化 ----------
  function loadList(name) {
    const value = store.read(name, []);
    return Array.isArray(value) ? value : [];
  }

  function loadUsers() {
    const raw = store.read('users.json', []);
    const list = Array.isArray(raw) ? raw.map(normalizeUserRecord) : [];
    if (!store.has('users.json')) store.write('users.json', list);
    return list;
  }

  function loadMenu() {
    if (store.has('menu.json')) {
      const list = store.read('menu.json', []);
      if (!Array.isArray(list)) throw new Error('menu.json 必须是数组');
      const normalized = normalizeMenu(list, {});
      if (normalized.length === 0) throw new Error('菜单为空');
      return normalized;
    }

    const normalized = normalizeMenu(MENU_SEED, {});
    if (normalized.length === 0) throw new Error('菜单种子数据为空');
    store.write('menu.json', normalized);
    return normalized;
  }

  function loadCouponTemplates() {
    const saved = store.read('coupons.json', null);
    if (Array.isArray(saved) && saved.length > 0) return saved;

    const list =
      Array.isArray(COUPON_SEED) && COUPON_SEED.length > 0
        ? COUPON_SEED.map((item) => Object.assign({}, item))
        : [defaultCouponTemplate()];

    store.write('coupons.json', list);
    return list;
  }

  function defaultCouponTemplate() {
    const now = Date.now();
    return {
      id: 'new_user_50_5',
      name: '新人首单券',
      thresholdCents: 5000,
      discountCents: 500,
      autoIssue: true,
      onlyFirstOrder: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
  }

  function saveUsers() {
    store.write('users.json', users);
  }
  function saveOrders() {
    store.write('orders.json', orders);
  }
  function saveMenu() {
    store.write('menu.json', menu);
  }
  function saveCoupons() {
    store.write('coupons.json', couponTemplates);
  }
  function saveUserCoupons() {
    store.write('user-coupons.json', userCoupons);
  }

  function rebuildMenuIndex() {
    menuById = new Map(menu.map((dish) => [dish.id, dish]));
  }

  // ---------- 菜单 ----------
  function categoriesOfMenu() {
    return Array.from(new Set(menu.map((dish) => dish.category)));
  }

  function publicDish(dish) {
    return {
      id: dish.id,
      emoji: dish.emoji,
      name: dish.name,
      category: dish.category,
      desc: dish.desc,
      priceCents: dish.priceCents,
      unit: dish.unit,
      tag: dish.tag,
      soldOut: !!dish.soldOut,
    };
  }

  function customerMenu() {
    return menu
      .filter((dish) => dish.enabled !== false)
      .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)
      .map(publicDish);
  }

  function adminDish(dish) {
    return Object.assign(publicDish(dish), {
      enabled: dish.enabled !== false,
      sort: dish.sort,
    });
  }

  // ---------- 账号 ----------
  function userById(id) {
    return users.find((user) => user.id === id) || null;
  }

  function userByPhone(phone) {
    return users.find((user) => user.profileComplete && user.phone === phone) || null;
  }

  function findUserByToken(rawToken) {
    const token = String(rawToken || '');
    if (token.length < 20) return null;

    for (const user of users) {
      for (const saved of user.tokens) {
        if (safeEqual(saved, token)) return user;
      }
    }

    return null;
  }

  function getUserToken(req) {
    return String(req.get('x-user-token') || '').trim();
  }

  function getOptionalUser(req) {
    return findUserByToken(getUserToken(req));
  }

  function requireUser(req) {
    const user = findUserByToken(getUserToken(req));
    if (!user) throw new HttpError(401, '请先登录');
    return user;
  }

  function requireProfile(user) {
    if (!user.profileComplete) {
      throw new HttpError(403, '请先完成昵称、头像和手机号设置');
    }
  }

  function createUser(options) {
    const opts = options || {};
    const now = Date.now();
    return normalizeUserRecord({
      id: randomId('u_'),
      openid: opts.openid || '',
      prefillNickname: opts.prefillNickname || '',
      prefillAvatar: opts.prefillAvatar || '',
      createdAt: now,
      updatedAt: now,
    });
  }

  function issueUserToken(user) {
    const token = randomBytesHex(32);

    if (users.indexOf(user) === -1) users.push(user);

    user.tokens = [token]
      .concat(user.tokens.filter((item) => item !== token))
      .slice(0, MAX_TOKENS_PER_USER);
    user.lastLoginAt = Date.now();
    user.updatedAt = Date.now();
    saveUsers();

    return token;
  }

  function publicUser(user) {
    return {
      id: user.id,
      nickname: user.nickname,
      avatar: user.avatar,
      phone: user.phone,
      profileComplete: !!user.profileComplete,
      recipientName: user.recipientName || '',
      address: user.address || '',
      location: user.location || null,
      prefillNickname: user.profileComplete ? '' : user.prefillNickname || '',
      prefillAvatar: user.profileComplete ? '' : user.prefillAvatar || '',
    };
  }

  function validateNickname(raw) {
    const nickname = cleanText(raw, 16);

    if (!nickname) throw new HttpError(400, '请填写昵称');
    if (Array.from(nickname).length > 16) {
      throw new HttpError(400, '昵称最多 16 个字');
    }

    return nickname;
  }

  function validateAvatar(raw) {
    const avatar = String(raw == null ? '' : raw).trim();

    if (!avatar) throw new HttpError(400, '请选择头像');
    if (avatar.length > MAX_AVATAR_LENGTH) {
      throw new HttpError(400, '头像图片太大，请重新选择');
    }

    // 只接受压缩后的 JPEG/PNG/WebP data URL，拒绝 SVG，避免脚本注入
    if (/^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar)) {
      return avatar;
    }

    if (
      /^https?:\/\/(?:[a-z0-9-]+\.)*(?:qlogo\.cn|weixin\.qq\.com|wx\.qq\.com)\/[^\s"'<>]+$/i.test(
        avatar
      ) &&
      avatar.length <= 500
    ) {
      return avatar;
    }

    if (avatar.length <= 16 && !/[\u0000-\u001f\u007f<>]/.test(avatar)) {
      return avatar;
    }

    throw new HttpError(400, '头像格式不正确');
  }

  // ---------- 商家会话 ----------
  function createSession() {
    const token = randomBytesHex(24);
    sessions.set(token, Date.now() + SESSION_TTL_MS);
    return token;
  }

  function getAdminToken(req) {
    const header = String(req.get('x-admin-token') || '');
    if (header) return header;

    const auth = String(req.get('authorization') || '');
    if (auth.toLowerCase().indexOf('bearer ') === 0) {
      return auth.slice(7).trim();
    }

    return '';
  }

  function requireAdmin(req) {
    const token = getAdminToken(req);
    const expiresAt = sessions.get(token);

    if (!expiresAt) throw new HttpError(401, '请先登录商家后台');
    if (expiresAt < Date.now()) {
      sessions.delete(token);
      throw new HttpError(401, '登录已过期，请重新登录');
    }
  }

  function checkLoginBlocked(ip) {
    const record = loginAttempts.get(ip);
    if (!record) return false;

    if (record.blockedUntil && record.blockedUntil > Date.now()) {
      return true;
    }

    if (record.firstAt && Date.now() - record.firstAt > LOGIN_WINDOW_MS) {
      loginAttempts.delete(ip);
    }

    return false;
  }

  function recordLoginFailure(ip) {
    const now = Date.now();
    let record = loginAttempts.get(ip);

    if (!record || now - record.firstAt > LOGIN_WINDOW_MS) {
      record = { firstAt: now, failures: 0, blockedUntil: 0 };
    }

    record.failures += 1;

    if (record.failures >= LOGIN_MAX_FAILURES) {
      record.blockedUntil = now + LOGIN_BLOCK_MS;
    }

    loginAttempts.set(ip, record);
  }

  function clearLoginFailures(ip) {
    loginAttempts.delete(ip);
  }

  function checkOrderRate(ip) {
    const now = Date.now();
    const history = (orderAttempts.get(ip) || []).filter(
      (time) => now - time < ORDER_RATE_WINDOW_MS
    );

    if (history.length >= ORDER_RATE_LIMIT) {
      throw new HttpError(429, '下单太频繁，请稍后再试');
    }

    history.push(now);
    orderAttempts.set(ip, history);
  }

  function checkAuthRate(ip) {
    const now = Date.now();
    const history = (authAttempts.get(ip) || []).filter(
      (time) => now - time < AUTH_RATE_WINDOW_MS
    );

    if (history.length >= AUTH_RATE_LIMIT) {
      throw new HttpError(429, '登录太频繁，请稍后再试');
    }

    history.push(now);
    authAttempts.set(ip, history);
  }

  function checkGeocodeRate(key) {
    const now = Date.now();
    const history = (geocodeAttempts.get(key) || []).filter(
      (time) => now - time < GEOCODE_RATE_WINDOW_MS
    );

    if (history.length >= GEOCODE_RATE_LIMIT) {
      throw new HttpError(429, '定位太频繁，请稍后再试');
    }

    history.push(now);
    geocodeAttempts.set(key, history);
  }

  // ---------- 优惠券 ----------
  function accountOrderCount(accountId) {
    return orders.filter(
      (order) => order.accountId === accountId && order.status !== STATUS.CANCELLED
    ).length;
  }

  function findCouponTemplate(templateId) {
    return couponTemplates.find((item) => item.id === templateId) || null;
  }

  function issueCouponToAccount(template, user) {
    const existing = userCoupons.find(
      (coupon) =>
        coupon.accountId === user.id &&
        coupon.templateId === template.id &&
        coupon.status === 'unused'
    );

    if (existing) return null;

    const now = Date.now();
    const coupon = {
      id: randomId('uc_'),
      accountId: user.id,
      phone: user.phone,
      accountNickname: user.nickname,
      templateId: template.id,
      name: template.name,
      thresholdCents: template.thresholdCents,
      discountCents: template.discountCents,
      onlyFirstOrder: !!template.onlyFirstOrder,
      status: 'unused',
      issuedAt: now,
      usedAt: 0,
      orderId: '',
    };

    userCoupons.push(coupon);
    return coupon;
  }

  function autoIssueCoupons(user) {
    if (!user || !user.profileComplete) return false;
    if (accountOrderCount(user.id) > 0) return false;

    let changed = false;

    couponTemplates.forEach((template) => {
      if (!template.enabled || !template.autoIssue) return;

      const already = userCoupons.some(
        (coupon) => coupon.accountId === user.id && coupon.templateId === template.id
      );

      if (already) return;

      const issued = issueCouponToAccount(template, user);
      if (issued) changed = true;
    });

    if (changed) saveUserCoupons();
    return changed;
  }

  function availableCoupons(user) {
    autoIssueCoupons(user);

    const orderCount = accountOrderCount(user.id);

    return userCoupons
      .filter(
        (coupon) => coupon.accountId === user.id && coupon.status === 'unused'
      )
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .map((coupon) => ({
        id: coupon.id,
        templateId: coupon.templateId,
        name: coupon.name,
        thresholdCents: coupon.thresholdCents,
        discountCents: coupon.discountCents,
        onlyFirstOrder: !!coupon.onlyFirstOrder,
        blockedByFirstOrder: !!coupon.onlyFirstOrder && orderCount > 0,
        issuedAt: coupon.issuedAt,
      }));
  }

  function knownCustomers() {
    const stats = new Map();

    orders.forEach((order) => {
      if (!order.accountId) return;
      if (order.status === STATUS.CANCELLED) return;

      const item = stats.get(order.accountId) || { orderCount: 0, lastOrderAt: 0 };
      item.orderCount += 1;
      item.lastOrderAt = Math.max(item.lastOrderAt, order.createdAt || 0);
      stats.set(order.accountId, item);
    });

    return users
      .filter((user) => user.profileComplete)
      .map((user) => {
        const stat = stats.get(user.id) || { orderCount: 0, lastOrderAt: 0 };
        return {
          accountId: user.id,
          nickname: user.nickname,
          avatar: user.avatar,
          phone: user.phone,
          orderCount: stat.orderCount,
          lastOrderAt: stat.lastOrderAt,
          createdAt: user.createdAt,
        };
      })
      .sort(
        (a, b) =>
          Math.max(b.lastOrderAt, b.createdAt) - Math.max(a.lastOrderAt, a.createdAt)
      );
  }

  // ---------- 订单 ----------
  function normalizeOrderItems(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length === 0) {
      throw new HttpError(400, '请先选择菜品');
    }

    if (rawItems.length > MAX_ITEMS) {
      throw new HttpError(400, '菜品数量过多');
    }

    const counts = new Map();

    for (const raw of rawItems) {
      const id = String((raw && raw.id) || '');
      const count = Math.floor(Number(raw && raw.count) || 0);

      if (!id || count < 1 || count > MAX_ITEM_COUNT) {
        throw new HttpError(400, '菜品数量不正确');
      }

      const dish = menuById.get(id);

      if (!dish || dish.enabled === false) {
        throw new HttpError(400, '有菜品已下架，请刷新菜单');
      }

      if (dish.soldOut) {
        throw new HttpError(409, `「${dish.name}」已售罄，请刷新菜单`);
      }

      const next = (counts.get(id) || 0) + count;
      if (next > MAX_ITEM_COUNT) {
        throw new HttpError(400, '单个菜品数量过多');
      }
      counts.set(id, next);
    }

    const items = [];
    let subtotalCents = 0;
    let itemCount = 0;

    counts.forEach((count, id) => {
      const dish = menuById.get(id);
      const subtotal = dish.priceCents * count;
      subtotalCents += subtotal;
      itemCount += count;

      items.push({
        id,
        name: dish.name,
        priceCents: dish.priceCents,
        unit: dish.unit,
        count,
        subtotalCents: subtotal,
      });
    });

    return { items, subtotalCents, itemCount };
  }

  function normalizeOrderInfo(body) {
    const recipientName = cleanText(body.recipientName, 20);
    const phone = validatePhone(body.phone);
    const address = cleanText(body.address, 200);
    const note = cleanText(body.note, 100);
    const location = normalizeLocation(body.location);

    if (!recipientName) throw new HttpError(400, '请填写收货人姓名');
    if (address.length < 5) throw new HttpError(400, '请填写完整的配送地址');

    return { recipientName, phone, address, note, location };
  }

  function nextPickup(dateKey) {
    let maxSeq = 0;

    orders.forEach((order) => {
      if (order.pickupDate === dateKey) {
        maxSeq = Math.max(maxSeq, Number(order.dailySeq) || 0);
      }
    });

    const seq = maxSeq + 1;
    return {
      dailySeq: seq,
      pickupNo: 'A' + String(seq).padStart(3, '0'),
    };
  }

  function createOrder(body, user, ip) {
    checkOrderRate(ip);

    const normalizedItems = normalizeOrderItems(body.items);
    const info = normalizeOrderInfo(body);

    let coupon = null;
    let discountCents = 0;
    let userCoupon = null;

    const couponId = String(body.couponId || '');

    if (couponId) {
      userCoupon = userCoupons.find((item) => item.id === couponId);

      if (!userCoupon || userCoupon.accountId !== user.id) {
        throw new HttpError(400, '优惠券不存在');
      }

      if (userCoupon.status !== 'unused') {
        throw new HttpError(409, '优惠券已使用');
      }

      if (normalizedItems.subtotalCents < userCoupon.thresholdCents) {
        throw new HttpError(400, '未达到优惠券使用门槛');
      }

      if (userCoupon.onlyFirstOrder && accountOrderCount(user.id) > 0) {
        throw new HttpError(409, '该优惠券仅限首单使用');
      }

      discountCents = Math.min(userCoupon.discountCents, normalizedItems.subtotalCents);

      coupon = {
        userCouponId: userCoupon.id,
        templateId: userCoupon.templateId,
        name: userCoupon.name,
        thresholdCents: userCoupon.thresholdCents,
        discountCents,
      };
    }

    const orderDeliveryFeeCents =
      normalizedItems.subtotalCents >= config.freeDeliveryThresholdCents
        ? 0
        : config.deliveryFeeCents;

    const now = Date.now();
    const dateKey = localDateKey(now);
    const pickup = nextPickup(dateKey);
    const order = {
      id: randomId('ord_'),
      token: randomBytesHex(24),
      pickupNo: pickup.pickupNo,
      pickupDate: dateKey,
      dailySeq: pickup.dailySeq,
      status: STATUS.PENDING,
      accountId: user.id,
      accountNickname: user.nickname,
      accountPhone: user.phone,
      recipientName: info.recipientName,
      phone: info.phone,
      address: info.address,
      location: info.location,
      note: info.note,
      items: normalizedItems.items,
      itemCount: normalizedItems.itemCount,
      subtotalCents: normalizedItems.subtotalCents,
      deliveryFeeCents: orderDeliveryFeeCents,
      discountCents,
      totalCents: Math.max(
        0,
        normalizedItems.subtotalCents + orderDeliveryFeeCents - discountCents
      ),
      coupon,
      createdAt: now,
      updatedAt: now,
    };

    const previousCoupon = userCoupon
      ? {
          status: userCoupon.status,
          usedAt: userCoupon.usedAt,
          orderId: userCoupon.orderId,
        }
      : null;

    if (userCoupon) {
      userCoupon.status = 'used';
      userCoupon.usedAt = now;
      userCoupon.orderId = order.id;
    }

    orders.push(order);

    try {
      saveOrders();
      if (userCoupon) saveUserCoupons();
    } catch (err) {
      const index = orders.indexOf(order);
      if (index >= 0) orders.splice(index, 1);

      if (userCoupon && previousCoupon) {
        userCoupon.status = previousCoupon.status;
        userCoupon.usedAt = previousCoupon.usedAt;
        userCoupon.orderId = previousCoupon.orderId;
      }

      try {
        saveOrders();
        if (userCoupon) saveUserCoupons();
      } catch (rollbackErr) {
        console.error('[存储] 回滚失败', rollbackErr);
      }

      console.error('[存储] 订单保存失败', err);
      throw new HttpError(500, '订单保存失败，请重试');
    }

    // 记住本次配送信息，下次点单直接带出；失败不影响订单
    try {
      user.recipientName = info.recipientName;
      user.address = info.address;
      user.location = info.location;
      user.updatedAt = now;
      saveUsers();
    } catch (err) {
      console.error('[存储] 配送信息保存失败', err);
    }

    return { order, token: order.token };
  }

  function customerOrderView(order) {
    return {
      id: order.id,
      pickupNo: order.pickupNo,
      status: order.status,
      recipientName: order.recipientName || '',
      phone: order.phone || '',
      address: order.address || '',
      location: order.location || null,
      items: order.items,
      itemCount: order.itemCount,
      subtotalCents: order.subtotalCents,
      deliveryFeeCents: Number(order.deliveryFeeCents) || 0,
      discountCents: order.discountCents,
      totalCents: order.totalCents,
      coupon: order.coupon
        ? {
            name: order.coupon.name,
            thresholdCents: order.coupon.thresholdCents,
            discountCents: order.coupon.discountCents,
          }
        : null,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  function adminOrderView(order) {
    return Object.assign(customerOrderView(order), {
      accountId: order.accountId || '',
      accountNickname: order.accountNickname || '',
      accountPhone: order.accountPhone || '',
      note: order.note || '',
    });
  }

  function cancelOrderCoupon(order) {
    if (!order.coupon || !order.coupon.userCouponId) return null;

    const userCoupon = userCoupons.find(
      (item) => item.id === order.coupon.userCouponId
    );

    if (!userCoupon || userCoupon.status !== 'used' || userCoupon.orderId !== order.id) {
      return null;
    }

    return userCoupon;
  }

  // ---------- 推荐 ----------
  function isRecommendableDish(dish) {
    return !!dish && dish.enabled !== false && !dish.soldOut;
  }

  function buildRecommendations(user) {
    const recent = [];
    const recentIds = new Set();

    if (user) {
      const userOrders = orders
        .filter(
          (order) =>
            order.accountId === user.id && order.status !== STATUS.CANCELLED
        )
        .sort((a, b) => b.createdAt - a.createdAt);

      for (const order of userOrders) {
        for (const item of order.items || []) {
          if (recentIds.has(item.id)) continue;

          const dish = menuById.get(item.id);
          if (!isRecommendableDish(dish)) continue;

          recentIds.add(item.id);
          recent.push(item.id);

          if (recent.length >= 6) break;
        }
        if (recent.length >= 6) break;
      }
    }

    const sales = new Map();

    orders.forEach((order) => {
      if (order.status === STATUS.CANCELLED) return;

      (order.items || []).forEach((item) => {
        const dish = menuById.get(item.id);
        if (!isRecommendableDish(dish)) return;

        const count = Math.max(0, Number(item.count) || 0);
        if (count <= 0) return;

        sales.set(item.id, (sales.get(item.id) || 0) + count);
      });
    });

    const popular = Array.from(sales.entries())
      .filter(([id]) => !recentIds.has(id))
      .sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];

        const dishA = menuById.get(a[0]);
        const dishB = menuById.get(b[0]);
        return (dishA ? dishA.sort : 0) - (dishB ? dishB.sort : 0);
      })
      .slice(0, 6)
      .map(([id]) => id);

    return { recent, popular };
  }

  // ---------- 接口 ----------
  function apiAuthConfig() {
    return json({
      deliveryFeeCents: config.deliveryFeeCents,
      freeDeliveryThresholdCents: config.freeDeliveryThresholdCents,
      amapConfigured: !!config.amapKey,
    });
  }

  function apiAuthLogin(req) {
    checkAuthRate(req.ip);

    // Cloudflare 版本不接微信公众号网页授权，顾客一律使用本机账号。
    const user = createUser();
    users.push(user);
    const token = issueUserToken(user);

    return json(
      {
        mode: 'local',
        token,
        user: publicUser(user),
      },
      201
    );
  }

  function apiMe(req) {
    const user = requireUser(req);
    return json({ user: publicUser(user) });
  }

  function apiProfile(req) {
    const user = requireUser(req);
    const body = req.body || {};

    if (user.profileComplete) {
      throw new HttpError(409, '昵称和头像首次设置后不可修改');
    }

    const nickname = validateNickname(
      body.nickname != null ? body.nickname : user.prefillNickname
    );
    const avatar = validateAvatar(
      body.avatar != null ? body.avatar : user.prefillAvatar
    );
    const phone = validatePhone(body.phone);

    const phoneOwner = userByPhone(phone);
    if (phoneOwner && phoneOwner.id !== user.id) {
      throw new HttpError(409, '该手机号已绑定其他账号');
    }

    user.nickname = nickname;
    user.avatar = avatar;
    user.phone = phone;
    user.profileComplete = true;
    user.updatedAt = Date.now();
    saveUsers();
    autoIssueCoupons(user);

    return json({ user: publicUser(user) });
  }

  function apiMenu(req) {
    return json({
      store: {
        storeName: config.storeName,
        shopPhone: config.shopPhone,
        hours: config.hours,
        notice: config.notice,
        deliveryFeeCents: config.deliveryFeeCents,
        freeDeliveryThresholdCents: config.freeDeliveryThresholdCents,
      },
      menu: customerMenu(),
      categories: ['全部'].concat(categoriesOfMenu()),
      recommendations: buildRecommendations(getOptionalUser(req)),
      serverTime: Date.now(),
    });
  }

  async function apiGeocode(req) {
    const user = requireUser(req);
    checkGeocodeRate(user.id);

    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      throw new HttpError(400, '定位坐标不正确');
    }

    let result = null;

    if (config.amapKey) {
      try {
        result = await amapReverse(lat, lng);
      } catch (err) {
        console.warn('[定位] 高德解析失败，尝试备用服务', err.message);
      }
    }

    if (!result) {
      try {
        result = await nominatimReverse(lat, lng);
      } catch (err) {
        console.warn('[定位] 备用地址解析失败', err.message);
      }
    }

    if (!result) {
      throw new HttpError(502, '定位成功，但地址解析失败，请手动填写详细地址');
    }

    return json({ address: result.address, provider: result.provider, lat, lng });
  }

  async function amapReverse(lat, lng) {
    const gcj = wgs84ToGcj02(lng, lat);
    const url =
      'https://restapi.amap.com/v3/geocode/regeo?key=' +
      encodeURIComponent(config.amapKey) +
      '&location=' +
      encodeURIComponent(gcj.lng + ',' + gcj.lat) +
      '&extensions=base&radius=1000';

    const data = await fetchJson(url);

    if (String(data.status) !== '1') {
      throw new Error(data.info || '高德地址解析失败');
    }

    const formatted =
      data.regeocode && String(data.regeocode.formatted_address || '').trim();

    if (!formatted) throw new Error('高德没有返回地址');

    return { address: formatted.slice(0, 200), provider: 'amap' };
  }

  async function nominatimReverse(lat, lng) {
    const url =
      'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
      '&lat=' +
      encodeURIComponent(lat) +
      '&lon=' +
      encodeURIComponent(lng) +
      '&zoom=18&addressdetails=1&accept-language=zh-CN';

    const data = await fetchJson(url, {
      headers: {
        'User-Agent': 'gagaxiang-h5-order/1.0 (' + (config.shopPhone || 'shop') + ')',
        'Accept-Language': 'zh-CN',
      },
    });

    const address = nominatimAddress(data);
    if (!address) throw new Error('没有解析出地址');

    return { address: address.slice(0, 200), provider: 'openstreetmap' };
  }

  function apiCoupons(req) {
    const user = requireUser(req);
    requireProfile(user);

    return json({
      coupons: availableCoupons(user),
      orderCount: accountOrderCount(user.id),
    });
  }

  function apiCreateOrder(req) {
    const user = requireUser(req);
    requireProfile(user);

    const created = createOrder(req.body || {}, user, req.ip);
    const view = customerOrderView(created.order);

    return json(Object.assign({}, view, { token: created.token }), 201);
  }

  function apiMyOrders(req) {
    const user = requireUser(req);
    requireProfile(user);

    const list = orders
      .filter((order) => order.accountId === user.id)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((order) => Object.assign(customerOrderView(order), { token: order.token }));

    return json({ orders: list });
  }

  function apiOrderDetail(req, orderId) {
    const order = orders.find((item) => item.id === orderId);
    const token = String(req.query.token || '');
    const user = getOptionalUser(req);

    const byToken = order && safeEqual(order.token, token);
    const byAccount = order && user && order.accountId === user.id;

    if (!order || (!byToken && !byAccount)) {
      throw new HttpError(404, '订单不存在');
    }

    return json({ order: customerOrderView(order) });
  }

  function apiAdminLogin(req) {
    const ip = req.ip || 'unknown';

    if (checkLoginBlocked(ip)) {
      throw new HttpError(429, '尝试次数过多，请 10 分钟后再试');
    }

    const password = String((req.body && req.body.password) || '');

    if (!safeEqual(password, config.adminPassword)) {
      recordLoginFailure(ip);
      throw new HttpError(401, '口令不正确');
    }

    clearLoginFailures(ip);
    const token = createSession();

    return json({ token, expiresAt: sessions.get(token) });
  }

  function apiAdminLogout(req) {
    sessions.delete(getAdminToken(req));
    return json({ success: true });
  }

  function apiAdminOrders(req) {
    requireAdmin(req);

    const list = orders
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(adminOrderView);

    return json({ orders: list, serverTime: Date.now() });
  }

  function apiAdminOrderStatus(req, orderId) {
    requireAdmin(req);

    const order = orders.find((item) => item.id === orderId);
    if (!order) throw new HttpError(404, '订单不存在');

    const nextStatus = String((req.body && req.body.status) || '');
    const allowed = ALLOWED_TRANSITIONS[order.status] || [];

    if (allowed.indexOf(nextStatus) === -1) {
      throw new HttpError(409, '订单状态不能这样变更');
    }

    const previousStatus = order.status;
    const previousUpdatedAt = order.updatedAt;
    let userCoupon = null;
    let previousCoupon = null;

    order.status = nextStatus;
    order.updatedAt = Date.now();

    if (nextStatus === STATUS.CANCELLED) {
      userCoupon = cancelOrderCoupon(order);

      if (userCoupon) {
        previousCoupon = {
          status: userCoupon.status,
          usedAt: userCoupon.usedAt,
          orderId: userCoupon.orderId,
        };
        userCoupon.status = 'unused';
        userCoupon.usedAt = 0;
        userCoupon.orderId = '';
      }
    }

    try {
      saveOrders();
      if (userCoupon) saveUserCoupons();
    } catch (err) {
      order.status = previousStatus;
      order.updatedAt = previousUpdatedAt;

      if (userCoupon && previousCoupon) {
        userCoupon.status = previousCoupon.status;
        userCoupon.usedAt = previousCoupon.usedAt;
        userCoupon.orderId = previousCoupon.orderId;
      }

      console.error('[存储] 订单状态保存失败', err);
      throw new HttpError(500, '订单状态保存失败，请重试');
    }

    return json({ order: adminOrderView(order) });
  }

  function apiAdminMenu(req) {
    requireAdmin(req);

    return json({
      menu: menu
        .slice()
        .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)
        .map(adminDish),
      categories: categoriesOfMenu(),
    });
  }

  function apiAdminSaveDish(req) {
    requireAdmin(req);

    const body = req.body || {};
    const existing = body.id ? menuById.get(String(body.id)) : null;

    const name = String(body.name || '').trim().slice(0, 30);
    const category = String(body.category || '').trim().slice(0, 20);
    const priceCents = Math.round(Number(body.priceCents));

    if (!name) throw new HttpError(400, '请填写菜品名称');
    if (!category) throw new HttpError(400, '请填写菜品分类');
    if (!(priceCents > 0)) throw new HttpError(400, '价格必须大于 0');

    const now = Date.now();

    if (existing) {
      existing.name = name;
      existing.category = category;
      existing.priceCents = priceCents;
      existing.unit = String(body.unit || existing.unit || '份').trim().slice(0, 10);
      existing.desc = String(body.desc || '').trim().slice(0, 80);
      existing.emoji = String(body.emoji || existing.emoji || '🍢').trim().slice(0, 8);
      existing.tag = String(body.tag || '').trim().slice(0, 10);
      existing.soldOut = body.soldOut != null ? !!body.soldOut : existing.soldOut;
      existing.enabled = body.enabled != null ? !!body.enabled : existing.enabled;
      existing.updatedAt = now;
    } else {
      const maxSort = menu.reduce(
        (max, dish) => Math.max(max, Number(dish.sort) || 0),
        -10
      );

      const dish = {
        id: randomId('dish_'),
        emoji: String(body.emoji || '🍢').trim().slice(0, 8) || '🍢',
        name,
        category,
        desc: String(body.desc || '').trim().slice(0, 80),
        priceCents,
        unit: String(body.unit || '份').trim().slice(0, 10) || '份',
        tag: String(body.tag || '').trim().slice(0, 10),
        soldOut: !!body.soldOut,
        enabled: body.enabled !== false,
        sort: maxSort + 10,
        createdAt: now,
        updatedAt: now,
      };

      menu.push(dish);
    }

    saveMenu();
    rebuildMenuIndex();

    const saved = existing || menu[menu.length - 1];
    return json({ dish: adminDish(saved) });
  }

  function apiAdminDishStatus(req, dishId) {
    requireAdmin(req);

    const dish = menuById.get(dishId);
    if (!dish) throw new HttpError(404, '菜品不存在');

    const body = req.body || {};

    if (typeof body.soldOut === 'boolean') dish.soldOut = body.soldOut;
    if (typeof body.enabled === 'boolean') dish.enabled = body.enabled;
    dish.updatedAt = Date.now();

    saveMenu();
    return json({ dish: adminDish(dish) });
  }

  function apiAdminCoupons(req) {
    requireAdmin(req);

    const issued = userCoupons
      .slice()
      .sort((a, b) => b.issuedAt - a.issuedAt)
      .slice(0, 200)
      .map((coupon) => {
        const user = coupon.accountId ? userById(coupon.accountId) : null;
        return Object.assign({}, coupon, {
          accountNickname: coupon.accountNickname || (user ? user.nickname : ''),
          phone: coupon.phone || (user ? user.phone : ''),
          legacyDeviceId:
            !coupon.accountId && coupon.deviceId ? coupon.deviceId : '',
        });
      });

    return json({
      templates: couponTemplates
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt),
      issued,
      customers: knownCustomers(),
    });
  }

  function apiAdminSaveCoupon(req) {
    requireAdmin(req);

    const body = req.body || {};
    const name = String(body.name || '').trim().slice(0, 20);
    const thresholdCents = Math.round(Number(body.thresholdCents));
    const discountCents = Math.round(Number(body.discountCents));
    const existing = body.id
      ? couponTemplates.find((item) => item.id === String(body.id))
      : null;

    if (!name) throw new HttpError(400, '请填写优惠券名称');
    if (!(thresholdCents > 0)) throw new HttpError(400, '门槛必须大于 0');
    if (!(discountCents > 0)) throw new HttpError(400, '优惠金额必须大于 0');
    if (discountCents > thresholdCents) {
      throw new HttpError(400, '优惠金额不能大于门槛');
    }

    const now = Date.now();

    if (existing) {
      existing.name = name;
      existing.thresholdCents = thresholdCents;
      existing.discountCents = discountCents;
      existing.autoIssue =
        body.autoIssue != null ? !!body.autoIssue : existing.autoIssue;
      existing.onlyFirstOrder =
        body.onlyFirstOrder != null ? !!body.onlyFirstOrder : existing.onlyFirstOrder;
      existing.enabled = body.enabled != null ? !!body.enabled : existing.enabled;
      existing.updatedAt = now;
    } else {
      couponTemplates.push({
        id: randomId('coupon_'),
        name,
        thresholdCents,
        discountCents,
        autoIssue: !!body.autoIssue,
        onlyFirstOrder: !!body.onlyFirstOrder,
        enabled: body.enabled !== false,
        createdAt: now,
        updatedAt: now,
      });
    }

    saveCoupons();

    return json({
      template: existing || couponTemplates[couponTemplates.length - 1],
    });
  }

  // 商家数据导出：Durable Objects 没有现成的文件备份，用这个接口下载 JSON 备份
  function apiAdminExport(req) {
    requireAdmin(req);

    return json({
      exportedAt: Date.now(),
      menu,
      orders,
      users,
      couponTemplates,
      userCoupons,
    });
  }

  function apiAdminIssueCoupon(req) {    requireAdmin(req);

    const body = req.body || {};
    const template = findCouponTemplate(String(body.templateId || ''));
    const phone = validatePhone(body.phone);

    if (!template) throw new HttpError(404, '优惠券模板不存在');
    if (!template.enabled) throw new HttpError(409, '优惠券已停用');

    const targets = users.filter(
      (user) => user.profileComplete && user.phone === phone
    );

    if (targets.length === 0) {
      throw new HttpError(
        404,
        '该手机号还没有完成登录，请让顾客先登录并填写手机号'
      );
    }

    let issued = 0;

    targets.forEach((user) => {
      const coupon = issueCouponToAccount(template, user);
      if (coupon) issued += 1;
    });

    if (issued > 0) saveUserCoupons();

    return json({
      issued,
      total: targets.length,
      phone,
      nickname: targets[0].nickname,
      message:
        issued > 0
          ? '已发放给 ' + targets[0].nickname
          : '该顾客已经有一张未使用的同款优惠券',
    });
  }

  // ---------- 路由 ----------
  async function dispatch(req) {
    const method = req.method;
    const path = req.path;

    if (path === '/api/auth/config' && method === 'GET') return apiAuthConfig();
    if (path === '/api/auth/login' && method === 'POST') return apiAuthLogin(req);
    if (path === '/api/me' && method === 'GET') return apiMe(req);
    if (path === '/api/auth/profile' && method === 'POST') return apiProfile(req);
    if (path === '/api/menu' && method === 'GET') return apiMenu(req);
    if (path === '/api/geocode' && method === 'GET') return apiGeocode(req);
    if (path === '/api/coupons' && method === 'GET') return apiCoupons(req);
    if (path === '/api/order' && method === 'POST') return apiCreateOrder(req);
    if (path === '/api/my-orders' && method === 'GET') return apiMyOrders(req);

    const orderMatch = path.match(/^\/api\/order\/([^/]+)$/);
    if (orderMatch && method === 'GET') {
      return apiOrderDetail(req, decodeURIComponent(orderMatch[1]));
    }

    if (path === '/api/admin/login' && method === 'POST') return apiAdminLogin(req);
    if (path === '/api/admin/logout' && method === 'POST') return apiAdminLogout(req);
    if (path === '/api/admin/orders' && method === 'GET') return apiAdminOrders(req);
    if (path === '/api/admin/menu' && method === 'GET') return apiAdminMenu(req);
    if (path === '/api/admin/menu' && method === 'POST') return apiAdminSaveDish(req);
    if (path === '/api/admin/coupons' && method === 'GET') return apiAdminCoupons(req);
    if (path === '/api/admin/export' && method === 'GET') return apiAdminExport(req);
    if (path === '/api/admin/coupons' && method === 'POST') return apiAdminSaveCoupon(req);
    if (path === '/api/admin/coupons/issue' && method === 'POST') {
      return apiAdminIssueCoupon(req);
    }

    const orderStatusMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/status$/);
    if (orderStatusMatch && method === 'POST') {
      return apiAdminOrderStatus(req, decodeURIComponent(orderStatusMatch[1]));
    }

    const dishStatusMatch = path.match(/^\/api\/admin\/menu\/([^/]+)\/status$/);
    if (dishStatusMatch && method === 'POST') {
      return apiAdminDishStatus(req, decodeURIComponent(dishStatusMatch[1]));
    }

    if (path.indexOf('/api/') === 0) {
      return json({ error: '接口不存在' }, 404);
    }

    return text('页面不存在', 404);
  }

  async function buildRequest(request) {
    const url = new URL(request.url);
    const method = String(request.method || 'GET').toUpperCase();

    let body = {};

    if (method !== 'GET' && method !== 'HEAD') {
      const contentType = request.headers.get('content-type') || '';
      const raw = await request.text();

      if (raw) {
        if (raw.length > MAX_BODY_LENGTH) {
          throw new HttpError(413, '请求内容过大');
        }

        if (contentType.indexOf('application/json') !== -1) {
          try {
            body = JSON.parse(raw);
          } catch (err) {
            throw new HttpError(400, '请求格式不正确');
          }
        }
      }
    }

    const query = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    return {
      method,
      path: url.pathname,
      query,
      body: body && typeof body === 'object' ? body : {},
      headers: request.headers,
      ip:
        request.headers.get('cf-connecting-ip') ||
        (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
        'unknown',
      get(name) {
        return request.headers.get(name);
      },
    };
  }

  async function handle(request) {
    try {
      const req = await buildRequest(request);
      const response = await dispatch(req);
      const headers = securityHeaders(response.headers);
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch (err) {
      return errorResponse(err);
    }
  }

  return { handle };
}
