'use strict';

// test/smoke.js —— H5 外卖点单后端烟测
// 运行：npm test
// 使用临时目录和临时端口，不会污染正式数据。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'h5-order-delivery-test-'));
const DATA_DIR = path.join(TEMP_DIR, 'data');
const CONFIG_PATH = path.join(TEMP_DIR, 'config.json');
const ADMIN_PASSWORD = 'test-pass-delivery';

let currentPort = 0;
let server = null;
let serverLogs = '';

const ADDRESS = '四川省乐山市市中区张公桥好吃街 88 号 3 栋 2 单元 501';

function writeFixtures() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.copyFileSync(
    path.join(ROOT, 'data', 'menu.js'),
    path.join(DATA_DIR, 'menu.js')
  );
  fs.writeFileSync(path.join(DATA_DIR, 'orders.json'), '[]\n');
  fs.writeFileSync(path.join(DATA_DIR, 'users.json'), '[]\n');
  fs.writeFileSync(path.join(DATA_DIR, 'user-coupons.json'), '[]\n');
  fs.writeFileSync(path.join(DATA_DIR, 'menu-state.json'), '{}\n');
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      {
        port: 0,
        adminPassword: ADMIN_PASSWORD,
        storeName: '嘎嘎香 乐山油炸串串',
        shopPhone: '15528775725',
        hours: '每天 17:00 - 次日 00:30',
        notice: '外卖配送，提交订单后商家会电话联系确认，线下支付',
        deliveryFeeCents: 300,
        freeDeliveryThresholdCents: 5000,
        amapKey: '',
        publicBaseUrl: 'http://localhost:3999',
      },
      null,
      2
    )
  );
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startServer(port) {
  currentPort = port;
  serverLogs = '';

  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port),
      DATA_DIR,
      CONFIG_PATH,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverLogs += chunk.toString();
  });

  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/api/menu');
      if (response.ok) return;
    } catch (err) {
      // 继续等待
    }
    await wait(120);
  }

  throw new Error('服务器启动超时\n' + serverLogs);
}

function stopServer() {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.once('exit', () => resolve());
    server.kill();
    server = null;
    setTimeout(resolve, 1500);
  });
}

async function request(method, pathname, options) {
  const opts = options || {};
  const headers = Object.assign({}, opts.headers || {});

  if (opts.body) headers['Content-Type'] = 'application/json';
  if (opts.token) headers['x-admin-token'] = opts.token;
  if (opts.userToken) headers['x-user-token'] = opts.userToken;

  const response = await fetch(
    'http://127.0.0.1:' + currentPort + pathname,
    {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }
  );

  let data = {};
  try {
    data = await response.json();
  } catch (err) {
    data = {};
  }

  return { status: response.status, data };
}

async function adminLogin() {
  const result = await request('POST', '/api/admin/login', {
    body: { password: ADMIN_PASSWORD },
  });
  assert.strictEqual(result.status, 200, '管理员登录应成功');
  assert.ok(result.data.token, '登录应返回 token');
  return result.data.token;
}

async function createCustomer(phone, nickname, avatar) {
  const login = await request('POST', '/api/auth/login', { body: {} });
  assert.strictEqual(login.status, 201, '顾客登录应成功');
  assert.strictEqual(login.data.mode, 'local', '未配置时统一登录应走本机');
  assert.ok(login.data.token, '顾客登录应返回 token');
  assert.strictEqual(login.data.user.profileComplete, false);

  const profile = await request('POST', '/api/auth/profile', {
    userToken: login.data.token,
    body: {
      nickname,
      phone,
      avatar: avatar || '🍢',
    },
  });
  assert.strictEqual(profile.status, 200, '顾客资料设置应成功');
  assert.strictEqual(profile.data.user.phone, phone);
  assert.strictEqual(profile.data.user.profileComplete, true);

  return {
    token: login.data.token,
    user: profile.data.user,
  };
}

function orderBody(overrides) {
  return Object.assign(
    {
      items: [],
      recipientName: '测试收货人',
      phone: '13800000001',
      address: ADDRESS,
      note: '',
    },
    overrides || {}
  );
}

