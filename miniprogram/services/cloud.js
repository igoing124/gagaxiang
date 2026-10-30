// services/cloud.js —— 订单 / 收货地址的数据服务
// 有云环境时走云数据库；没有配置云环境或云函数不可用时，自动使用本地存储。
// 页面只调用这里的方法，不再直接判断云开发或直接读写 orders。
const { getStoredOrders } = require('../utils/order.js');
const localGoods = require('../data/goods.js');

const ADDRESS_KEY = 'deliveryAddress';
const LOCAL_COUPONS_KEY = 'userCoupons';
const LOCAL_NEW_USER_COUPON_ID = 'new_user_50_5';

// 本地模式下的默认新人券（云开发模式下由 coupons 集合里的模板决定）
const LOCAL_NEW_USER_COUPON = {
  couponId: LOCAL_NEW_USER_COUPON_ID,
  name: '新人首单券',
  threshold: 50,
  discount: 5,
  onlyFirstOrder: true,
};

// 云开发是否可用：app.js 的 onLaunch 会创建 cloudReady 这个 Promise
async function isCloudEnabled() {
  const app = getApp();

  if (!app || !app.globalData || !app.globalData.cloudReady) {
    return false;
  }

  try {
    return await app.globalData.cloudReady;
  } catch (e) {
    return false;
  }
}

// 只判断「云环境是否可用」，不等 login 云函数。
// 菜单是只读的，用这个门闸就能和登录并行，首屏不用排队。
async function isCloudInited() {
  const app = getApp();

  if (!app || !app.globalData || !app.globalData.cloudInited) {
    return false;
  }

  try {
    return await app.globalData.cloudInited;
  } catch (e) {
    return false;
  }
}

// 统一调用名为 api 的云函数
function callFunction(action, data = {}) {
  return wx.cloud
    .callFunction({
      name: 'api',
      data: { action, ...data },
    })
    .then((res) => {
      const result = (res && res.result) || {};

      if (result.error) {
        throw new Error(result.error);
      }

      return result;
    });
}

// 读取订单列表（云端或本地）
async function listOrders() {
  const cloud = await isCloudEnabled();

  if (!cloud) {
    return getStoredOrders();
  }

  const result = await callFunction('listOrders');
  return Array.isArray(result.orders) ? result.orders : [];
}

// 新建订单
async function createOrder(order) {
  const cloud = await isCloudEnabled();

  if (!cloud) {
    const app = getApp();
    const requireCloud =
      !app ||
      !app.globalData ||
      app.globalData.requireCloudForOrders !== false;

    // 正式使用时不允许把订单只存本机，否则商家永远收不到
    if (requireCloud) {
      throw new Error('线上下单暂不可用，请电话联系商家');
    }

    const stored = wx.getStorageSync('orders');
    const orders = Array.isArray(stored) ? stored : [];
    orders.unshift(order);
    wx.setStorageSync('orders', orders);
    markLocalCouponUsed(order);
    return { ok: true, id: order.id };
  }

  const result = await callFunction('createOrder', { order });
  return result;
}

// 删除单笔订单
async function deleteOrder(id) {
  const cloud = await isCloudEnabled();

  if (!cloud) {
    const next = getStoredOrders().filter((order) => order.id !== id);
    wx.setStorageSync('orders', next);
    return;
  }

  await callFunction('deleteOrder', { id });
}

// 清空全部订单
async function clearOrders() {
  const cloud = await isCloudEnabled();

  if (!cloud) {
    wx.setStorageSync('orders', []);
    return;
  }

  await callFunction('clearOrders');
}

// 先拿本地缓存，页面上可以立即回显
function getCachedAddress() {
  return wx.getStorageSync(ADDRESS_KEY) || null;
}

// 读取收货地址：优先云端，失败就用本地缓存
async function getAddress() {
  const local = getCachedAddress();
  const cloud = await isCloudEnabled();

  if (!cloud) {
    return local;
  }

  try {
    const result = await callFunction('getAddress');

    if (result.address) {
      const address = {
        name: result.address.name || '',
        phone: result.address.phone || '',
        address: result.address.address || '',
      };

      wx.setStorageSync(ADDRESS_KEY, address);
      return address;
    }
  } catch (e) {
    console.warn('读取云端地址失败，使用本地缓存', e);
  }

  return local;
}

