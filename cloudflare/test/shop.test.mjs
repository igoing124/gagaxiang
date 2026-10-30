import assert from 'node:assert/strict';
import { createShop, readConfig } from '../src/app.js';
import { MemoryStore } from '../src/store.js';

const ADMIN_PASSWORD = 'test-pass-delivery';
const ADDRESS = '四川省乐山市市中区张公桥好吃街 88 号 3 栋 2 单元 501';
const TEST_DISH_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6hF0AAAAASUVORK5CYII=';

const config = readConfig({
  ADMIN_PASSWORD,
  STORE_NAME: '嘎嘎香 乐山油炸串串',
  SHOP_PHONE: '15528775725',
  DELIVERY_FEE_CENTS: '300',
  FREE_DELIVERY_THRESHOLD_CENTS: '5000',
  AMAP_KEY: '',
});

function newShop(store) {
  return createShop({ store: store || new MemoryStore(), config });
}

async function call(shop, method, path, options = {}) {
  const headers = {};

  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.userToken) headers['x-user-token'] = options.userToken;
  if (options.adminToken) headers['x-admin-token'] = options.adminToken;
  if (options.ip) headers['cf-connecting-ip'] = options.ip;

  const response = await shop.handle(
    new Request('https://shop.test' + path, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  );

  const text = await response.text();
  let data = text;

  try {
    data = JSON.parse(text);
  } catch (err) {
    // 保留纯文本
  }

  return { status: response.status, data, headers: response.headers };
}

async function login(shop, phone) {
  const loginRes = await call(shop, 'POST', '/api/auth/login', {
    body: { localOnly: true },
  });
  assert.equal(loginRes.status, 201);
  assert.equal(loginRes.data.mode, 'local');
  assert.ok(loginRes.data.token);

  const profileRes = await call(shop, 'POST', '/api/auth/profile', {
    userToken: loginRes.data.token,
    body: { nickname: '顾客' + phone.slice(-4), avatar: '😋', phone },
  });
  assert.equal(profileRes.status, 200);
  assert.equal(profileRes.data.user.profileComplete, true);

  return { token: loginRes.data.token, user: profileRes.data.user };
}

let passed = 0;

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

console.log('Cloudflare 版本地测试');

await test('existing Base64 menu images are migrated', async () => {
  const store = new MemoryStore({
    'menu.json': [
      {
        id: 'legacy-image',
        emoji: 'x',
        name: 'Legacy',
        category: 'Test',
        priceCents: 100,
        imageUrl: TEST_DISH_IMAGE,
        enabled: true,
        sort: 0,
      },
    ],
  });
  const shop = newShop(store);
  const menu = await call(shop, 'GET', '/api/menu');
  const dish = menu.data.menu.find((item) => item.id === 'legacy-image');

  assert.match(dish.imageUrl, /^\/api\/menu\/image\/legacy-image\/\d+$/);
  assert.ok(!JSON.stringify(menu.data.menu).includes('data:image/'));

  const image = await call(shop, 'GET', dish.imageUrl);
  assert.equal(image.status, 200);

  const admin = await call(shop, 'POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });
  const backup = await call(shop, 'GET', '/api/admin/export', {
    adminToken: admin.data.token,
  });
  assert.equal(backup.data.dishImages.length, 1);
  assert.equal(backup.data.dishImages[0].name, 'dish-image:legacy-image');
});

await test('菜单、分类和门店配置', async () => {
  const shop = newShop();
  const res = await call(shop, 'GET', '/api/menu');

  assert.equal(res.status, 200);
  assert.equal(res.data.menu.length, 47);
  assert.equal(res.data.menu[0].name, '莴笋');
  assert.equal(res.data.menu[0].priceCents, 70);
  assert.ok(res.data.categories.includes('全部'));
  assert.equal(res.data.store.deliveryFeeCents, 300);
  assert.equal(res.data.store.freeDeliveryThresholdCents, 5000);
  assert.deepEqual(res.data.recommendations, { recent: [], popular: [] });
});

await test('顾客登录、资料锁定和手机号唯一', async () => {
  const shop = newShop();
  const { token, user } = await login(shop, '13800000001');

  assert.equal(user.nickname, '顾客0001');

  const again = await call(shop, 'POST', '/api/auth/profile', {
    userToken: token,
    body: { nickname: '新昵称', avatar: '😋', phone: '13800000002' },
  });
  assert.equal(again.status, 409);

  const other = await call(shop, 'POST', '/api/auth/login', { body: {} });
  const conflict = await call(shop, 'POST', '/api/auth/profile', {
    userToken: other.data.token,
    body: { nickname: '别人', avatar: '😋', phone: '13800000001' },
  });
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /手机号/);

  const me = await call(shop, 'GET', '/api/me', { userToken: token });
  assert.equal(me.data.user.phone, '13800000001');
});

