'use strict';

// server.js —— 嘎嘎香 乐山油炸串串 H5 外卖点单系统
// Express 单服务：托管静态页面 + JSON API
// 金额统一以「分」存储和计算，客户端只提交菜品 id、数量和优惠券 id。
//
// 启动：npm install && node server.js
// 顾客端：http://localhost:3000
// 商家端：http://localhost:3000/admin

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const { createWechatAuth } = require('./lib/wechat-auth');
const { createWechatAuthRouter } = require('./routes/wechat-auth');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.CONFIG_PATH || path.join(ROOT, 'config.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

// 云托管持久化（CFS 挂载）支持：
// CFS 首次挂载是空目录，会遮住镜像内自带的 data/。启动时若 default-data 存在，
// 把内置默认数据播种到数据目录（仅复制缺失文件，不覆盖已有数据，幂等）。
const DEFAULT_DATA_DIR = path.join(ROOT, 'default-data');
if (fs.existsSync(DEFAULT_DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const entry of fs.readdirSync(DEFAULT_DATA_DIR)) {
    const target = path.join(DATA_DIR, entry);
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(DEFAULT_DATA_DIR, entry), target);
    }
  }
}

const MENU_SOURCE_FILE = path.join(DATA_DIR, 'menu.js');
const MENU_FILE = path.join(DATA_DIR, 'menu.json');
const LEGACY_MENU_STATE_FILE = path.join(DATA_DIR, 'menu-state.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const COUPONS_FILE = path.join(DATA_DIR, 'coupons.json');
const USER_COUPONS_FILE = path.join(DATA_DIR, 'user-coupons.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ==================== 基础工具 ====================

function saveJson(file, data) {
  // 先写临时文件再改名，避免写到一半断电留下损坏 JSON
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;

  const text = fs.readFileSync(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(path.basename(file) + ' 格式错误：' + err.message);
  }
}

function randomId(prefix) {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : crypto.randomBytes(16).toString('hex');
  return prefix + id.replace(/-/g, '');
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ''));
  const right = Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function localDateKey(timestamp) {
  const d = new Date(timestamp || Date.now());
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
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

// ==================== 配置 ====================

function defaultConfig() {
  return {
    port: 3000,
    adminPassword:
      'gx-' + crypto.randomBytes(5).toString('base64url').slice(0, 8),
    storeName: '嘎嘎香 乐山油炸串串',
    shopPhone: '15528775725',
    hours: '每天 17:00 - 次日 00:30',
    notice: '外卖配送，提交订单后商家会电话联系确认，线下支付',
    deliveryFeeCents: 300,
    freeDeliveryThresholdCents: 5000,
    amapKey: '',
    publicBaseUrl: '',
  };
}

function loadConfig() {
  let config = null;
  let hadPassword = false;

  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    hadPassword = !!(
      config.adminPassword &&
      config.adminPassword !== '请改成你自己的口令'
    );
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw new Error('config.json 格式不正确：' + err.message);
    }
  }

  if (!config) {
    config = defaultConfig();
    hadPassword = true;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    console.log('[配置] 已生成 config.json');
    console.log('[配置] 商家后台口令：' + config.adminPassword);
  }

  config = Object.assign(defaultConfig(), config);

  config.port = Number(process.env.PORT || config.port || 3000);

  const fee = Math.round(Number(config.deliveryFeeCents));
  config.deliveryFeeCents = Number.isFinite(fee) && fee >= 0 ? fee : 300;

  const threshold = Math.round(Number(config.freeDeliveryThresholdCents));
  config.freeDeliveryThresholdCents =
    Number.isFinite(threshold) && threshold >= 0 ? threshold : 5000;

  config.amapKey = String(config.amapKey || '').trim();
  config.publicBaseUrl = String(config.publicBaseUrl || '').trim();

  const envPassword = process.env.ADMIN_PASSWORD;
  if (envPassword) {
    config.adminPassword = envPassword;
    hadPassword = true;
  }

  if (!hadPassword) {
    config.adminPassword =
      'gx-' + crypto.randomBytes(5).toString('base64url').slice(0, 8);
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
    console.log('[配置] 已生成新的商家后台口令：' + config.adminPassword);
  }

  return config;
}

