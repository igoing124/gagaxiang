// 线上回归测试：对已部署的 Worker 走一遍真实下单流程
// 用法：node test/online.mjs https://xxx.workers.dev

const BASE = (process.argv[2] || 'https://gagaxiang-order.gagaxiang.workers.dev').replace(/\/$/, '');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const ADDRESS = '四川省乐山市市中区张公桥好吃街 88 号 3 栋 2 单元 501';

if (!ADMIN_PASSWORD) {
  throw new Error('请通过 ADMIN_PASSWORD 环境变量提供商家口令');
}

let passed = 0;

async function call(method, path, options = {}) {
  const headers = {};
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.userToken) headers['x-user-token'] = options.userToken;
  if (options.adminToken) headers['x-admin-token'] = options.adminToken;

  const response = await fetch(BASE + path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch (err) {
    // 保留文本
  }

  return { status: response.status, data, headers: response.headers };
}

async function test(name, fn) {
  const result = await fn();
  passed += 1;
  console.log('  ✓ ' + name + (result ? ' — ' + result : ''));
}

function assert(condition, message) {
  if (!condition) throw new Error('断言失败：' + message);
}

console.log('线上测试：' + BASE);

await test('顾客端首页', async () => {
  const res = await fetch(BASE + '/');
  const html = await res.text();
  assert(res.status === 200, '状态码 ' + res.status);
  assert(html.includes('嘎嘎香'), '页面包含店名');
  assert(res.headers.get('x-content-type-options') === 'nosniff', '安全头');
  return 'HTTP ' + res.status;
});

await test('商家后台页面', async () => {
  const res = await fetch(BASE + '/admin');
  const html = await res.text();
  assert(res.status === 200, '状态码 ' + res.status);
  assert(html.includes('商家'), '页面包含商家后台');
  return 'HTTP ' + res.status;
});

await test('静态资源', async () => {
  const css = await fetch(BASE + '/style.css');
  assert(css.status === 200, 'style.css ' + css.status);
  assert((css.headers.get('content-type') || '').includes('text/css'), 'CSS 类型');
  const js = await fetch(BASE + '/app.js');
  assert(js.status === 200, 'app.js ' + js.status);
  return 'CSS/JS 正常';
});

let userToken = '';
let phone = '';

await test('菜单接口', async () => {
  const res = await call('GET', '/api/menu');
  assert(res.status === 200, '状态码 ' + res.status);
  assert(res.data.menu.length === 47, '47 道菜，实际 ' + res.data.menu.length);
  assert(res.data.menu[0].name === '莴笋', '首道菜');
  assert(res.data.store.deliveryFeeCents === 300, '配送费');
  return '47 道菜';
});

await test('顾客自动登录与资料', async () => {
  phone = '1770000' + String(Math.floor(Math.random() * 9000) + 1000);
  const login = await call('POST', '/api/auth/login', { body: { localOnly: true } });
  assert(login.status === 201, '登录 ' + login.status);
  assert(login.data.mode === 'local', '本机模式');
  userToken = login.data.token;

  const profile = await call('POST', '/api/auth/profile', {
    userToken,
    body: { nickname: '线上测试', avatar: '😋', phone },
  });
  assert(profile.status === 200, '资料 ' + profile.status);
  assert(profile.data.user.phone === phone, '手机号');
  return '账号已创建';
});

await test('新人券', async () => {
  const res = await call('GET', '/api/coupons', { userToken });
  assert(res.status === 200, '状态码 ' + res.status);
  assert(res.data.coupons.length === 1, '新人券数量 ' + res.data.coupons.length);
  assert(res.data.coupons[0].discountCents === 500, '优惠金额');
  return '满 50 减 5';
});

await test('下单并服务端算价', async () => {
  const res = await call('POST', '/api/order', {
    userToken,
    body: {
      items: [{ id: 'wo_sun', count: 2 }],
      recipientName: '线上测试',
      phone,
      address: ADDRESS,
      totalCents: 1,
    },
  });
  assert(res.status === 201, '下单 ' + res.status + ' ' + JSON.stringify(res.data));
  assert(res.data.subtotalCents === 140, '小计 ' + res.data.subtotalCents);
  assert(res.data.deliveryFeeCents === 300, '配送费');
  assert(res.data.totalCents === 440, '合计 ' + res.data.totalCents);
  return '合计 ' + (res.data.totalCents / 100) + ' 元，取餐号 ' + res.data.pickupNo;
});

let adminToken = '';

await test('商家登录', async () => {
  const bad = await call('POST', '/api/admin/login', { body: { password: 'wrong' } });
  assert(bad.status === 401, '错误口令应 401，实际 ' + bad.status);

  const res = await call('POST', '/api/admin/login', { body: { password: ADMIN_PASSWORD } });
  assert(res.status === 200, '登录 ' + res.status);
  adminToken = res.data.token;
  assert(adminToken, '拿到 token');
  return '口令正确';
});

await test('商家看到订单与地址', async () => {
  const res = await call('GET', '/api/admin/orders', { adminToken });
  assert(res.status === 200, '状态码 ' + res.status);
  assert(res.data.orders.length >= 1, '至少一个订单');
  const order = res.data.orders[0];
  assert(order.address === ADDRESS, '地址');
  assert(order.phone === phone, '电话');
  return '共 ' + res.data.orders.length + ' 单';
});

await test('接单 → 完成', async () => {
  const list = await call('GET', '/api/admin/orders', { adminToken });
  const order = list.data.orders[0];

  const making = await call('POST', `/api/admin/orders/${order.id}/status`, {
    adminToken,
    body: { status: 'making' },
  });
  assert(making.status === 200, '接单 ' + making.status);

  const done = await call('POST', `/api/admin/orders/${order.id}/status`, {
    adminToken,
    body: { status: 'completed' },
  });
  assert(done.status === 200, '完成 ' + done.status);
  assert(done.data.order.status === 'completed', '状态');
  return '订单已完成';
});

await test('顾客端订单状态同步', async () => {
  const res = await call('GET', '/api/my-orders', { userToken });
  assert(res.status === 200, '状态码 ' + res.status);
  assert(res.data.orders.length >= 1, '订单数量');
  assert(res.data.orders[0].status === 'completed', '状态 ' + res.data.orders[0].status);
  return '已完成';
});

await test('未授权访问被拒', async () => {
  const noUser = await call('GET', '/api/my-orders');
  assert(noUser.status === 401, '无用户 token 应 401');
  const noAdmin = await call('GET', '/api/admin/orders');
  assert(noAdmin.status === 401, '无商家 token 应 401');
  return '401';
});

console.log('\n线上 ' + passed + ' 组测试全部通过');