await test('新人券自动发放', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000003');

  const res = await call(shop, 'GET', '/api/coupons', { userToken: token });
  assert.equal(res.status, 200);
  assert.equal(res.data.coupons.length, 1);
  assert.equal(res.data.coupons[0].name, '新人首单券');
  assert.equal(res.data.coupons[0].thresholdCents, 5000);
  assert.equal(res.data.coupons[0].discountCents, 500);
  assert.equal(res.data.orderCount, 0);

  const shop2 = newShop(new MemoryStore());
  const result = await res;
  assert.ok(result);
});

await test('不满 50 收 3 元配送费，金额由服务端计算', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000004');

  const res = await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: {
      items: [{ id: 'wo_sun', count: 2 }],
      recipientName: '张三',
      phone: '13800000004',
      address: ADDRESS,
      // 客户端伪造价格和总额，必须被忽略
      priceCents: 1,
      totalCents: 1,
    },
  });

  assert.equal(res.status, 201);
  assert.equal(res.data.subtotalCents, 140);
  assert.equal(res.data.deliveryFeeCents, 300);
  assert.equal(res.data.discountCents, 0);
  assert.equal(res.data.totalCents, 440);
  assert.equal(res.data.status, 'pending');
  assert.match(res.data.pickupNo, /^A\d{3}$/);
  assert.ok(res.data.token);
});

await test('满 50 免配送费，新人券满 50 减 5', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000005');

  const coupons = await call(shop, 'GET', '/api/coupons', { userToken: token });
  const couponId = coupons.data.coupons[0].id;

  // 取最贵的菜，数量凑够 50 元门槛
  const menu = await call(shop, 'GET', '/api/menu');
  const expensive = menu.data.menu
    .slice()
    .sort((a, b) => b.priceCents - a.priceCents)[0];
  const count = Math.min(99, Math.ceil(5000 / expensive.priceCents));
  const items = [{ id: expensive.id, count }];
  const expectedSubtotal = expensive.priceCents * count;

  const res = await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: {
      items,
      couponId,
      recipientName: '李四',
      phone: '13800000005',
      address: ADDRESS,
    },
  });

  assert.equal(res.status, 201);
  assert.ok(res.data.subtotalCents >= 5000);
  assert.equal(res.data.subtotalCents, expectedSubtotal);
  assert.equal(res.data.deliveryFeeCents, 0);
  assert.equal(res.data.discountCents, 500);
  assert.equal(res.data.totalCents, expectedSubtotal - 500);
  assert.equal(res.data.coupon.name, '新人首单券');
});

await test('优惠券不能重复使用，只限首单', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000006');

  const menu = await call(shop, 'GET', '/api/menu');
  const dish = menu.data.menu
    .slice()
    .sort((a, b) => b.priceCents - a.priceCents)[0];
  const items = [
    { id: dish.id, count: Math.min(99, Math.ceil(5000 / dish.priceCents)) },
  ];

  const coupons = await call(shop, 'GET', '/api/coupons', { userToken: token });
  const couponId = coupons.data.coupons[0].id;

  const first = await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: { items, couponId, recipientName: '王五', phone: '13800000006', address: ADDRESS },
  });
  assert.equal(first.status, 201);

  const reused = await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: { items, couponId, recipientName: '王五', phone: '13800000006', address: ADDRESS },
  });
  assert.equal(reused.status, 409);
  assert.match(reused.data.error, /已使用/);
});