// 保存收货地址：本地永远缓存一份，云端可用时再同步
async function saveAddress(address) {
  wx.setStorageSync(ADDRESS_KEY, address);

  const cloud = await isCloudEnabled();
  if (!cloud) return;

  try {
    await callFunction('saveAddress', { address });
  } catch (e) {
    console.warn('保存云端地址失败', e);
  }
}

// ==================== 优惠券 ====================

function getLocalCoupons() {
  const stored = wx.getStorageSync(LOCAL_COUPONS_KEY);
  return Array.isArray(stored) ? stored : [];
}

// 本地模式：没有下过单的用户自动获得一张新人券
function ensureLocalCoupons() {
  let coupons = getLocalCoupons();
  const orders = getStoredOrders();

  const hasNewUserCoupon = coupons.some(
    (c) => c.couponId === LOCAL_NEW_USER_COUPON_ID
  );

  if (orders.length === 0 && !hasNewUserCoupon) {
    coupons = coupons.concat({
      id: 'local_' + LOCAL_NEW_USER_COUPON_ID,
      ...LOCAL_NEW_USER_COUPON,
      status: 'unused',
      source: 'auto',
      issuedAt: Date.now(),
      usedAt: 0,
      orderId: '',
    });

    wx.setStorageSync(LOCAL_COUPONS_KEY, coupons);
  }

  return coupons;
}

// 标记本地优惠券已使用
function markLocalCouponUsed(order) {
  if (!order || !order.userCouponId) return;

  const coupons = getLocalCoupons().map((c) => {
    if (c.id !== order.userCouponId) return c;

    return {
      ...c,
      status: 'used',
      usedAt: Date.now(),
      orderId: order.id,
    };
  });

  wx.setStorageSync(LOCAL_COUPONS_KEY, coupons);
}

// 我的可用优惠券
async function listCoupons() {
  const cloud = await isCloudEnabled();

  if (!cloud) {
    const coupons = ensureLocalCoupons();
    const orders = getStoredOrders();

    return coupons
      .filter((c) => c.status === 'unused')
      .map((c) => ({
        ...c,
        blockedByFirstOrder: !!c.onlyFirstOrder && orders.length > 0,
      }));
  }

  const result = await callFunction('myCoupons');
  return Array.isArray(result.coupons) ? result.coupons : [];
}

// ==================== 菜品 ====================

// 菜单缓存：首页、详情、结算页都会用到，避免重复请求
let dishesCache = null;
let dishesCacheAt = 0;
const DISHES_CACHE_MS = 5 * 60 * 1000;
// 本机菜单缓存：小程序被关掉再打开时，首屏可以直接用上次的菜单，不用等网络
const DISHES_STORAGE_KEY = 'dishesCacheV1';
const DISHES_STORAGE_MS = 24 * 60 * 60 * 1000;

function normalizeLocalDish(dish) {
  return {
    ...dish,
    soldOut: !!dish.soldOut,
    enabled: dish.enabled !== false,
  };
}

// persist 只在「确实拿到了云端菜单」时传 true，
// 本地兜底菜单不写进缓存，避免把兜底菜单当成商家真实菜单缓存一天。
function cacheDishes(dishes, persist) {
  dishesCache = dishes;
  dishesCacheAt = Date.now();

  if (persist) {
    try {
      wx.setStorageSync(DISHES_STORAGE_KEY, {
        list: dishes,
        at: Date.now(),
      });
    } catch (e) {
      // 存不下就算了，不影响本次使用
    }
  }

  return dishes;
}

// 首屏马上能渲染的菜单：优先上次云端菜单，其次本地内置菜单
function getInstantDishes() {
  try {
    const cached = wx.getStorageSync(DISHES_STORAGE_KEY);

    if (
      cached &&
      Array.isArray(cached.list) &&
      cached.list.length > 0 &&
      Date.now() - (Number(cached.at) || 0) < DISHES_STORAGE_MS
    ) {
      return cached.list;
    }
  } catch (e) {
    // 读缓存失败就用本地菜单
  }

  return localGoods.map(normalizeLocalDish);
}

// 商家改了菜单后，让本机缓存立即失效
function invalidateDishesCache() {
  dishesCache = null;
  dishesCacheAt = 0;

  try {
    wx.removeStorageSync(DISHES_STORAGE_KEY);
  } catch (e) {
    // 忽略
  }
}

