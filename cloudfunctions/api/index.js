// cloudfunctions/api/index.js —— 配送小程序的云函数
// 负责：登录拿 openid、订单增删查、收货地址、优惠券模板/用户券/商家发券。
const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
});

const db = cloud.database();
const _ = db.command;

// 默认新人券：第一次下单满 50 减 5
const NEW_USER_COUPON_ID = 'new_user_50_5';

// 配送配置默认值；正式使用前可以在 config/store 文档里改
const DEFAULT_STORE = {
  deliveryFee: 3,
  freeDeliveryThreshold: 50,
};
const COLLECTIONS = [
  'orders',
  'addresses',
  'coupons',
  'userCoupons',
  'users',
  'config',
  'dishes',
];

let defaultsReady = false;

// 建集合；已存在会报错，直接忽略
async function ensureCollections() {
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
    } catch (e) {
      // 集合已存在
    }
  }
}

// 部署过一次之后，config/meta 会留下标记。
// 有标记就只花一次「读一个文档」的时间，不再每次冷启动都试建 7 个集合
// （每次 createCollection 都要跟数据库往返一趟，冷启动时很贵）。
async function isSchemaReady() {
  try {
    const res = await db.collection('config').doc('meta').get();
    return !!(res.data && res.data.schemaReady);
  } catch (e) {
    return false;
  }
}