await test('商家登录、接单、完成和取消退券', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000007');

  const badLogin = await call(shop, 'POST', '/api/admin/login', {
    body: { password: 'wrong' },
  });
  assert.equal(badLogin.status, 401);

  const admin = await call(shop, 'POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });
  assert.equal(admin.status, 200);
  const adminToken = admin.data.token;
  assert.ok(adminToken);

  const coupons = await call(shop, 'GET', '/api/coupons', { userToken: token });
  const couponId = coupons.data.coupons[0].id;

  const menu = await call(shop, 'GET', '/api/menu');
  const top = menu.data.menu
    .slice()
    .sort((a, b) => b.priceCents - a.priceCents)[0];
  const items = [
    { id: top.id, count: Math.min(99, Math.ceil(5000 / top.priceCents)) },
  ];

  const order = await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: { items, couponId, recipientName: '赵六', phone: '13800000007', address: ADDRESS },
  });
  assert.equal(order.status, 201);

  const list = await call(shop, 'GET', '/api/admin/orders', { adminToken });
  assert.equal(list.status, 200);
  assert.equal(list.data.orders.length, 1);
  assert.equal(list.data.orders[0].address, ADDRESS);
  assert.equal(list.data.orders[0].note, '');

  const making = await call(
    shop,
    'POST',
    `/api/admin/orders/${order.data.id}/status`,
    { adminToken, body: { status: 'making' } }
  );
  assert.equal(making.status, 200);
  assert.equal(making.data.order.status, 'making');
  const makingChangedAt = making.data.order.statusChangedAt;
  assert.ok(makingChangedAt >= order.data.statusChangedAt);

  const customerMaking = await call(
    shop,
    'GET',
    `/api/order/${order.data.id}?token=${order.data.token}`
  );
  assert.equal(customerMaking.data.order.status, 'making');
  assert.equal(customerMaking.data.order.statusChangedAt, makingChangedAt);

  const invalid = await call(
    shop,
    'POST',
    `/api/admin/orders/${order.data.id}/status`,
    { adminToken, body: { status: 'pending' } }
  );
  assert.equal(invalid.status, 409);

  const cancelled = await call(
    shop,
    'POST',
    `/api/admin/orders/${order.data.id}/status`,
    { adminToken, body: { status: 'cancelled' } }
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.order.status, 'cancelled');

  const refunded = await call(shop, 'GET', '/api/coupons', { userToken: token });
  assert.equal(refunded.data.coupons.length, 1);

  const noAuth = await call(shop, 'GET', '/api/admin/orders');
  assert.equal(noAuth.status, 401);
});

