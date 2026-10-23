// pages/orders/orders.js —— 订单列表页
const { toViewOrder } = require('../../utils/order.js');
const {
  listOrders,
  deleteOrder,
  clearOrders,
  listDishes,
} = require('../../services/cloud.js');

Page({
  data: {
    orders: [],
    loading: true,
  },

  // 每次页面显示都重新读订单（云端或本地）
  onShow() {
    this.loadOrders();
  },

  // 读取订单列表
  async loadOrders() {
    this.setData({ loading: true });

    try {
      const orders = await listOrders();

      this.setData({
        orders: orders.map(toViewOrder),
        loading: false,
      });
    } catch (e) {
      console.error('订单加载失败', e);
      this.setData({ orders: [], loading: false });
      wx.showToast({
        title: '订单加载失败',
        icon: 'none',
      });
    }
  },

  // 删除单笔订单
  onDelete(e) {
    const id = e.currentTarget.dataset.id;

    wx.showModal({
      title: '删除订单',
      content: '确定要删除这笔订单吗？删除后无法恢复。',
      confirmText: '删除',
      confirmColor: '#e8590c',
      success: async (res) => {
        if (!res.confirm) return;

        try {
          await deleteOrder(id);
          await this.loadOrders();

          wx.showToast({ title: '已删除', icon: 'none' });
        } catch (err) {
          console.error('删除订单失败', err);
          wx.showToast({
            title: '删除失败，请重试',
            icon: 'none',
          });
        }
      },
    });
  },

  // 一键清空全部订单
  onClearAll() {
    const count = this.data.orders.length;
    if (count === 0) return;

    wx.showModal({
      title: '清空全部订单',
      content: `确定删除全部 ${count} 笔订单吗？删除后无法恢复。`,
      confirmText: '清空',
      confirmColor: '#e8590c',
      success: async (res) => {
        if (!res.confirm) return;

        try {
          await clearOrders();
          this.setData({ orders: [] });

          wx.showToast({ title: '已清空', icon: 'none' });
        } catch (err) {
          console.error('清空订单失败', err);
          wx.showToast({
            title: '清空失败，请重试',
            icon: 'none',
          });
        }
      },
    });
  },

  // 再来一单：把订单里的商品重新加入购物车
  async onReorder(e) {
    const index = e.currentTarget.dataset.index;
    const order = this.data.orders[index];
    if (!order) return;

    let dishes = [];
    try {
      dishes = await listDishes();
    } catch (err) {
      console.error('菜单加载失败', err);
    }

    const cart = getApp().globalData.cart;
    const added = [];
    const skipped = [];

    const items = Array.isArray(order.items) ? order.items : [];

    items.forEach((item) => {
      const current = dishes.find((g) => g.id === item.id);

      // 商品已下架或售罄，就跳过，不能加进购物车
      if (!current || current.soldOut) {
        skipped.push(item.name);
        return;
      }

      cart[item.id] = (cart[item.id] || 0) + item.count;
      added.push(item.name);
    });

    // 一个能加的商品都没有
    if (added.length === 0) {
      wx.showModal({
        title: '无法再来一单',
        content: '这单里的商品都已下架或售罄',
        showCancel: false,
        confirmText: '知道了',
      });
      return;
    }

    // 跳到点单页；switchTab 成功后再提示，避免提示被页面切换吞掉
    wx.switchTab({
      url: '/pages/index/index',
      success: () => {
        if (skipped.length > 0) {
          wx.showModal({
            title: '部分商品已跳过',
            content: `已加入购物车；已售罄或下架：${skipped.join('、')}`,
            showCancel: false,
            confirmText: '知道了',
          });
        } else {
          wx.showToast({
            title: '已加入购物车',
            icon: 'none',
          });
        }
      },
    });
  },

  // 去点单
  onBack() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