// ==================== 菜单 ====================

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
        soldOut:
          raw.soldOut != null ? !!raw.soldOut : legacySoldOut,
        enabled: raw.enabled !== false,
        sort: Number(raw.sort != null ? raw.sort : index * 10) || 0,
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now(),
      };
    })
    .filter((dish) => dish.id && dish.name && dish.priceCents > 0);
}

function loadMenu() {
  let list;
  let seeded = false;

  if (fs.existsSync(MENU_FILE)) {
    list = readJsonFile(MENU_FILE, []);
    if (!Array.isArray(list)) throw new Error('menu.json 必须是数组');
  } else {
    const source = require(MENU_SOURCE_FILE);
    if (!Array.isArray(source) || source.length === 0) {
      throw new Error('data/menu.js 里没有菜单数据');
    }

    const legacyState = readJsonFile(LEGACY_MENU_STATE_FILE, {});
    list = normalizeMenu(source, legacyState);
    seeded = true;
  }

  const normalized = normalizeMenu(list, {});

  if (normalized.length === 0) {
    throw new Error('菜单为空，请检查 data/menu.js');
  }

  if (seeded || !fs.existsSync(MENU_FILE)) {
    saveJson(MENU_FILE, normalized);
  }

  return normalized;
}

// ==================== 启动数据 ====================

fs.mkdirSync(DATA_DIR, { recursive: true });

const config = loadConfig();
const deliveryFeeCents = config.deliveryFeeCents;
const freeDeliveryThresholdCents = config.freeDeliveryThresholdCents;

// 可选能力：配置缺失或未启用时，模块内部 enabled=false，不参与任何启动校验
const wechatAuth = createWechatAuth({
  config: config.wechat,
  publicBaseUrl: config.publicBaseUrl,
});

let menu = loadMenu();

let orders = readJsonFile(ORDERS_FILE, []);
if (!Array.isArray(orders)) orders = [];

let couponTemplates = readJsonFile(COUPONS_FILE, null);
if (!Array.isArray(couponTemplates) || couponTemplates.length === 0) {
  const now = Date.now();
  couponTemplates = [
    {
      id: 'new_user_50_5',
      name: '新人首单券',
      thresholdCents: 5000,
      discountCents: 500,
      autoIssue: true,
      onlyFirstOrder: true,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    },
  ];
  saveJson(COUPONS_FILE, couponTemplates);
}

let userCoupons = readJsonFile(USER_COUPONS_FILE, []);
if (!Array.isArray(userCoupons)) userCoupons = [];

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

const rawUsers = readJsonFile(USERS_FILE, []);
let users = Array.isArray(rawUsers) ? rawUsers.map(normalizeUserRecord) : [];

if (!fs.existsSync(USERS_FILE)) {
  saveJson(USERS_FILE, users);
}

// 订单索引/工具
let menuById = new Map();
function rebuildMenuIndex() {
  menuById = new Map(menu.map((dish) => [dish.id, dish]));
}
rebuildMenuIndex();

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

// ==================== 顾客账号 / 微信登录 ====================

function saveUsers() {
  saveJson(USERS_FILE, users);
}

function userById(id) {
  return users.find((user) => user.id === id) || null;
}

