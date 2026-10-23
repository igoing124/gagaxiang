// pages/detail/detail.js —— 商品详情页
const { listDishes } = require('../../services/cloud.js');

Page({
  data: {
    item: null, // 当前商品
    count: 0, // 购物车里已有几份
    loading: true,
  },

  // onLoad 只在页面打开时执行一次
  // 参数 options 里是跳转时带过来的数据：
  // 跳转地址是 /pages/detail/detail?id=chicken，所以 options.id 就是 'chicken'
  async onLoad(options) {
    this.dishId = options.id;

    let dishes = [];
    try {
      dishes = await listDishes();
    } catch (e) {
      console.error('商品加载失败', e);
    }

    const item = dishes.find((g) => g.id === options.id);
    this.setData({ item: item || null, loading: false });

    if (item) {
      const cart = getApp().globalData.cart;
      this.setData({ count: cart[item.id] || 0 });
    }
  },

  // onShow 每次页面显示都会执行（从别的页面返回也会触发）
  onShow() {
    if (!this.data.item) return;

    const cart = getApp().globalData.cart;
    this.setData({
      count: cart[this.data.item.id] || 0,
    });
  },

  // 加入购物车
  onAdd() {
    const item = this.data.item;

    // 售罄商品不能加入购物车（详情页按钮已经置灰，这里兜底）
    if (item.soldOut) {
      wx.showToast({
        title: '这个商品已售罄',
        icon: 'none',
      });
      return;
    }

    const cart = getApp().globalData.cart;

    cart[item.id] = (cart[item.id] || 0) + 1;

    // 用 setData 更新数据，页面上的数字会立刻变化
    this.setData({ count: cart[item.id] });

    wx.showToast({
      title: '已加入购物车',
      icon: 'none',
    });
  },

  // 返回上一页（左上角自带的返回箭头也能返回）
  goBack() {
    wx.navigateBack();
  },
});