// 读取菜单：云端有菜单就用云端，没有配置云开发或云端还没导入时用本地 goods.js
// 注意用的是 isCloudInited（不等 login），首页首屏可以和登录并行，不用排队。
async function listDishes() {
  if (dishesCache && Date.now() - dishesCacheAt < DISHES_CACHE_MS) {
    return dishesCache;
  }

  const cloud = await isCloudInited();

  if (!cloud) {
    return cacheDishes(localGoods.map(normalizeLocalDish));
  }

  try {
    const result = await callFunction('listDishes');
    const total = Number(result.total) || 0;

    // 云端还没导入菜单，先用本地菜单兜底，商家可以在菜品管理页导入
    if (total === 0) {
      return cacheDishes(localGoods.map(normalizeLocalDish));
    }

    return cacheDishes(
      Array.isArray(result.dishes) ? result.dishes : [],
      true
    );
  } catch (e) {
    console.warn('云端菜单加载失败，使用本地菜单', e);
    // 失败时不写缓存，下次进入页面会重试；
    // 有上次的云端菜单就继续用它，别把商家改过的价格换成内置菜单
    return getInstantDishes();
  }
}

// 商家：读取全部菜品，包括已下架
async function adminListDishes() {
  await requireCloud();
  const result = await callFunction('adminListDishes');
  return Array.isArray(result.dishes) ? result.dishes : [];
}

// 商家：新增或编辑菜品
async function saveDish(dish) {
  await requireCloud();
  const result = await callFunction('adminSaveDish', { dish });
  invalidateDishesCache();
  return result;
}

// 商家：切换售罄 / 上架状态
async function toggleDish(id, field, value) {
  await requireCloud();
  const result = await callFunction('adminToggleDish', { id, field, value });
  invalidateDishesCache();
  return result;
}

// 商家：第一次把本地菜单导入云数据库
async function seedDishes(dishes) {
  await requireCloud();
  const result = await callFunction('adminSeedDishes', { dishes });
  invalidateDishesCache();
  return result;
}

// ==================== 商家管理 ====================

async function requireCloud() {
  const cloud = await isCloudEnabled();
  if (!cloud) throw new Error('云开发未配置');
}

// 当前用户是不是商家；同时返回 openid，方便首次配置管理员
async function checkAdmin() {
  const cloud = await isCloudEnabled();

  if (!cloud) {
    return {
      isAdmin: false,
      openid: '',
      cloudEnabled: false,
      hasAdmin: false,
    };
  }

  const result = await callFunction('isAdmin');
  return {
    isAdmin: !!result.isAdmin,
    openid: result.openid || '',
    cloudEnabled: true,
    hasAdmin: !!result.hasAdmin,
  };
}

async function listCouponTemplates() {
  await requireCloud();
  const result = await callFunction('adminListCoupons');
  return Array.isArray(result.coupons) ? result.coupons : [];
}

async function saveCouponTemplate(coupon) {
  await requireCloud();
  return callFunction('adminSaveCoupon', { coupon });
}

async function issueCoupon(couponId, openid) {
  await requireCloud();
  return callFunction('adminIssueCoupon', {
    couponId,
    openid: openid || '',
  });
}

async function listUsers() {
  await requireCloud();
  const result = await callFunction('adminListUsers');
  return Array.isArray(result.users) ? result.users : [];
}

// 商家：读取所有用户的订单
async function listAllOrders() {
  await requireCloud();
  const result = await callFunction('adminListOrders');
  return Array.isArray(result.orders) ? result.orders : [];
}

// 商家：修改订单状态（接单 / 配送 / 完成 / 取消）
async function updateOrderStatus(dbId, status) {
  await requireCloud();
  return callFunction('adminUpdateOrderStatus', { dbId, status });
}

// 把昵称同步到云端的 users 集合，方便商家发券时认人
async function saveUserProfile(nickName) {
  const cloud = await isCloudEnabled();
  if (!cloud) return;

  try {
    await callFunction('saveUserProfile', { nickName });
  } catch (e) {
    console.warn('保存云端昵称失败', e);
  }
}

module.exports = {
  isCloudEnabled,
  isCloudInited,
  getInstantDishes,
  listOrders,
  createOrder,
  deleteOrder,
  clearOrders,
  getCachedAddress,
  getAddress,
  saveAddress,
  listDishes,
  adminListDishes,
  saveDish,
  toggleDish,
  seedDishes,
  listCoupons,
  checkAdmin,
  listCouponTemplates,
  saveCouponTemplate,
  issueCoupon,
  listUsers,
  listAllOrders,
  updateOrderStatus,
  saveUserProfile,
};