function userByPhone(phone) {
  return users.find(
    (user) => user.profileComplete && user.phone === phone
  ) || null;
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

function requireUser(req, res, next) {
  const user = findUserByToken(getUserToken(req));

  if (!user) {
    return res.status(401).json({ error: '请先登录' });
  }

  req.user = user;
  next();
}

function requireProfile(req, res, next) {
  if (!req.user.profileComplete) {
    return res.status(403).json({ error: '请先完成昵称、头像和手机号设置' });
  }

  next();
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
  const token = crypto.randomBytes(32).toString('hex');

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

  // 微信授权头像（仅允许微信头像域名，避免任意远程图片）
  if (
    /^https?:\/\/(?:[a-z0-9-]+\.)*(?:qlogo\.cn|weixin\.qq\.com|wx\.qq\.com)\/[^\s"'<>]+$/i.test(
      avatar
    ) &&
    avatar.length <= 500
  ) {
    return avatar;
  }

  // 预置 emoji 头像
  if (avatar.length <= 16 && !/[\u0000-\u001f\u007f<>]/.test(avatar)) {
    return avatar;
  }

  throw new HttpError(400, '头像格式不正确');
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

const sessions = new Map();
const loginAttempts = new Map();
const orderAttempts = new Map();
const authAttempts = new Map();
const geocodeAttempts = new Map();

// ==================== 商家登录 ====================

function createSession() {
  const token = crypto.randomBytes(24).toString('hex');
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

function requireAdmin(req, res, next) {
  const token = getAdminToken(req);
  const expiresAt = sessions.get(token);

  if (!expiresAt) {
    return res.status(401).json({ error: '请先登录商家后台' });
  }

  if (expiresAt < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }

  next();
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

// ==================== 优惠券 ====================

function accountOrderCount(accountId) {
  return orders.filter(
    (order) =>
      order.accountId === accountId && order.status !== STATUS.CANCELLED
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
      (coupon) =>
        coupon.accountId === user.id &&
        coupon.templateId === template.id
    );

    if (already) return;

    const issued = issueCouponToAccount(template, user);
    if (issued) changed = true;
  });

  if (changed) saveJson(USER_COUPONS_FILE, userCoupons);
  return changed;
}

function availableCoupons(user) {
  autoIssueCoupons(user);

  const orderCount = accountOrderCount(user.id);

  return userCoupons
    .filter(
      (coupon) =>
        coupon.accountId === user.id && coupon.status === 'unused'
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

    const item = stats.get(order.accountId) || {
      orderCount: 0,
      lastOrderAt: 0,
    };
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
        Math.max(b.lastOrderAt, b.createdAt) -
        Math.max(a.lastOrderAt, a.createdAt)
    );
}

// ==================== 订单 ====================

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

  if (!recipientName) {
    throw new HttpError(400, '请填写收货人姓名');
  }

  if (address.length < 5) {
    throw new HttpError(400, '请填写完整的配送地址');
  }

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

    discountCents = Math.min(
      userCoupon.discountCents,
      normalizedItems.subtotalCents
    );

    coupon = {
      userCouponId: userCoupon.id,
      templateId: userCoupon.templateId,
      name: userCoupon.name,
      thresholdCents: userCoupon.thresholdCents,
      discountCents,
    };
  }

  const orderDeliveryFeeCents =
    normalizedItems.subtotalCents >= freeDeliveryThresholdCents
      ? 0
      : deliveryFeeCents;

  const now = Date.now();
  const dateKey = localDateKey(now);
  const pickup = nextPickup(dateKey);
  const order = {
    id: randomId('ord_'),
    token: crypto.randomBytes(24).toString('hex'),
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
    saveJson(ORDERS_FILE, orders);
    if (userCoupon) saveJson(USER_COUPONS_FILE, userCoupons);
  } catch (err) {
    const index = orders.indexOf(order);
    if (index >= 0) orders.splice(index, 1);

    if (userCoupon && previousCoupon) {
      userCoupon.status = previousCoupon.status;
      userCoupon.usedAt = previousCoupon.usedAt;
      userCoupon.orderId = previousCoupon.orderId;
    }

    try {
      saveJson(ORDERS_FILE, orders);
      if (userCoupon) saveJson(USER_COUPONS_FILE, userCoupons);
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

  return {
    order,
    token: order.token,
  };
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

  if (
    !userCoupon ||
    userCoupon.status !== 'used' ||
    userCoupon.orderId !== order.id
  ) {
    return null;
  }

  return userCoupon;
}

// ==================== 点餐页推荐 ====================

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
          order.accountId === user.id &&
          order.status !== STATUS.CANCELLED
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
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y +
    0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) +
    20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(y * Math.PI) +
    40 * Math.sin(y / 3 * Math.PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * Math.PI) +
    320 * Math.sin(y * Math.PI / 30)) * 2 / 3;
  return ret;
}

function transformLng(x, y) {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y +
    0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * Math.PI) +
    20 * Math.sin(2 * x * Math.PI)) * 2 / 3;
  ret += (20 * Math.sin(x * Math.PI) +
    40 * Math.sin(x / 3 * Math.PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * Math.PI) +
    300 * Math.sin(x / 30 * Math.PI)) * 2 / 3;
  return ret;
}