await test('商家登录状态在 Worker 重启后仍然有效', async () => {
  const store = new MemoryStore();
  const first = newShop(store);
  const admin = await call(first, 'POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });
  assert.equal(admin.status, 200);
  assert.ok(admin.data.token);
  assert.ok(admin.data.expiresAt - Date.now() > 20 * 24 * 60 * 60 * 1000);

  const restarted = newShop(store);
  const list = await call(restarted, 'GET', '/api/admin/orders', {
    adminToken: admin.data.token,
  });
  assert.equal(list.status, 200);

  const logout = await call(restarted, 'POST', '/api/admin/logout', {
    adminToken: admin.data.token,
  });
  assert.equal(logout.status, 200);

  const afterLogout = await call(restarted, 'GET', '/api/admin/orders', {
    adminToken: admin.data.token,
  });
  assert.equal(afterLogout.status, 401);
});

await test('商家改价、售罄和下架', async () => {
  const shop = newShop();
  const admin = await call(shop, 'POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });
  const adminToken = admin.data.token;

  const menu = await call(shop, 'GET', '/api/admin/menu', { adminToken });
  const dish = menu.data.menu.find((item) => item.id === 'wo_sun');
  assert.ok(dish);

  const saved = await call(shop, 'POST', '/api/admin/menu', {
    adminToken,
    body: {
      id: 'wo_sun',
      name: dish.name,
      category: dish.category,
      priceCents: 999,
      unit: dish.unit,
      desc: dish.desc,
      emoji: dish.emoji,
      tag: dish.tag,
      imageUrl: TEST_DISH_IMAGE,
      bundleTiers: [{ quantity: 3, totalPriceCents: 2400 }],
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.dish.priceCents, 999);
  assert.match(saved.data.dish.imageUrl, /^\/api\/menu\/image\/wo_sun\/\d+$/);
  assert.deepEqual(
    saved.data.dish.bundleTiers,
    [{ quantity: 3, totalPriceCents: 2400 }]
  );

  const publicMenu = await call(shop, 'GET', '/api/menu');
  const publicDish = publicMenu.data.menu.find((item) => item.id === 'wo_sun');
  assert.equal(publicDish.imageUrl, saved.data.dish.imageUrl);

  const image = await call(shop, 'GET', saved.data.dish.imageUrl);
  assert.equal(image.status, 200);
  assert.equal(
    image.headers.get('cache-control'),
    'public, max-age=31536000, immutable'
  );
  assert.deepEqual(
    publicMenu.data.menu.find((item) => item.id === 'wo_sun').bundleTiers,
    [{ quantity: 3, totalPriceCents: 2400 }]
  );

  const invalidTier = await call(shop, 'POST', '/api/admin/menu', {
    adminToken,
    body: {
      id: 'wo_sun',
      name: dish.name,
      category: dish.category,
      priceCents: 999,
      unit: dish.unit,
      desc: dish.desc,
      emoji: dish.emoji,
      tag: dish.tag,
      bundleTiers: [{ quantity: 3, totalPriceCents: 2997 }],
    },
  });
  assert.equal(invalidTier.status, 400);

  const tierCustomer = await login(shop, '13800000016');
  const tierOrder = await call(shop, 'POST', '/api/order', {
    userToken: tierCustomer.token,
    body: {
      items: [{ id: 'wo_sun', count: 6 }],
      recipientName: '阶梯价顾客',
      phone: '13800000016',
      address: ADDRESS,
    },
  });
  assert.equal(tierOrder.status, 201);
  assert.equal(tierOrder.data.subtotalCents, 4800);
  assert.equal(tierOrder.data.items[0].priceSummary, '6串 ¥48');

  const soldOut = await call(shop, 'POST', '/api/admin/menu/wo_sun/status', {
    adminToken,
    body: { soldOut: true },
  });
  assert.equal(soldOut.status, 200);
  assert.equal(soldOut.data.dish.soldOut, true);

  const { token } = await login(shop, '13800000008');
  const blocked = await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: {
      items: [{ id: 'wo_sun', count: 1 }],
      recipientName: '钱七',
      phone: '13800000008',
      address: ADDRESS,
    },
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /售罄/);

  const disabled = await call(shop, 'POST', '/api/admin/menu/wo_sun/status', {
    adminToken,
    body: { soldOut: false, enabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.dish.enabled, false);
});

await test('按手机号发券', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000009');

  const admin = await call(shop, 'POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });
  const adminToken = admin.data.token;

  const coupon = await call(shop, 'POST', '/api/admin/coupons', {
    adminToken,
    body: {
      name: '满 30 减 3',
      thresholdCents: 3000,
      discountCents: 300,
      enabled: true,
    },
  });
  assert.equal(coupon.status, 200);

  const issued = await call(shop, 'POST', '/api/admin/coupons/issue', {
    adminToken,
    body: { templateId: coupon.data.template.id, phone: '13800000009' },
  });
  assert.equal(issued.status, 200);
  assert.equal(issued.data.issued, 1);

  const mine = await call(shop, 'GET', '/api/coupons', { userToken: token });
  assert.ok(mine.data.coupons.some((item) => item.templateId === coupon.data.template.id));

  const missing = await call(shop, 'POST', '/api/admin/coupons/issue', {
    adminToken,
    body: { templateId: coupon.data.template.id, phone: '13900000000' },
  });
  assert.equal(missing.status, 404);
});

await test('10 个并发下单不丢单、取餐号不重复', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000010');

  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      call(shop, 'POST', '/api/order', {
        userToken: token,
        ip: '203.0.113.10',
        body: {
          items: [{ id: 'wo_sun', count: 1 }],
          recipientName: '并发顾客',
          phone: '13800000010',
          address: ADDRESS,
        },
      })
    )
  );

  const ids = new Set(results.map((item) => item.data.id));
  const pickupNos = new Set(results.map((item) => item.data.pickupNo));
  assert.equal(ids.size, 10);
  assert.equal(pickupNos.size, 10);
  results.forEach((item) => assert.equal(item.status, 201));
});

await test('重启后数据仍在（持久化）', async () => {
  const store = new MemoryStore();
  const shop = newShop(store);
  const { token } = await login(shop, '13800000011');

  const order = await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: {
      items: [{ id: 'wo_sun', count: 1 }],
      recipientName: '持久化',
      phone: '13800000011',
      address: ADDRESS,
    },
  });
  assert.equal(order.status, 201);

  const restarted = newShop(store);
  const list = await call(restarted, 'GET', '/api/my-orders', { userToken: token });
  assert.equal(list.status, 200);
  assert.equal(list.data.orders.length, 1);
  assert.equal(list.data.orders[0].id, order.data.id);

  const menu = await call(restarted, 'GET', '/api/menu');
  assert.equal(menu.data.menu.length, 47);
});