async function run() {
  writeFixtures();
  await startServer(3111);

  // ---------- 公开配置 / 菜单 ----------
  let result = await request('GET', '/api/auth/config');
  assert.strictEqual(result.status, 200);
  assert.ok(
    result.data.wechatLogin === undefined,
    '未配置时不应向页面暴露微信登录状态'
  );
  assert.strictEqual(result.data.deliveryFeeCents, 300);
  assert.strictEqual(result.data.freeDeliveryThresholdCents, 5000);
  assert.strictEqual(result.data.amapConfigured, false);

  // 未配置公众号时，即使请求来自微信，也只走本机登录
  result = await request('POST', '/api/auth/login', {
    headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0' },
    body: {},
  });
  assert.strictEqual(result.status, 201, '未配置时应直接本机登录');
  assert.strictEqual(result.data.mode, 'local');
  assert.ok(result.data.token, '本机登录应返回 token');
  assert.ok(!serverLogs.includes('微信登录'), '未配置时不输出微信登录状态');

  result = await request('GET', '/api/auth/wechat/start');
  assert.strictEqual(result.status, 200, '未配置时授权入口应静默回到登录页');

  const directStartWithoutConfig = await fetch(
    'http://127.0.0.1:' + currentPort + '/api/auth/wechat/start',
    { redirect: 'manual' }
  );
  assert.strictEqual(directStartWithoutConfig.status, 302);
  assert.strictEqual(directStartWithoutConfig.headers.get('location'), '/');

  result = await request('GET', '/api/menu');
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.menu.length, 47, '菜单应有 47 道菜');
  assert.ok(result.data.menu.every((d) => Number.isInteger(d.priceCents)));
  assert.strictEqual(result.data.store.deliveryFeeCents, 300);
  assert.strictEqual(result.data.store.freeDeliveryThresholdCents, 5000);
  assert.ok(
    result.data.store.notice.indexOf('外卖') >= 0,
    '门店提示应为外卖配送'
  );

  const menu = result.data.menu;
  const cheap = menu.find((d) => d.priceCents === 70);
  const premium = menu.find((d) => d.priceCents === 1000);
  assert.ok(cheap && premium, '原始价格菜品应存在');

  // 价格与原始 menu.js 一致
  const sourceMenu = require(path.join(DATA_DIR, 'menu.js'));
  const sourceById = new Map(sourceMenu.map((dish) => [dish.id, dish]));
  menu.forEach((dish) => {
    const original = sourceById.get(dish.id);
    if (original) {
      assert.strictEqual(
        dish.priceCents,
        Math.round(original.price * 100),
        '菜品价格应恢复为原始价格：' + dish.name
      );
    }
  });

  // ---------- 未登录限制 ----------
  result = await request('GET', '/api/coupons');
  assert.strictEqual(result.status, 401, '未登录不能领券');

  result = await request('POST', '/api/order', { body: orderBody() });
  assert.strictEqual(result.status, 401, '未登录不能下单');

  result = await request('GET', '/api/my-orders');
  assert.strictEqual(result.status, 401, '未登录不能查看订单');

  result = await request('GET', '/api/geocode?lat=29.5&lng=103.7');
  assert.strictEqual(result.status, 401, '未登录不能调用定位');

  // ---------- 顾客登录 / 资料锁定 ----------
  const loginA = await request('POST', '/api/auth/login', { body: {} });
  assert.strictEqual(loginA.status, 201);
  const tokenA = loginA.data.token;

  result = await request('GET', '/api/me', { userToken: tokenA });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.user.profileComplete, false);

  result = await request('POST', '/api/order', {
    userToken: tokenA,
    body: orderBody(),
  });
  assert.strictEqual(result.status, 403, '资料未完成不能下单');

  result = await request('GET', '/api/coupons', { userToken: tokenA });
  assert.strictEqual(result.status, 403, '资料未完成不能领券');

  result = await request('POST', '/api/auth/profile', {
    userToken: tokenA,
    body: { nickname: '小王', phone: '123', avatar: '🍢' },
  });
  assert.strictEqual(result.status, 400, '手机号必须为 11 位');

  result = await request('POST', '/api/auth/profile', {
    userToken: tokenA,
    body: {
      nickname: '小王',
      phone: '13800000001',
      avatar: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    },
  });
  assert.strictEqual(result.status, 400, 'SVG 头像应被拒绝');

  result = await request('POST', '/api/auth/profile', {
    userToken: tokenA,
    body: { nickname: '小王', phone: '13800000001', avatar: '🍢' },
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.user.nickname, '小王');
  assert.strictEqual(result.data.user.profileComplete, true);
  const userA = result.data.user;

  result = await request('POST', '/api/auth/profile', {
    userToken: tokenA,
    body: { nickname: '改名', phone: '13800000001', avatar: '🥩' },
  });
  assert.strictEqual(result.status, 409, '昵称和头像设置后不可修改');

  result = await request('GET', '/api/me', { userToken: tokenA });
  assert.strictEqual(result.data.user.nickname, '小王', '资料应保持首次设置');
  assert.strictEqual(result.data.user.phone, '13800000001');

  // ---------- 新人券 ----------
  result = await request('GET', '/api/coupons', { userToken: tokenA });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.coupons.length, 1, '新账号自动获得一张新人券');
  const couponA = result.data.coupons[0];
  assert.strictEqual(couponA.name, '新人首单券');
  assert.strictEqual(couponA.thresholdCents, 5000);
  assert.strictEqual(couponA.discountCents, 500);
  assert.strictEqual(couponA.blockedByFirstOrder, false);

  // ---------- 首单：满 50 免配送费 + 用券 ----------
  result = await request('POST', '/api/order', {
    userToken: tokenA,
    body: orderBody({
      items: [{ id: premium.id, count: 5, priceCents: 1 }],
      phone: '13800000001',
      note: '少辣',
      couponId: couponA.id,
    }),
  });
  assert.strictEqual(result.status, 201, '用券下单应成功');
  const orderA = result.data;
  assert.strictEqual(orderA.subtotalCents, 5000, '服务端按分计算小计');
  assert.strictEqual(orderA.deliveryFeeCents, 0, '满 50 元免配送费');
  assert.strictEqual(orderA.discountCents, 500, '新人券减 5 元');
  assert.strictEqual(orderA.totalCents, 4500, '实付应为 45 元');
  assert.strictEqual(orderA.items[0].priceCents, 1000, '客户端价格无效');
  assert.strictEqual(orderA.address, ADDRESS);
  assert.strictEqual(orderA.recipientName, '测试收货人');
  assert.strictEqual(orderA.pickupNo, 'A001');

  result = await request(
    'GET',
    '/api/order/' + encodeURIComponent(orderA.id) + '?token=' + orderA.token,
    { userToken: tokenA }
  );
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.order.status, 'pending');
  assert.strictEqual(result.data.order.deliveryFeeCents, 0);

  result = await request(
    'GET',
    '/api/order/' + encodeURIComponent(orderA.id) + '?token=wrong'
  );
  assert.strictEqual(result.status, 404, '错误 token 不能查单');

  // 同一张券不能重复用
  result = await request('POST', '/api/order', {
    userToken: tokenA,
    body: orderBody({
      items: [{ id: premium.id, count: 2 }],
      phone: '13800000001',
      couponId: couponA.id,
    }),
  });
  assert.strictEqual(result.status, 409, '已使用的券不能再用');

  // 不满 50 元收取 3 元配送费
  result = await request('POST', '/api/order', {
    userToken: tokenA,
    body: orderBody({
      items: [{ id: premium.id, count: 2 }],
      phone: '13800000001',
    }),
  });
  assert.strictEqual(result.status, 201);
  const orderA2 = result.data;
  assert.strictEqual(orderA2.subtotalCents, 2000);
  assert.strictEqual(orderA2.deliveryFeeCents, 300, '不满 50 元收 3 元配送费');
  assert.strictEqual(orderA2.totalCents, 2300);

  // 配送信息校验
  result = await request('POST', '/api/order', {
    userToken: tokenA,
    body: orderBody({
      items: [{ id: cheap.id, count: 1 }],
      phone: '123',
    }),
  });
  assert.strictEqual(result.status, 400, '手机号不正确不能下单');

  result = await request('POST', '/api/order', {
    userToken: tokenA,
    body: orderBody({
      items: [{ id: cheap.id, count: 1 }],
      phone: '13800000001',
      address: '短',
    }),
  });
  assert.strictEqual(result.status, 400, '地址太短不能下单');

  result = await request('POST', '/api/order', {
    userToken: tokenA,
    body: orderBody({
      items: [{ id: cheap.id, count: 1 }],
      phone: '13800000001',
      recipientName: '',
    }),
  });
  assert.strictEqual(result.status, 400, '收货人不能为空');

  // 我的订单
  result = await request('GET', '/api/my-orders', { userToken: tokenA });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.orders.length, 2);
  assert.ok(result.data.orders.every((order) => order.token));
  assert.ok(
    result.data.orders.every((order) => order.accountId === undefined),
    '顾客端不暴露账号内部字段'
  );

  // ---------- 管理员登录 / 订单列表 ----------
  result = await request('POST', '/api/admin/login', {
    body: { password: 'wrong' },
  });
  assert.strictEqual(result.status, 401);

  const adminToken = await adminLogin();

  result = await request('GET', '/api/admin/orders');
  assert.strictEqual(result.status, 401, '未登录不能看订单');

  result = await request('GET', '/api/admin/orders', { token: adminToken });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.orders.length, 2);
  const adminOrderA = result.data.orders.find((item) => item.id === orderA.id);
  assert.ok(adminOrderA);
  assert.strictEqual(adminOrderA.address, ADDRESS);
  assert.strictEqual(adminOrderA.accountNickname, '小王');
  assert.strictEqual(adminOrderA.accountPhone, '13800000001');
  assert.strictEqual(adminOrderA.deliveryFeeCents, 0);
  assert.ok(adminOrderA.token === undefined, '商家列表不应泄露顾客查单 token');

  // ---------- 状态流转 ----------
  result = await request(
    'POST',
    '/api/admin/orders/' + encodeURIComponent(orderA.id) + '/status',
    { token: adminToken, body: { status: 'completed' } }
  );
  assert.strictEqual(result.status, 409, '待接单不能直接完成');

  result = await request(
    'POST',
    '/api/admin/orders/' + encodeURIComponent(orderA.id) + '/status',
    { token: adminToken, body: { status: 'making' } }
  );
  assert.strictEqual(result.status, 200);

  result = await request(
    'POST',
    '/api/admin/orders/' + encodeURIComponent(orderA.id) + '/status',
    { token: adminToken, body: { status: 'completed' } }
  );
  assert.strictEqual(result.status, 200);

  result = await request(
    'GET',
    '/api/order/' + encodeURIComponent(orderA.id) + '?token=' + orderA.token,
    { userToken: tokenA }
  );
  assert.strictEqual(result.data.order.status, 'completed');

  // ---------- 取消退券 ----------
  const customerB = await createCustomer('13800000002', '小李', '🥩');
  const tokenB = customerB.token;

  // 手机号不能重复绑定
  const loginDup = await request('POST', '/api/auth/login', { body: {} });
  result = await request('POST', '/api/auth/profile', {
    userToken: loginDup.data.token,
    body: { nickname: '重复手机号', phone: '13800000002', avatar: '🍗' },
  });
  assert.strictEqual(result.status, 409, '一个手机号只能绑定一个账号');

  result = await request('GET', '/api/coupons', { userToken: tokenB });
  const couponB = result.data.coupons[0];
  assert.ok(couponB, '账号 B 应自动获得新人券');

  result = await request('POST', '/api/order', {
    userToken: tokenB,
    body: orderBody({
      items: [{ id: premium.id, count: 5 }],
      phone: '13800000002',
      couponId: couponB.id,
    }),
  });
  assert.strictEqual(result.status, 201);
  const orderB = result.data;

  result = await request(
    'POST',
    '/api/admin/orders/' + encodeURIComponent(orderB.id) + '/status',
    { token: adminToken, body: { status: 'cancelled' } }
  );
  assert.strictEqual(result.status, 200, '待接单可以取消');

  result = await request('GET', '/api/coupons', { userToken: tokenB });
  assert.strictEqual(result.data.coupons.length, 1, '取消后优惠券应退回');
  assert.strictEqual(result.data.coupons[0].blockedByFirstOrder, false);

  // 取消后重新用券下单
  result = await request('POST', '/api/order', {
    userToken: tokenB,
    body: orderBody({
      items: [{ id: premium.id, count: 5 }],
      phone: '13800000002',
      couponId: couponB.id,
    }),
  });
  assert.strictEqual(result.status, 201);
  assert.strictEqual(result.data.discountCents, 500);
  const orderB2 = result.data;

  // 制作中可以取消（并退券），完成后不能取消
  result = await request(
    'POST',
    '/api/admin/orders/' + encodeURIComponent(orderB2.id) + '/status',
    { token: adminToken, body: { status: 'making' } }
  );
  assert.strictEqual(result.status, 200);
  result = await request(
    'POST',
    '/api/admin/orders/' + encodeURIComponent(orderB2.id) + '/status',
    { token: adminToken, body: { status: 'cancelled' } }
  );
  assert.strictEqual(result.status, 200, '制作中可取消');

  result = await request(
    'POST',
    '/api/admin/orders/' + encodeURIComponent(orderB2.id) + '/status',
    { token: adminToken, body: { status: 'cancelled' } }
  );
  assert.strictEqual(result.status, 409, '已取消订单不能重复取消');

  // ---------- 菜品改价 / 新增 / 售罄 / 上下架 ----------
  const editDish = menu.find((d) => d.id === cheap.id);
  result = await request('POST', '/api/admin/menu', {
    token: adminToken,
    body: {
      id: editDish.id,
      name: editDish.name,
      category: editDish.category,
      priceCents: 123,
      unit: editDish.unit,
      emoji: editDish.emoji,
      tag: editDish.tag,
      desc: editDish.desc,
      soldOut: false,
      enabled: true,
    },
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.dish.priceCents, 123);

  result = await request('GET', '/api/menu');
  assert.strictEqual(
    result.data.menu.find((d) => d.id === cheap.id).priceCents,
    123,
    '顾客端应看到改后的价格'
  );

  result = await request('POST', '/api/admin/menu', {
    token: adminToken,
    body: {
      name: '测试新菜',
      category: '测试分类',
      priceCents: 250,
      unit: '份',
      emoji: '🧪',
      tag: '新品',
      desc: '接口测试',
      soldOut: false,
      enabled: true,
    },
  });
  assert.strictEqual(result.status, 200);
  const newDish = result.data.dish;
  assert.ok(newDish.id);

  result = await request('GET', '/api/menu');
  assert.ok(
    result.data.menu.some((d) => d.id === newDish.id),
    '新增菜品应出现在顾客菜单'
  );
  assert.ok(result.data.categories.includes('测试分类'));

  const customerC = await createCustomer('13800000003', '小张', '🐼');
  const tokenC = customerC.token;

  result = await request(
    'POST',
    '/api/admin/menu/' + encodeURIComponent(newDish.id) + '/status',
    { token: adminToken, body: { soldOut: true } }
  );
  assert.strictEqual(result.status, 200);

  result = await request('POST', '/api/order', {
    userToken: tokenC,
    body: orderBody({
      items: [{ id: newDish.id, count: 1 }],
      phone: '13800000003',
    }),
  });
  assert.strictEqual(result.status, 409, '售罄菜品不能下单');

  result = await request(
    'POST',
    '/api/admin/menu/' + encodeURIComponent(newDish.id) + '/status',
    { token: adminToken, body: { soldOut: false, enabled: false } }
  );
  assert.strictEqual(result.status, 200);

  result = await request('GET', '/api/menu');
  assert.ok(
    !result.data.menu.some((d) => d.id === newDish.id),
    '下架菜品不出现在顾客菜单'
  );

  result = await request('POST', '/api/order', {
    userToken: tokenC,
    body: orderBody({
      items: [{ id: newDish.id, count: 1 }],
      phone: '13800000003',
    }),
  });
  assert.strictEqual(result.status, 400, '下架菜品不能下单');

  await request(
    'POST',
    '/api/admin/menu/' + encodeURIComponent(newDish.id) + '/status',
    { token: adminToken, body: { enabled: true } }
  );

  // ---------- 优惠券按手机号发放 ----------
  result = await request('GET', '/api/admin/coupons', { token: adminToken });
  assert.strictEqual(result.status, 200);
  assert.ok(result.data.templates.length >= 1);
  assert.ok(Array.isArray(result.data.customers), '应返回顾客列表');
  assert.ok(result.data.customers.length >= 3, '应记录已登录顾客');
  assert.ok(result.data.devices === undefined, '不再使用设备维度');

  result = await request('POST', '/api/admin/coupons', {
    token: adminToken,
    body: {
      name: '手动测试券',
      thresholdCents: 1000,
      discountCents: 100,
      autoIssue: false,
      onlyFirstOrder: false,
      enabled: true,
    },
  });
  assert.strictEqual(result.status, 200);
  const manualTemplate = result.data.template;

  result = await request('POST', '/api/admin/coupons/issue', {
    token: adminToken,
    body: { templateId: manualTemplate.id, phone: '13800000001' },
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.issued, 1, '应精准发给该手机号账号');
  assert.strictEqual(result.data.nickname, '小王');

  result = await request('GET', '/api/coupons', { userToken: tokenA });
  assert.ok(
    result.data.coupons.some((c) => c.templateId === manualTemplate.id),
    '手动发的券应出现在该顾客账号'
  );

  result = await request('GET', '/api/coupons', { userToken: tokenB });
  assert.ok(
    !result.data.coupons.some((c) => c.templateId === manualTemplate.id),
    '不能发到其他手机号账号'
  );

  result = await request('POST', '/api/admin/coupons/issue', {
    token: adminToken,
    body: { templateId: manualTemplate.id, phone: '13800009999' },
  });
  assert.strictEqual(result.status, 404, '未登录手机号不能发放');

  result = await request('POST', '/api/admin/coupons/issue', {
    token: adminToken,
    body: { templateId: manualTemplate.id, phone: '13800000001' },
  });
  assert.strictEqual(result.data.issued, 0, '同款未使用券不重复发放');

  result = await request('GET', '/api/admin/coupons', { token: adminToken });
  const issuedToA = result.data.issued.find(
    (coupon) => coupon.accountId === userA.id &&
      coupon.templateId === manualTemplate.id
  );
  assert.ok(issuedToA, '发放记录应有账号信息');
  assert.strictEqual(issuedToA.phone, '13800000001');
  assert.strictEqual(issuedToA.accountNickname, '小王');

  // ---------- 定位参数校验 ----------
  result = await request('GET', '/api/geocode?lat=999&lng=103.7', {
    userToken: tokenA,
  });
  assert.strictEqual(result.status, 400, '非法坐标应被拒绝');

  // ---------- 并发下单不丢单 ----------
  const concurrent = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      request('POST', '/api/order', {
        userToken: tokenC,
        body: orderBody({
          items: [{ id: premium.id, count: 1 }],
          phone: '13800000003',
          note: '并发测试 ' + index,
        }),
      })
    )
  );

  assert.ok(
    concurrent.every((item) => item.status === 201),
    '10 个并发订单都应成功\n' +
      JSON.stringify(concurrent.map((item) => [item.status, item.data]))
  );

  const orderIds = new Set(concurrent.map((item) => item.data.id));
  const pickupNos = new Set(concurrent.map((item) => item.data.pickupNo));
  assert.strictEqual(orderIds.size, 10, '并发订单 id 应唯一');
  assert.strictEqual(pickupNos.size, 10, '并发订单取单号应唯一');
  assert.ok(
    concurrent.every(
      (item) =>
        item.data.deliveryFeeCents === 300 &&
        item.data.totalCents === 1300
    ),
    '并发订单配送费应正确'
  );

  const persisted = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'orders.json'), 'utf8')
  );
  assert.ok(persisted.length >= 14, '订单应完整写入 JSON 文件');
  assert.strictEqual(
    new Set(persisted.map((o) => o.id)).size,
    persisted.length,
    'JSON 中订单 id 不应重复'
  );

  // ---------- 点餐页推荐 ----------
  result = await request('GET', '/api/menu', { userToken: tokenA });
  assert.strictEqual(result.status, 200);
  assert.ok(
    result.data.recommendations.recent.includes(premium.id),
    '最近点过应包含本人点过的菜品'
  );

  result = await request('GET', '/api/menu', { userToken: tokenB });
  assert.ok(
    result.data.recommendations.recent.length === 0,
    '已取消订单不应进入最近点过'
  );
  assert.ok(
    result.data.recommendations.popular.includes(premium.id),
    '销量较高应包含实际销量菜品'
  );

  result = await request('GET', '/api/menu');
  assert.ok(
    result.data.recommendations.recent.length === 0,
    '未登录时没有最近点过'
  );
  assert.ok(
    result.data.recommendations.popular.includes(premium.id),
    '销量较高对所有人可见'
  );

  // ---------- 静态页面 / 口令泄漏 ----------
  const indexResponse = await fetch('http://127.0.0.1:' + currentPort + '/');
  assert.strictEqual(indexResponse.status, 200);
  const indexHtml = fs.readFileSync(
    path.join(ROOT, 'public', 'index.html'),
    'utf8'
  );
  const adminHtml = fs.readFileSync(
    path.join(ROOT, 'public', 'admin.html'),
    'utf8'
  );
  const adminJs = fs.readFileSync(
    path.join(ROOT, 'public', 'admin.js'),
    'utf8'
  );

  assert.ok(indexHtml.includes('嘎嘎香'), '顾客页应包含店名');
  assert.ok(indexHtml.includes('正在进入点单页面'), '顾客页应静默进入');
  assert.ok(!indexHtml.includes('微信登录'), '顾客页不再显示微信登录界面');
  assert.ok(indexHtml.includes('自动定位'), '结算页应有自动定位');
  assert.ok(indexHtml.includes('配送费'), '结算页应显示配送费');
  assert.ok(!indexHtml.includes('桌号'), '不再有桌号功能');
  assert.ok(!indexHtml.includes('堂食'), '不再有堂食功能');
  assert.ok(adminHtml.includes('商家后台'), '后台页应能打开');
  assert.ok(adminHtml.includes('订单详情'), '后台应有订单详情弹窗');
  assert.ok(adminHtml.includes('顾客手机号'), '优惠券应按手机号发放');
  assert.ok(adminHtml.includes('dishSearchInput'), '后台菜品管理应有搜索栏');
  assert.ok(!indexHtml.includes(ADMIN_PASSWORD), '顾客页不能包含口令');
  assert.ok(!adminHtml.includes(ADMIN_PASSWORD), '后台 HTML 不能包含口令');
  assert.ok(!adminJs.includes(ADMIN_PASSWORD), '后台 JS 不能包含口令');

  const qrResponse = await fetch(
    'http://127.0.0.1:' + currentPort + '/qrcodes/print.html'
  );
  assert.strictEqual(qrResponse.status, 404, '桌码功能已删除');

  result = await request('GET', '/api/auth/wechat/start');
  assert.strictEqual(result.status, 200, '未配置时授权路由静默回到登录页');

  // ---------- 重启后 JSON 持久化 ----------
  await stopServer();
  await startServer(3112);

  const token2 = await adminLogin();
  result = await request('GET', '/api/admin/orders', { token: token2 });
  assert.strictEqual(result.status, 200);
  assert.ok(result.data.orders.length >= 14, '重启后订单仍在');

  result = await request('GET', '/api/menu');
  assert.ok(
    result.data.menu.some((d) => d.id === cheap.id && d.priceCents === 123),
    '重启后菜品改价仍在'
  );

  result = await request('GET', '/api/admin/coupons', { token: token2 });
  assert.ok(
    result.data.templates.some((c) => c.id === manualTemplate.id),
    '重启后优惠券模板仍在'
  );
  assert.ok(
    result.data.customers.some((c) => c.phone === '13800000001'),
    '重启后顾客账号仍在'
  );

  result = await request('GET', '/api/me', { userToken: tokenA });
  assert.strictEqual(result.status, 200, '重启后顾客登录仍有效');
  assert.strictEqual(result.data.user.profileComplete, true);
  assert.strictEqual(result.data.user.nickname, '小王');

  result = await request('GET', '/api/my-orders', { userToken: tokenA });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.orders.length, 2, '重启后我的订单仍在');

  // ---------- 微信网页授权：仅在启用且微信内生效 ----------
  await stopServer();

  const configWithWechat = JSON.parse(
    fs.readFileSync(CONFIG_PATH, 'utf8')
  );
  configWithWechat.wechat = {
    appId: 'wx_test_appid',
    appSecret: 'test_secret',
    enabled: true,
  };
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(configWithWechat, null, 2)
  );

  await startServer(3113);

  result = await request('GET', '/api/auth/config');
  assert.ok(
    result.data.wechatLogin === undefined,
    '即使启用授权，页面也不读取微信配置状态'
  );

  // 微信内：统一登录接口返回授权跳转地址
  result = await request('POST', '/api/auth/login', {
    headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0' },
    body: {},
  });
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.data.mode, 'wechat');
  assert.ok(
    result.data.redirectUrl.indexOf(
      'https://open.weixin.qq.com/connect/oauth2/authorize?'
    ) === 0,
    '微信内应返回官方授权地址'
  );
  assert.ok(result.data.redirectUrl.includes('appid=wx_test_appid'));
  assert.ok(result.data.redirectUrl.includes('scope=snsapi_userinfo'));
  assert.ok(result.data.redirectUrl.includes('redirect_uri='));

  // 顾客端静默进入使用 localOnly，即使配置了公众号也不跳微信
  result = await request('POST', '/api/auth/login', {
    headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0' },
    body: { localOnly: true },
  });
  assert.strictEqual(result.status, 201);
  assert.strictEqual(result.data.mode, 'local');
  assert.ok(result.data.token, '静默进入应直接返回本机 token');

  // 普通浏览器：即使配置了公众号，也继续本机登录
  result = await request('POST', '/api/auth/login', {
    headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' },
    body: {},
  });
  assert.strictEqual(result.status, 201);
  assert.strictEqual(result.data.mode, 'local');
  assert.ok(result.data.token);

  // 直接访问授权入口仍然可用，方便排查
  const startResponse = await fetch(
    'http://127.0.0.1:' + currentPort + '/api/auth/wechat/start',
    { redirect: 'manual' }
  );
  assert.strictEqual(startResponse.status, 302);
  const authorizeUrl = startResponse.headers.get('location') || '';
  assert.ok(
    authorizeUrl.indexOf('https://open.weixin.qq.com/connect/oauth2/authorize?') === 0,
    '微信授权入口应跳转官方地址'
  );

  const callbackResponse = await fetch(
    'http://127.0.0.1:' + currentPort +
      '/api/auth/wechat/callback?code=fake&state=expired',
    { redirect: 'manual' }
  );
  assert.strictEqual(callbackResponse.status, 302);
  assert.ok(
    (callbackResponse.headers.get('location') || '').includes('authError='),
    '无效授权状态应回到登录页并提示'
  );

  // ---------- 启用但缺少 AppID/AppSecret：静默回退本机登录 ----------
  await stopServer();

  const configIncomplete = JSON.parse(
    fs.readFileSync(CONFIG_PATH, 'utf8')
  );
  configIncomplete.wechat = {
    enabled: true,
    appId: '',
    appSecret: '',
  };
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify(configIncomplete, null, 2)
  );

  await startServer(3114);

  result = await request('POST', '/api/auth/login', {
    headers: { 'User-Agent': 'Mozilla/5.0 MicroMessenger/8.0' },
    body: {},
  });
  assert.strictEqual(result.status, 201, '配置不完整不应影响登录');
  assert.strictEqual(result.data.mode, 'local');
  assert.ok(result.data.token);
  assert.ok(
    !serverLogs.includes('微信登录'),
    '配置不完整时不输出微信登录状态'
  );

  result = await request('GET', '/api/auth/wechat/start');
  assert.strictEqual(
    result.status,
    200,
    '配置不完整时授权路由应静默回到登录页'
  );

  const incompleteStart = await fetch(
    'http://127.0.0.1:' + currentPort + '/api/auth/wechat/start',
    { redirect: 'manual' }
  );
  assert.strictEqual(incompleteStart.status, 302);
  assert.strictEqual(incompleteStart.headers.get('location'), '/');

  console.log('');
  console.log('SMOKE_TESTS_OK');
  console.log('临时数据目录：' + TEMP_DIR);
}

run()
  .catch((err) => {
    console.error('');
    console.error('SMOKE_TESTS_FAILED');
    console.error(err);
    if (serverLogs) console.error('服务器日志：\n' + serverLogs);
    process.exitCode = 1;
  })
  .finally(async () => {
    await stopServer();
    try {
      fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    } catch (err) {
      // 忽略清理失败
    }
  });