function wgs84ToGcj02(lng, lat) {
  if (outOfChina(lng, lat)) return { lng, lat };

  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);

  const radLat = lat / 180 * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - GCJ_EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);

  dLat = (dLat * 180) /
    ((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic) * Math.PI);
  dLng = (dLng * 180) /
    (GCJ_A / sqrtMagic * Math.cos(radLat) * Math.PI);

  return { lat: lat + dLat, lng: lng + dLng };
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

  return {
    address: formatted.slice(0, 200),
    provider: 'amap',
  };
}

async function nominatimReverse(lat, lng) {
  const url =
    'https://nominatim.openstreetmap.org/reverse?format=jsonv2' +
    '&lat=' + encodeURIComponent(lat) +
    '&lon=' + encodeURIComponent(lng) +
    '&zoom=18&addressdetails=1&accept-language=zh-CN';

  const data = await fetchJson(url, {
    headers: {
      'User-Agent':
        'gagaxiang-h5-order/1.0 (' + (config.shopPhone || 'shop') + ')',
      'Accept-Language': 'zh-CN',
    },
  });

  const address = nominatimAddress(data);
  if (!address) throw new Error('没有解析出地址');

  return {
    address: address.slice(0, 200),
    provider: 'openstreetmap',
  };
}

// ==================== Express ====================

const app = express();
app.disable('x-powered-by');

if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}

app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(
  express.static(PUBLIC_DIR, {
    index: false,
    etag: true,
    maxAge: 0,
  })
);

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// ---------- 顾客登录 / 资料 ----------

app.get('/api/auth/config', (req, res) => {
  res.json({
    deliveryFeeCents,
    freeDeliveryThresholdCents,
    amapConfigured: !!config.amapKey,
  });
});

// 统一登录入口：
// - 公众号授权已激活且在微信内：返回微信授权地址；
// - 其他任何情况（未配置、配置不完整、普通浏览器）：直接创建本机账号。
// 前端不需要知道配置状态，也不会收到“微信配置未完成”之类的提示。
app.post('/api/auth/login', (req, res) => {
  checkAuthRate(req.ip || 'unknown');

  // 顾客端已改为静默进入，不再展示微信登录页；localOnly 确保即使
  // 将来配置了公众号，自动进入也不会跳转微信授权。
  const localOnly = !!(req.body && req.body.localOnly === true);
  const authorizeUrl = !localOnly && wechatAuth.canStart(req)
    ? wechatAuth.createAuthorizeUrl(req)
    : '';

  if (authorizeUrl) {
    return res.json({
      mode: 'wechat',
      redirectUrl: authorizeUrl,
    });
  }

  const user = createUser();
  users.push(user);
  const token = issueUserToken(user);

  res.status(201).json({
    mode: 'local',
    token,
    user: publicUser(user),
  });
});

app.get('/api/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.post('/api/auth/profile', requireUser, (req, res) => {
  const user = req.user;
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

  res.json({ user: publicUser(user) });
});

// ---------- 微信公众号授权路由（可选，模块隔离） ----------

app.use(
  '/api/auth',
  createWechatAuthRouter({
    wechatAuth,
    findUserByOpenid: (openid) =>
      users.find((item) => item.openid === openid) || null,
    createUser,
    addUser: (user) => users.push(user),
    saveUsers,
    userById,
    issueUserToken,
    publicUser,
  })
);

// ---------- 菜单 / 定位 ----------

app.get('/api/menu', (req, res) => {
  res.json({
    store: {
      storeName: config.storeName,
      shopPhone: config.shopPhone,
      hours: config.hours,
      notice: config.notice,
      deliveryFeeCents,
      freeDeliveryThresholdCents,
    },
    menu: customerMenu(),
    categories: ['全部'].concat(categoriesOfMenu()),
    recommendations: buildRecommendations(getOptionalUser(req)),
    serverTime: Date.now(),
  });
});

