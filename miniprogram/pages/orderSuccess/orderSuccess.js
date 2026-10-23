// pages/orderSuccess/orderSuccess.js —— 下单成功页
const {
  getPayablePrice,
  roundMoney,
} = require('../../utils/order.js');
const { listOrders } = require('../../services/cloud.js');

Page({
  data: {
    order: null,
    loading: true,
  },

  // 页面地址里带了订单号，用它去订单列表里把订单查出来
  async onLoad(options) {
    try {
      const orders = await listOrders();
      const order = orders.find((o) => o.id === options.id);

      if (order) {
        // 拼一句商品摘要，例如：炸鸡腿×2、炸豆腐×1
        order.itemsText = (Array.isArray(order.items) ? order.items : [])
          .map((item) => `${item.name}×${item.count}`)
          .join('、');

        // 兼容旧订单：没有配送/优惠字段时也能正常显示
        order.totalPrice = roundMoney(order.totalPrice);
        order.discount = roundMoney(order.discount);
        order.payablePrice = getPayablePrice(order);
        order.isDelivery = order.deliveryType === 'delivery' || !!order.address;
        order.deliveryFee = roundMoney(order.deliveryFee);
        order.receiverName = order.receiverName || '';
        order.receiverPhone = order.receiverPhone || '';
        order.address = order.address || '';
      }

      this.setData({ order, loading: false });
    } catch (e) {
      console.error('订单加载失败', e);
      this.setData({ order: null, loading: false });
    }
  },

  // 查看订单列表（redirectTo：替换掉成功页，返回时不会又回到这里）
  onOrders() {
    wx.redirectTo({ url: '/pages/orders/orders' });
  },

  // 返回点单页（switchTab 会清空其他页面）
  onBack() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