await test('订单查询需要 token 或本人账号', async () => {
  const shop = newShop();
  const a = await login(shop, '13800000012');
  const b = await login(shop, '13800000013');

  const order = await call(shop, 'POST', '/api/order', {
    userToken: a.token,
    body: {
      items: [{ id: 'wo_sun', count: 1 }],
      recipientName: '甲',
      phone: '13800000012',
      address: ADDRESS,
    },
  });

  const byToken = await call(
    shop,
    'GET',
    `/api/order/${order.data.id}?token=${order.data.token}`
  );
  assert.equal(byToken.status, 200);

  const byOwner = await call(shop, 'GET', `/api/order/${order.data.id}`, {
    userToken: a.token,
  });
  assert.equal(byOwner.status, 200);

  const stranger = await call(shop, 'GET', `/api/order/${order.data.id}`, {
    userToken: b.token,
  });
  assert.equal(stranger.status, 404);
});

await test('推荐：最近点过和销量较高', async () => {
  const shop = newShop();
  const { token } = await login(shop, '13800000014');

  await call(shop, 'POST', '/api/order', {
    userToken: token,
    body: {
      items: [{ id: 'wo_sun', count: 2 }],
      recipientName: '推荐',
      phone: '13800000014',
      address: ADDRESS,
    },
  });

  const menu = await call(shop, 'GET', '/api/menu', { userToken: token });
  assert.deepEqual(menu.data.recommendations.recent, ['wo_sun']);
  // 只有自己点过 wo_sun，热销区不应再推荐同一道菜
  assert.equal(menu.data.recommendations.popular.includes('wo_sun'), false);

  const other = await login(shop, '13800000015');
  await call(shop, 'POST', '/api/order', {
    userToken: other.token,
    body: {
      items: [{ id: 'bao_cai', count: 3 }],
      recipientName: '推荐乙',
      phone: '13800000015',
      address: ADDRESS,
    },
  });

  const after = await call(shop, 'GET', '/api/menu', { userToken: token });
  assert.ok(after.data.recommendations.popular.includes('bao_cai'));
  assert.equal(after.data.recommendations.recent.includes('bao_cai'), false);
});

await test('商家导出备份', async () => {
  const shop = newShop();
  const admin = await call(shop, 'POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });

  const res = await call(shop, 'GET', '/api/admin/export', {
    adminToken: admin.data.token,
  });
  assert.equal(res.status, 200);
  assert.equal(res.data.menu.length, 47);
  assert.ok(Array.isArray(res.data.orders));
  assert.ok(Array.isArray(res.data.users));
  assert.ok(Array.isArray(res.data.couponTemplates));
  assert.ok(Array.isArray(res.data.dishImages));

  const noAuth = await call(shop, 'GET', '/api/admin/export');
  assert.equal(noAuth.status, 401);
});

await test('接口 404 和请求格式错误', async () => {
  const shop = newShop();

  const notFound = await call(shop, 'GET', '/api/not-exist');
  assert.equal(notFound.status, 404);
  assert.equal(notFound.data.error, '接口不存在');

  const badJson = await shop.handle(
    new Request('https://shop.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{bad json',
    })
  );
  assert.equal(badJson.status, 400);
  assert.equal((await badJson.json()).error, '请求格式不正确');

  const page = await call(shop, 'GET', '/some-page');
  assert.equal(page.status, 404);
  assert.equal(page.data, '页面不存在');
});

console.log(`\n全部 ${passed} 组测试通过`);