app.get(
  '/api/geocode',
  requireUser,
  asyncHandler(async (req, res) => {
    checkGeocodeRate(req.user.id);

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

    res.json({
      address: result.address,
      provider: result.provider,
      lat,
      lng,
    });
  })
);

// ---------- 顾客优惠券 ----------

app.get('/api/coupons', requireUser, requireProfile, (req, res) => {
  res.json({
    coupons: availableCoupons(req.user),
    orderCount: accountOrderCount(req.user.id),
  });
});

// ---------- 顾客订单 ----------

app.post('/api/order', requireUser, requireProfile, (req, res) => {
  const created = createOrder(req.body || {}, req.user, req.ip);
  const view = customerOrderView(created.order);

  res.status(201).json(
    Object.assign({}, view, {
      token: created.token,
    })
  );
});

app.get('/api/my-orders', requireUser, requireProfile, (req, res) => {
  const list = orders
    .filter((order) => order.accountId === req.user.id)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((order) =>
      Object.assign(customerOrderView(order), { token: order.token })
    );

  res.json({ orders: list });
});

app.get('/api/order/:id', (req, res) => {
  const order = orders.find((item) => item.id === req.params.id);
  const token = String(req.query.token || '');
  const user = getOptionalUser(req);

  const byToken = order && safeEqual(order.token, token);
  const byAccount = order && user && order.accountId === user.id;

  if (!order || (!byToken && !byAccount)) {
    throw new HttpError(404, '订单不存在');
  }

  res.json({ order: customerOrderView(order) });
});

// ---------- 商家登录 ----------

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';

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

  res.json({
    token,
    expiresAt: sessions.get(token),
  });
});

app.post('/api/admin/logout', (req, res) => {
  sessions.delete(getAdminToken(req));
  res.json({ success: true });
});

// ---------- 商家订单 ----------

app.get('/api/admin/orders', requireAdmin, (req, res) => {
  const list = orders
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(adminOrderView);

  res.json({ orders: list, serverTime: Date.now() });
});

app.post(
  '/api/admin/orders/:id/status',
  requireAdmin,
  (req, res) => {
    const order = orders.find((item) => item.id === req.params.id);

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
      saveJson(ORDERS_FILE, orders);
      if (userCoupon) saveJson(USER_COUPONS_FILE, userCoupons);
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

    res.json({ order: adminOrderView(order) });
  }
);

// ---------- 商家菜品 ----------

app.get('/api/admin/menu', requireAdmin, (req, res) => {
  res.json({
    menu: menu
      .slice()
      .sort((a, b) => a.sort - b.sort || a.createdAt - b.createdAt)
      .map(adminDish),
    categories: categoriesOfMenu(),
  });
});

app.post('/api/admin/menu', requireAdmin, (req, res) => {
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
    existing.unit = String(body.unit || existing.unit || '份')
      .trim()
      .slice(0, 10);
    existing.desc = String(body.desc || '').trim().slice(0, 80);
    existing.emoji = String(body.emoji || existing.emoji || '🍢')
      .trim()
      .slice(0, 8);
    existing.tag = String(body.tag || '').trim().slice(0, 10);
    existing.soldOut =
      body.soldOut != null ? !!body.soldOut : existing.soldOut;
    existing.enabled =
      body.enabled != null ? !!body.enabled : existing.enabled;
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

  saveJson(MENU_FILE, menu);
  rebuildMenuIndex();

  const saved = existing || menu[menu.length - 1];
  res.json({ dish: adminDish(saved) });
});

app.post(
  '/api/admin/menu/:id/status',
  requireAdmin,
  (req, res) => {
    const dish = menuById.get(req.params.id);
    if (!dish) throw new HttpError(404, '菜品不存在');

    const body = req.body || {};

    if (typeof body.soldOut === 'boolean') dish.soldOut = body.soldOut;
    if (typeof body.enabled === 'boolean') dish.enabled = body.enabled;
    dish.updatedAt = Date.now();

    saveJson(MENU_FILE, menu);
    res.json({ dish: adminDish(dish) });
  }
);

// ---------- 商家优惠券 ----------

