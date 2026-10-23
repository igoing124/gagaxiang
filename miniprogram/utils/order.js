// utils/order.js —— 订单相关的公共函数
// 「我的订单」页和「我的」页都要展示订单，所以把重复的转换逻辑放在这里。

// 订单状态码 -> 页面显示的中文
const STATUS_TEXT = {
  pending: '待接单',
  making: '制作中',
  delivering: '配送中',
  completed: '已完成',
  cancelled: '已取消',
  // 兼容旧订单
  done: '已完成',
  canceled: '已取消',
};

// 从本地存储读取订单，并且保证返回值一定是数组
function getStoredOrders() {
  const stored = wx.getStorageSync('orders');
  if (!Array.isArray(stored)) return [];

  // 过滤掉意外写入的非对象数据，避免后面读取字段时报错
  return stored.filter((order) => order && typeof order === 'object');
}

// 把时间戳格式化成「2026-10-19 15:30」这种好读的样子
function formatTime(timestamp) {
  const d = new Date(timestamp);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);

  return (
    d.getFullYear() +
    '-' +
    pad(d.getMonth() + 1) +
    '-' +
    pad(d.getDate()) +
    ' ' +
    pad(d.getHours()) +
    ':' +
    pad(d.getMinutes())
  );
}

// 金额保留两位小数，避免 0.7 × 3 出现 2.099999... 这种小数误差
function roundMoney(value) {
  const n = Number(value) || 0;
  return Math.round(n * 100) / 100;
}

// 订单实的支付金额：兼容还没有 payablePrice 字段的旧订单
function getPayablePrice(order) {
  if (!order) return 0;

  if (order.payablePrice != null) {
    return roundMoney(order.payablePrice);
  }

  const totalPrice = Number(order.totalPrice) || 0;
  const discount = Number(order.discount) || 0;
  return roundMoney(Math.max(0, totalPrice - discount));
}

// 配送信息：显示收货地址
function getDeliveryText(order) {
  if (!order || !order.address) return '';
  return `送至：${order.address}`;
}

// 把存储里的订单转换成页面直接能用的数据
function toViewOrder(order) {
  const totalPrice = roundMoney(order.totalPrice);
  const discount = roundMoney(order.discount);
  const payablePrice = getPayablePrice(order);
  // 旧订单没有 status 字段，默认按「制作中」处理
  const status = order.status || 'making';

  return {
    ...order,
    status,
    totalPrice,
    discount,
    payablePrice,
    hasDiscount: discount > 0,
    deliveryText: getDeliveryText(order),
    statusText: STATUS_TEXT[status] || '制作中',
    itemsText: (Array.isArray(order.items) ? order.items : [])
      .map((item) => `${item.name}×${item.count}`)
      .join('、'),
    timeText: order.createdAt ? formatTime(order.createdAt) : '',
  };
}

// 计算订单总金额（价格单位是元）；有优惠券时按优惠后的订单金额统计
function sumTotal(orders) {
  if (!Array.isArray(orders)) return 0;

  const total = orders.reduce((sum, order) => sum + getPayablePrice(order), 0);
  return roundMoney(total);
}

module.exports = {
  STATUS_TEXT,
  getStoredOrders,
  formatTime,
  roundMoney,
  getPayablePrice,
  getDeliveryText,
  toViewOrder,
  sumTotal,
};