// 首次部署时准备默认新人券和管理员配置
async function ensureDefaults() {
  if (defaultsReady) return;

  if (await isSchemaReady()) {
    defaultsReady = true;
    return;
  }

  await ensureCollections();

  const couponCount = await db.collection('coupons').count();
  if (couponCount.total === 0) {
    await db.collection('coupons').add({
      data: {
        couponId: NEW_USER_COUPON_ID,
        name: '新人首单券',
        threshold: 50,
        discount: 5,
        autoIssue: 'newUser',
        onlyFirstOrder: true,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    });
  }

  try {
    await db.collection('config').doc('admin').get();
  } catch (e) {
    try {
      await db.collection('config').doc('admin').set({
        data: { openids: [] },
      });
    } catch (e2) {
      // 并发初始化时可能已经被创建
    }
  }

  // 配送费配置：以后改配送费时改这个文档，云函数会以它为准
  try {
    await db.collection('config').doc('store').get();
  } catch (e) {
    try {
      await db.collection('config').doc('store').set({
        data: { ...DEFAULT_STORE },
      });
    } catch (e2) {
      // 并发初始化时可能已经被创建
    }
  }

  // 记下「结构已就绪」，以后冷启动只要读这个文档就够了
  try {
    await db.collection('config').doc('meta').set({
      data: { schemaReady: true, at: Date.now() },
    });
  } catch (e) {
    // 标记写不进也没关系，下次还会走完整的初始化流程
  }

  defaultsReady = true;
}

// 读取配送配置；读不到就用默认值
async function getStoreConfig() {
  try {
    const res = await db.collection('config').doc('store').get();
    const data = res.data || {};

    return {
      deliveryFee:
        Number(data.deliveryFee) >= 0
          ? Number(data.deliveryFee)
          : DEFAULT_STORE.deliveryFee,
      freeDeliveryThreshold:
        Number(data.freeDeliveryThreshold) >= 0
          ? Number(data.freeDeliveryThreshold)
          : DEFAULT_STORE.freeDeliveryThreshold,
    };
  } catch (e) {
    return { ...DEFAULT_STORE };
  }
}

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function getAdminConfig() {
  try {
    const res = await db.collection('config').doc('admin').get();
    return res.data || {};
  } catch (e) {
    return { openids: [] };
  }
}

async function isAdmin(openid) {
  const config = await getAdminConfig();
  return (
    Array.isArray(config.openids) && config.openids.indexOf(openid) !== -1
  );
}

async function getOrderCount(openid) {
  const res = await db
    .collection('orders')
    .where({
      _openid: openid,
      // 已取消的订单不算首单，方便取消后重新使用首单券
      status: _.nin(['cancelled', 'canceled']),
    })
    .count();
  return res.total || 0;
}

// 记录/更新用户，商家发券时可以从 users 集合拿到 openid
async function touchUser(openid) {
  const res = await db
    .collection('users')
    .where({ _openid: openid })
    .limit(1)
    .get();

  if (res.data.length > 0) {
    await db.collection('users').doc(res.data[0]._id).update({
      data: { lastLogin: Date.now() },
    });
  } else {
    await db.collection('users').add({
      data: {
        _openid: openid,
        nickName: '',
        lastLogin: Date.now(),
        createdAt: Date.now(),
      },
    });
  }
}

// 给还没有下过单的用户自动发新人券
async function issueNewUserCoupons(openid) {
  const orderCount = await getOrderCount(openid);
  if (orderCount > 0) return;

  const templates = await db
    .collection('coupons')
    .where({ autoIssue: 'newUser', enabled: true })
    .get();

  for (const tpl of templates.data) {
    const existing = await db
      .collection('userCoupons')
      .where({ _openid: openid, couponId: tpl.couponId })
      .limit(1)
      .get();

    if (existing.data.length > 0) continue;

    await db.collection('userCoupons').add({
      data: {
        _openid: openid,
        couponId: tpl.couponId,
        name: tpl.name,
        threshold: Number(tpl.threshold) || 0,
        discount: Number(tpl.discount) || 0,
        onlyFirstOrder: !!tpl.onlyFirstOrder,
        status: 'unused',
        source: 'auto',
        issuedAt: Date.now(),
        usedAt: 0,
        orderId: '',
      },
    });
  }
}

// 把客户端传来的订单整理成白名单字段。
// 注意：商品、价格、配送费、总额一律由服务端重新计算，不信任客户端传值。
function normalizeOrder(raw, openid) {
  const order = raw || {};

  return {
    id: '',
    items: [],
    cartCount: 0,
    totalPrice: 0,
    discount: 0,
    payablePrice: 0,
    coupon: null,
    userCouponId: '',
    deliveryType: 'delivery',
    receiverName: String(order.receiverName || ''),
    receiverPhone: String(order.receiverPhone || ''),
    address: String(order.address || ''),
    deliveryFee: 0,
    remark: String(order.remark || ''),
    createdAt: Date.now(),
    status: 'pending',
    _openid: openid,
  };
}

function normalizeCoupon(raw, couponId, createdAt) {
  return {
    couponId,
    name: String(raw.name || '').trim(),
    threshold: Number(raw.threshold) || 0,
    discount: Number(raw.discount) || 0,
    autoIssue: raw.autoIssue === 'newUser' ? 'newUser' : 'manual',
    onlyFirstOrder: !!raw.onlyFirstOrder,
    enabled: raw.enabled !== false,
    createdAt: createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

// 菜品字段白名单；编辑时保留旧的 id / createdAt
function normalizeDish(raw, existing) {
  const source = raw || {};
  const old = existing || {};
  const now = Date.now();

  return {
    id: String(
      source.id ||
        old.id ||
        'dish_' + now + '_' + Math.floor(Math.random() * 1000)
    ),
    name: String(
      source.name != null ? source.name : old.name || ''
    ).trim().slice(0, 30),
    emoji:
      String(
        source.emoji != null ? source.emoji : old.emoji || '🍢'
      ).trim().slice(0, 8) || '🍢',
    category: String(
      source.category != null ? source.category : old.category || ''
    ).trim().slice(0, 20),
    desc: String(
      source.desc != null ? source.desc : old.desc || ''
    ).trim().slice(0, 80),
    price: Math.round((Number(source.price != null ? source.price : old.price) || 0) * 100) / 100,
    unit:
      String(
        source.unit != null ? source.unit : old.unit || '份'
      ).trim().slice(0, 10) || '份',
    tag: String(
      source.tag != null ? source.tag : old.tag || ''
    ).trim().slice(0, 10),
    soldOut:
      source.soldOut != null ? !!source.soldOut : !!old.soldOut,
    enabled:
      source.enabled != null ? !!source.enabled : old.enabled !== false,
    sort: Number(
      source.sort != null ? source.sort : old.sort
    ) || 0,
    createdAt: Number(old.createdAt) || now,
    updatedAt: now,
  };
}

// 返回给小程序时去掉数据库的 _id，补齐默认值
function toClientDish(doc) {
  return {
    id: String(doc.id || ''),
    name: String(doc.name || ''),
    emoji: doc.emoji || '🍢',
    category: String(doc.category || ''),
    desc: String(doc.desc || ''),
    price: Number(doc.price) || 0,
    unit: doc.unit || '份',
    tag: String(doc.tag || ''),
    soldOut: !!doc.soldOut,
    enabled: doc.enabled !== false,
    sort: Number(doc.sort) || 0,
    createdAt: Number(doc.createdAt) || 0,
  };
}

function sortDishes(list) {
  return list.sort(
    (a, b) => (a.sort || 0) - (b.sort || 0) || a.createdAt - b.createdAt
  );
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;

  try {
    switch (action) {
      case 'login': {
        await ensureDefaults();
        await touchUser(OPENID);
        await issueNewUserCoupons(OPENID);
        return { openid: OPENID };
      }

      case 'createOrder': {
        await ensureDefaults();

        const raw = event.order || {};
        const data = normalizeOrder(raw, OPENID);

        // 收货信息由服务端再校验一次
        const receiverName = String(raw.receiverName || '').trim().slice(0, 20);
        const receiverPhone = String(raw.receiverPhone || '').trim();
        const address = String(raw.address || '').trim().slice(0, 100);

        if (!receiverName) throw new Error('请填写收货人');
        if (!/^\d{11}$/.test(receiverPhone)) throw new Error('手机号格式不正确');
        if (!address) throw new Error('请填写收货地址');

        data.receiverName = receiverName;
        data.receiverPhone = receiverPhone;
        data.address = address;
        data.remark = String(raw.remark || '').trim().slice(0, 50);

        // 商品数量校验
        const rawItems = Array.isArray(raw.items) ? raw.items : [];
        if (rawItems.length === 0) throw new Error('订单里没有商品');
        if (rawItems.length > 50) throw new Error('商品种类过多');

        const counts = {};
        for (const item of rawItems) {
          const id = String((item && item.id) || '');
          const count = Math.floor(Number(item && item.count) || 0);

          if (!id || count < 1 || count > 99) {
            throw new Error('商品数量不正确');
          }

          counts[id] = (counts[id] || 0) + count;

          if (counts[id] > 99) {
            throw new Error('单个菜品数量过多');
          }
        }

        const ids = Object.keys(counts);

        // 以数据库里的菜名和价格为准，防止客户端改价
        const dishRes = await db
          .collection('dishes')
          .where({ id: _.in(ids) })
          .limit(100)
          .get();

        if (dishRes.data.length === 0) {
          throw new Error('菜单还没有配置，暂时不能下单');
        }

        const dishMap = {};
        dishRes.data.forEach((dish) => {
          if (dish.enabled !== false) dishMap[dish.id] = dish;
        });

        const items = [];
        let totalPrice = 0;
        let cartCount = 0;

        for (const id of ids) {
          const dish = dishMap[id];

          if (!dish) {
            throw new Error('部分菜品已下架，请返回菜单重新选择');
          }

          if (dish.soldOut) {
            throw new Error(`「${dish.name}」已售罄，请返回菜单调整`);
          }

          const count = counts[id];
          const price = round2(dish.price);

          if (!(price > 0)) {
            throw new Error('菜品价格异常');
          }

          totalPrice += price * count;
          cartCount += count;
          items.push({
            id,
            name: String(dish.name || ''),
            price,
            count,
          });
        }

        totalPrice = round2(totalPrice);

        if (!(totalPrice > 0)) {
          throw new Error('订单金额不正确');
        }

        const storeConfig = await getStoreConfig();
        const deliveryFee =
          totalPrice >= storeConfig.freeDeliveryThreshold
            ? 0
            : storeConfig.deliveryFee;

        data.items = items;
        data.cartCount = cartCount;
        data.totalPrice = totalPrice;
        data.deliveryFee = round2(deliveryFee);
        // 订单号由服务端生成，避免同一秒下单产生重复编号
        data.id =
          'YZ' + Date.now() + String(Math.floor(Math.random() * 900) + 100);

        const userCouponId = String(raw.userCouponId || '');

        let coupon = null;
        let discount = 0;

        if (userCouponId) {
          let userCoupon = null;

          try {
            const res = await db.collection('userCoupons').doc(userCouponId).get();
            userCoupon = res.data;
          } catch (e) {
            userCoupon = null;
          }

          if (!userCoupon || userCoupon._openid !== OPENID) {
            throw new Error('优惠券不存在');
          }

          if (userCoupon.status !== 'unused') {
            throw new Error('优惠券已使用');
          }

          if (data.totalPrice < Number(userCoupon.threshold || 0)) {
            throw new Error('未达到优惠券使用门槛');
          }

          if (userCoupon.onlyFirstOrder) {
            const orderCount = await getOrderCount(OPENID);
            if (orderCount > 0) {
              throw new Error('该优惠券仅限首单使用');
            }
          }

          discount = Number(userCoupon.discount) || 0;
          coupon = {
            userCouponId,
            couponId: userCoupon.couponId,
            name: userCoupon.name,
            threshold: Number(userCoupon.threshold) || 0,
            discount,
          };
        }

        data.discount = round2(discount);
        data.payablePrice = round2(
          Math.max(0, data.totalPrice + data.deliveryFee - discount)
        );
        data.coupon = coupon;
        data.userCouponId = coupon ? userCouponId : '';

        const res = await db.collection('orders').add({ data });

        // 订单写入成功后再标记优惠券已使用
        if (coupon) {
          await db.collection('userCoupons').doc(userCouponId).update({
            data: {
              status: 'used',
              usedAt: Date.now(),
              orderId: data.id,
            },
          });
        }

        return { _id: res._id, id: data.id };
      }

      case 'listOrders': {
        const res = await db
          .collection('orders')
          .where({ _openid: OPENID })
          .orderBy('createdAt', 'desc')
          .limit(100)
          .get();

        return { orders: res.data };
      }

      case 'deleteOrder': {
        const id = String(event.id || '');

        const res = await db
          .collection('orders')
          .where({ _openid: OPENID, id })
          .remove();

        return { removed: res.stats.removed };
      }

      case 'clearOrders': {
        const res = await db
          .collection('orders')
          .where({ _openid: OPENID })
          .remove();

        return { removed: res.stats.removed };
      }

      case 'getAddress': {
        const res = await db
          .collection('addresses')
          .where({ _openid: OPENID })
          .limit(1)
          .get();

        return { address: res.data[0] || null };
      }

      case 'saveAddress': {
        const raw = event.address || {};
        const data = {
          name: String(raw.name || ''),
          phone: String(raw.phone || ''),
          address: String(raw.address || ''),
          updatedAt: Date.now(),
        };

        const res = await db
          .collection('addresses')
          .where({ _openid: OPENID })
          .limit(1)
          .get();

        if (res.data.length > 0) {
          await db.collection('addresses').doc(res.data[0]._id).update({ data });
        } else {
          await db.collection('addresses').add({
            data: {
              ...data,
              _openid: OPENID,
              createdAt: Date.now(),
            },
          });
        }

        return { success: true };
      }

      case 'myCoupons': {
        await ensureDefaults();

        const orderCount = await getOrderCount(OPENID);
        const res = await db
          .collection('userCoupons')
          .where({ _openid: OPENID, status: 'unused' })
          .orderBy('issuedAt', 'desc')
          .get();

        const coupons = res.data.map((c) => ({
          id: c._id,
          couponId: c.couponId,
          name: c.name,
          threshold: Number(c.threshold) || 0,
          discount: Number(c.discount) || 0,
          onlyFirstOrder: !!c.onlyFirstOrder,
          blockedByFirstOrder: !!c.onlyFirstOrder && orderCount > 0,
          issuedAt: c.issuedAt || 0,
        }));

        return { coupons };
      }

      case 'isAdmin': {
        await ensureDefaults();

        const config = await getAdminConfig();
        const openids = Array.isArray(config.openids) ? config.openids : [];

        return {
          isAdmin: openids.indexOf(OPENID) !== -1,
          openid: OPENID,
          // 还没配置过任何商家时，入口对登录用户可见，方便第一次配置
          hasAdmin: openids.length > 0,
        };
      }

      case 'saveUserProfile': {
        const nickName = String(event.nickName || '').slice(0, 20);
        if (!nickName) return { success: false };

        const res = await db
          .collection('users')
          .where({ _openid: OPENID })
          .limit(1)
          .get();

        if (res.data.length > 0) {
          await db.collection('users').doc(res.data[0]._id).update({
            data: { nickName, updatedAt: Date.now() },
          });
        } else {
          await db.collection('users').add({
            data: {
              _openid: OPENID,
              nickName,
              lastLogin: Date.now(),
              createdAt: Date.now(),
            },
          });
        }

        return { success: true };
      }

      case 'adminListCoupons': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');

        const res = await db
          .collection('coupons')
          .orderBy('createdAt', 'desc')
          .get();

        return { coupons: res.data };
      }

      case 'adminSaveCoupon': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');

        const raw = event.coupon || {};
        const name = String(raw.name || '').trim();
        const threshold = Number(raw.threshold);
        const discount = Number(raw.discount);

        if (!name) throw new Error('请填写优惠券名称');
        if (!(threshold > 0)) throw new Error('门槛金额必须大于 0');
        if (!(discount > 0)) throw new Error('优惠金额必须大于 0');

        const couponId = String(raw.couponId || 'c_' + Date.now());
        const existing = await db
          .collection('coupons')
          .where({ couponId })
          .limit(1)
          .get();

        if (existing.data.length > 0) {
          const old = existing.data[0];
          await db.collection('coupons').doc(old._id).update({
            data: normalizeCoupon(raw, couponId, old.createdAt),
          });
        } else {
          await db.collection('coupons').add({
            data: normalizeCoupon(raw, couponId, Date.now()),
          });
        }

        return { couponId };
      }

      case 'adminIssueCoupon': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');

        const couponId = String(event.couponId || '');
        const targetOpenid = String(event.openid || '');

        const tplRes = await db
          .collection('coupons')
          .where({ couponId })
          .limit(1)
          .get();
        const tpl = tplRes.data[0];

        if (!tpl) throw new Error('优惠券不存在');
        if (!tpl.enabled) throw new Error('优惠券已停用');

        let targets = [];

        if (targetOpenid) {
          targets = [targetOpenid];
        } else {
          const users = await db.collection('users').limit(1000).get();
          targets = users.data
            .map((u) => u._openid)
            .filter((id) => !!id);
        }

        let issued = 0;

        for (const openid of targets) {
          const existing = await db
            .collection('userCoupons')
            .where({ _openid: openid, couponId, status: 'unused' })
            .limit(1)
            .get();

          if (existing.data.length > 0) continue;

          await db.collection('userCoupons').add({
            data: {
              _openid: openid,
              couponId: tpl.couponId,
              name: tpl.name,
              threshold: Number(tpl.threshold) || 0,
              discount: Number(tpl.discount) || 0,
              onlyFirstOrder: !!tpl.onlyFirstOrder,
              status: 'unused',
              source: 'merchant',
              issuedAt: Date.now(),
              usedAt: 0,
              orderId: '',
            },
          });

          issued += 1;
        }

        return { issued, total: targets.length };
      }

      case 'adminListUsers': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');

        const res = await db
          .collection('users')
          .orderBy('lastLogin', 'desc')
          .limit(100)
          .get();

        const users = res.data.map((u) => ({
          openid: u._openid,
          nickName: u.nickName || '',
          lastLogin: u.lastLogin || 0,
        }));

        return { users };
      }

      // 商家订单列表：所有用户的订单，最新的在前
      case 'adminListOrders': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');

        const res = await db
          .collection('orders')
          .orderBy('createdAt', 'desc')
          .limit(200)
          .get();

        return { orders: res.data };
      }

      // 商家改订单状态：接单、开始配送、完成、取消
      case 'adminUpdateOrderStatus': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');

        const dbId = String(event.dbId || '');
        const nextStatus = String(event.status || '');

        if (!dbId) throw new Error('缺少订单编号');

        const allowedStatuses = [
          'making',
          'delivering',
          'completed',
          'cancelled',
        ];
        if (allowedStatuses.indexOf(nextStatus) === -1) {
          throw new Error('无效的订单状态');
        }

        let order = null;
        try {
          const res = await db.collection('orders').doc(dbId).get();
          order = res.data;
        } catch (e) {
          order = null;
        }

        if (!order) throw new Error('订单不存在');

        // 只允许按顺序往后走，防止误操作或重复点击
        const transitions = {
          pending: ['making', 'cancelled'],
          making: ['delivering', 'cancelled'],
          delivering: ['completed', 'cancelled'],
          completed: [],
          cancelled: [],
          done: [],
          canceled: [],
        };
        const currentStatus = order.status || 'making';
        const allowedNext = transitions[currentStatus] || [];

        if (allowedNext.indexOf(nextStatus) === -1) {
          throw new Error('订单状态不能这样变更');
        }

        await db.collection('orders').doc(dbId).update({
          data: {
            status: nextStatus,
            statusChangedAt: Date.now(),
          },
        });

        // 取消订单时把用掉的优惠券退回
        if (nextStatus === 'cancelled' && order.userCouponId) {
          try {
            await db.collection('userCoupons').doc(order.userCouponId).update({
              data: {
                status: 'unused',
                usedAt: 0,
                orderId: '',
              },
            });
          } catch (e) {
            console.warn('退回优惠券失败', e);
          }
        }

        return { success: true, status: nextStatus };
      }

      // ==================== 菜品 ====================

      // 顾客端菜单：只返回上架菜品
      case 'listDishes': {
        await ensureDefaults();

        const res = await db.collection('dishes').limit(500).get();
        const all = sortDishes(res.data.map(toClientDish));

        return {
          dishes: all.filter((dish) => dish.enabled),
          total: all.length,
        };
      }

      // 商家端菜单：包含已下架菜品
      case 'adminListDishes': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');
        await ensureDefaults();

        const res = await db.collection('dishes').limit(500).get();
        return { dishes: sortDishes(res.data.map(toClientDish)) };
      }

      // 新增或编辑菜品
      case 'adminSaveDish': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');
        await ensureDefaults();

        const raw = event.dish || {};
        const id = String(raw.id || '');
        let existing = null;

        if (id) {
          const res = await db
            .collection('dishes')
            .where({ id })
            .limit(1)
            .get();
          existing = res.data[0] || null;
        }

        const dish = normalizeDish(raw, existing);

        if (!dish.name) throw new Error('请填写菜品名称');
        if (!dish.category) throw new Error('请填写菜品分类');
        if (!(dish.price > 0)) throw new Error('价格必须大于 0');

        if (existing) {
          await db.collection('dishes').doc(existing._id).update({
            data: dish,
          });
        } else {
          // 新菜品排在已有菜品后面
          if (!dish.sort) dish.sort = Date.now();
          await db.collection('dishes').add({ data: dish });
        }

        return { id: dish.id };
      }

      // 一键切换售罄 / 上架状态
      case 'adminToggleDish': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');

        const id = String(event.id || '');
        const field =
          event.field === 'soldOut'
            ? 'soldOut'
            : event.field === 'enabled'
              ? 'enabled'
              : '';

        if (!id) throw new Error('缺少菜品编号');
        if (!field) throw new Error('无效的操作');

        const res = await db
          .collection('dishes')
          .where({ id })
          .limit(1)
          .get();

        if (res.data.length === 0) throw new Error('菜品不存在');

        await db.collection('dishes').doc(res.data[0]._id).update({
          data: {
            [field]: !!event.value,
            updatedAt: Date.now(),
          },
        });

        return { success: true };
      }

      // 把本地 goods.js 的菜单合并进云数据库：
      // 只补云端没有的菜品，不覆盖商家已经改过的菜品
      case 'adminSeedDishes': {
        if (!(await isAdmin(OPENID))) throw new Error('没有商家权限');
        await ensureDefaults();

        const existingRes = await db.collection('dishes').limit(500).get();
        const existing = existingRes.data;
        const existingIds = {};
        existing.forEach((dish) => {
          if (dish.id) existingIds[dish.id] = true;
        });
        let sort = existing.reduce(
          (max, dish) => Math.max(max, Number(dish.sort) || 0),
          -10
        );

        const list = Array.isArray(event.dishes)
          ? event.dishes.slice(0, 200)
          : [];

        if (list.length === 0) throw new Error('没有可导入的菜品');

        const docs = [];

        list.forEach((raw) => {
          const id = raw && raw.id ? String(raw.id) : '';

          // 已经导入过的菜品跳过，避免覆盖商家改过的价格
          if (id && existingIds[id]) return;

          const dish = normalizeDish(raw, null);
          sort += 10;
          dish.sort = sort;

          if (dish.id) existingIds[dish.id] = true;
          docs.push(dish);
        });

        if (docs.length === 0) {
          return { seeded: 0, total: existing.length };
        }

        await Promise.all(
          docs.map((data) => db.collection('dishes').add({ data }))
        );

        return {
          seeded: docs.length,
          total: existing.length + docs.length,
        };
      }

      // 首次部署后可以在云函数控制台用 {"action":"init"} 测试一次
      case 'init': {
        await ensureDefaults();
        return { success: true };
      }

      default:
        return { error: 'unknown action: ' + action };
    }
  } catch (err) {
    console.error('api error:', action, err);
    return { error: err.message || 'cloud function error' };
  }
};