app.get('/api/admin/coupons', requireAdmin, (req, res) => {
  const issued = userCoupons
    .slice()
    .sort((a, b) => b.issuedAt - a.issuedAt)
    .slice(0, 200)
    .map((coupon) => {
      const user = coupon.accountId ? userById(coupon.accountId) : null;
      return Object.assign({}, coupon, {
        accountNickname:
          coupon.accountNickname || (user ? user.nickname : ''),
        phone: coupon.phone || (user ? user.phone : ''),
        legacyDeviceId: !coupon.accountId && coupon.deviceId
          ? coupon.deviceId
          : '',
      });
    });

  res.json({
    templates: couponTemplates
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt),
    issued,
    customers: knownCustomers(),
  });
});

app.post('/api/admin/coupons', requireAdmin, (req, res) => {
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
      body.onlyFirstOrder != null
        ? !!body.onlyFirstOrder
        : existing.onlyFirstOrder;
    existing.enabled =
      body.enabled != null ? !!body.enabled : existing.enabled;
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

  saveJson(COUPONS_FILE, couponTemplates);

  res.json({
    template: existing || couponTemplates[couponTemplates.length - 1],
  });
});

app.post('/api/admin/coupons/issue', requireAdmin, (req, res) => {
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

  if (issued > 0) saveJson(USER_COUPONS_FILE, userCoupons);

  res.json({
    issued,
    total: targets.length,
    phone,
    nickname: targets[0].nickname,
    message:
      issued > 0
        ? '已发放给 ' + targets[0].nickname
        : '该顾客已经有一张未使用的同款优惠券',
  });
});

// ---------- 404 / 错误处理 ----------

app.use('/api', (req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((req, res) => {
  res.status(404).send('页面不存在');
});

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);

  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: '请求格式不正确' });
  }

  const status = err.status || 500;

  if (status >= 500) {
    console.error('[服务器错误]', err);
  }

  res.status(status).json({
    error: err.message || '服务器内部错误',
  });
});

// ==================== 启动 ====================

function localIPv4List() {
  const result = [];
  const interfaces = os.networkInterfaces();

  Object.keys(interfaces).forEach((name) => {
    (interfaces[name] || []).forEach((info) => {
      if (info.family === 'IPv4' && !info.internal) {
        result.push(info.address);
      }
    });
  });

  return result;
}

const PORT = parseInt(process.env.PORT, 10) || config.port;
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('========================================');
  console.log('  嘎嘎香 H5 外卖点单系统已启动');
  console.log('  顾客端: http://localhost:' + PORT);
  console.log('  商家端: http://localhost:' + PORT + '/admin');
  console.log('  商家口令: 见 config.json（不会发到前端）');
  console.log('  配送费: ' + (deliveryFeeCents / 100).toFixed(2) + ' 元，满 ' +
    (freeDeliveryThresholdCents / 100).toFixed(0) + ' 元免配送费');
  console.log('  地址定位: ' + (config.amapKey ? '高德地图' : '免 Key 备用服务'));

  if (wechatAuth.enabled) {
    console.log('  微信登录: 已启用');
  }

  if (!config.amapKey) {
    console.warn(
      '[配置] 未配置 amapKey，自动定位在中国大陆可能无法解析地址；' +
        '请在 config.json 填写高德 Web 服务 Key'
    );
  }

  localIPv4List().forEach((ip) => {
    console.log('  手机访问: http://' + ip + ':' + config.port);
  });
  console.log('========================================');
  console.log('');
});

// 定时清理过期登录会话 / 临时凭证 / 限流记录
setInterval(() => {
  const now = Date.now();

  sessions.forEach((expiresAt, token) => {
    if (expiresAt < now) sessions.delete(token);
  });

  wechatAuth.cleanup(now);

  authAttempts.forEach((history, key) => {
    const recent = history.filter((time) => now - time < AUTH_RATE_WINDOW_MS);
    if (recent.length === 0) authAttempts.delete(key);
    else authAttempts.set(key, recent);
  });

  geocodeAttempts.forEach((history, key) => {
    const recent = history.filter(
      (time) => now - time < GEOCODE_RATE_WINDOW_MS
    );
    if (recent.length === 0) geocodeAttempts.delete(key);
    else geocodeAttempts.set(key, recent);
  });
}, 10 * 60 * 1000).unref();

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
