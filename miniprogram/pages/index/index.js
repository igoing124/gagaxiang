// pages/index/index.js —— 点单页
// 菜单优先从云数据库读取；没配置云开发或云端还没导入时，用本地 goods.js 兜底
const { roundMoney } = require('../../utils/order.js');
const { listOrders, listDishes, getInstantDishes } = require('../../services/cloud.js');

// 从菜单里提取分类，顺序按菜品第一次出现的顺序
function buildCategories(dishes) {
  return ['全部'].concat(
    Array.from(new Set(dishes.map((dish) => dish.category).filter(Boolean)))
  );
}

Page({
  // data 里的数据可以在 WXML 里用 {{ }} 显示
  data: {
    list: [], // 当前分类下要显示的商品（每项多带一个 count）
    categories: ['全部'], // 分类列表，从菜单里自动提取
    currentCategory: '全部', // 当前选中的分类
    cartCount: 0, // 购物车总份数
    totalPrice: 0, // 合计金额
    cartList: [], // 购物车明细（只包含数量大于 0 的商品）
    cartListHeight: 0, // 购物车弹层里列表的高度（rpx），超过上限就滚动
    cartVisible: false, // 购物车弹层是否展开
    recentGoods: [], // 最近点过的菜品（首页顶部推荐）
    menuLoading: true, // 菜单正在加载
  },

  // onLoad 只执行一次：先用本机缓存（上次云端菜单 / 内置菜单）把首屏画出来，
  // 网络请求放到 onShow 里做，进页面不用先看几秒「菜单加载中」。
  onLoad() {
    this.dishes = getInstantDishes();

    const categories = buildCategories(this.dishes);
    const currentCategory =
      categories.indexOf(this.data.currentCategory) === -1
        ? '全部'
        : this.data.currentCategory;

    this.setData({
      categories,
      currentCategory,
      menuLoading: false,
    });

    this.refreshCart();
  },

  // onShow：页面每次显示都会执行（从详情页返回也会触发）
  onShow() {
    // 商家可能刚改过菜单，这里用缓存重新取一次（缓存失效时会请求云端）
    this.loadMenu();
  },

  // 读取菜单，并同步分类、购物车和最近点过
  async loadMenu() {
    this.setData({ menuLoading: this.dishes.length === 0 });

    let dishes = [];

    try {
      dishes = await listDishes();
    } catch (e) {
      console.error('菜单加载失败', e);
    }

    // 网络失败时 listDishes 会返回上一次的菜单，这里兜底不把页面清空
    const next = Array.isArray(dishes) && dishes.length ? dishes : this.dishes;
    const changed = JSON.stringify(next) !== JSON.stringify(this.dishes);

    this.dishes = next;

    // 最近点过是次要内容，放后台刷新，不挡菜单渲染
    this.refreshRecent();

    if (!changed && !this.data.menuLoading) {
      // 菜单没变化就不重新 setData，避免从详情页返回时整页重绘
      return;
    }

    const categories = buildCategories(this.dishes);

    let currentCategory = this.data.currentCategory || '全部';
    if (categories.indexOf(currentCategory) === -1) {
      currentCategory = '全部';
    }

    this.setData({
      categories,
      currentCategory,
      menuLoading: false,
    });

    this.refreshCart();
  },

  // 从历史订单里挑出最近点过的菜品，放在首页顶部推荐
  // 每次进页面都请求一次订单有点浪费，60 秒内复用上一次结果
  async refreshRecent() {
    if (Date.now() - (this.recentAt || 0) < 60 * 1000) {
      return;
    }

    this.recentAt = Date.now();

    let orders = [];

    try {
      orders = await listOrders();
    } catch (e) {
      console.error('最近订单加载失败', e);
    }

    if (orders.length === 0) {
      this.setData({ recentGoods: [] });
      return;
    }

    // 统计每道菜：lastIndex 越小表示越近，orderCount 是历史点过份数
    const stat = {};
    orders.forEach((order, orderIndex) => {
      const items = Array.isArray(order.items) ? order.items : [];

      items.forEach((item) => {
        if (!stat[item.id]) {
          stat[item.id] = {
            lastIndex: orderIndex,
            orderCount: 0,
          };
        }
        stat[item.id].orderCount += Number(item.count) || 0;
      });
    });

    const cart = getApp().globalData.cart;

    const recentGoods = Object.keys(stat)
      .map((id) => {
        const good = this.dishes.find((g) => g.id === id);

        // 菜品下架或售罄就不推荐
        if (!good || good.soldOut) return null;

        return {
          ...good,
          count: cart[id] || 0,
          lastIndex: stat[id].lastIndex,
          orderCount: stat[id].orderCount,
        };
      })
      .filter(Boolean)
      // 最近点过的排前面；同一单里点得多的排前面
      .sort((a, b) => {
        if (a.lastIndex !== b.lastIndex) return a.lastIndex - b.lastIndex;
        return b.orderCount - a.orderCount;
      })
      .slice(0, 6);

    this.setData({ recentGoods });
  },

  // 页面隐藏时收起购物车弹层：切到别的 tab 再回来时不会还开着
  onHide() {
    if (this.data.cartVisible) {
      this.setData({ cartVisible: false });
    }
  },

  // 根据全局购物车，重新计算页面要显示的数据
  refreshCart() {
    const cart = getApp().globalData.cart;

    let cartCount = 0;
    let totalPrice = 0;

    // 先算出全部商品的数量，底部合计和购物车弹层都要用全量数据
    const fullList = this.dishes.map((g) => {
      const count = cart[g.id] || 0;
      cartCount += count;
      totalPrice += count * g.price;
      return { ...g, count };
    });

    // 菜单里有 0.7 元这种价格，统一保留两位小数，避免出现 2.099999...
    totalPrice = roundMoney(totalPrice);

    // 分类筛选只影响页面上显示的列表，不影响底部合计
    const currentCategory = this.data.currentCategory || '全部';
    const list =
      currentCategory === '全部'
        ? fullList
        : fullList.filter((g) => g.category === currentCategory);

    // 购物车弹层只显示数量大于 0 的商品（包含所有分类）
    const cartList = fullList
      .filter((g) => g.count > 0)
      .map((g) => ({
        ...g,
        subtotal: roundMoney(g.count * g.price),
      }));

    // 弹层里每行大约 128rpx，最多显示 560rpx，超过就让 scroll-view 滚动
    const cartListHeight = Math.min(cartList.length * 128, 560);

    // 最近点过区域的「已选 N」也要跟着购物车刷新
    const recentGoods = this.data.recentGoods.map((g) => ({
      ...g,
      count: cart[g.id] || 0,
    }));

    // 必须用 setData 更新，页面才会刷新
    this.setData({
      list,
      cartCount,
      totalPrice,
      cartList,
      cartListHeight,
      recentGoods,
    });
  },

  // 切换菜品分类
  onCategoryChange(e) {
    const category = e.currentTarget.dataset.category;
    this.setData({ currentCategory: category });
    this.refreshCart();
  },

  // 点击卡片：跳到详情页，并把商品 id 拼在 url 后面
  onTapGoods(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`,
    });
  },

  // 点击 + 号：加入购物车
  // 注意用的是 catchtap：阻止点击事件向上冒泡，
  // 否则会同时触发外面卡片的 bindtap，直接跳到详情页。
  onAdd(e) {
    const id = e.currentTarget.dataset.id;
    // 用完整的菜单数据查找，而不是筛选后的 list，
    // 这样购物车弹层里也能操作其他分类的商品。
    const item = this.dishes.find((g) => g.id === id);

    // 售罄商品不能加购。按钮虽然已经被 wx:if 换掉了，
    // 这里再判断一次，这叫「兜底」，防止以后改界面时出错。
    if (!item || item.soldOut) {
      this.onSoldOutTap();
      return;
    }

    const cart = getApp().globalData.cart;
    cart[id] = (cart[id] || 0) + 1;
    this.refreshCart();

    // 这里不再弹「已加入购物车」：卡片上的数量会立刻变化，
    // 连续点 + 时反复弹提示反而打扰。
  },

  // 点击 − 号：减少一份；减到 0 时从购物车移除
  onMinus(e) {
    const id = e.currentTarget.dataset.id;
    // 同样用完整的菜单数据查找，不受当前分类筛选影响
    const item = this.dishes.find((g) => g.id === id);

    // 数据异常时兜底。
    // 注意：售罄商品也可能在购物车里（加购后才被标成售罄），要允许减掉。
    if (!item) return;

    const cart = getApp().globalData.cart;
    const count = cart[id] || 0;

    // 数量已经是 0，不能再减成负数
    if (count <= 0) return;

    if (count === 1) {
      // 减到 0 时删掉这个键，购物车数据保持干净
      delete cart[id];
    } else {
      cart[id] = count - 1;
    }

    this.refreshCart();
  },

  // 步进器外层的 catchtap：只用来阻止点击数字区域时冒泡到卡片
  onStepperStop() {},

  // 点击底部购物车信息：打开购物车明细
  onOpenCart() {
    if (this.data.cartCount === 0) {
      wx.showToast({
        title: '购物车还是空的',
        icon: 'none',
      });
      return;
    }

    this.setData({ cartVisible: true });
  },

  // 关闭购物车明细
  onCloseCart() {
    this.setData({ cartVisible: false });
  },

  // 弹层内部的空方法：阻止点击和滑动穿透到底层页面
  onCartStop() {},

  // 点击售罄按钮：提示用户
  onSoldOutTap() {
    wx.showToast({
      title: '这个商品已售罄',
      icon: 'none',
    });
  },

  // 打开订单列表
  onOrders() {
    wx.navigateTo({
      url: '/pages/orders/orders',
    });
  },

  // 去结算：跳到确认订单页
  onCheckout() {
    if (this.data.cartCount === 0) {
      wx.showToast({
        title: '先选点东西吧',
        icon: 'none',
      });
      return;
    }

    // 如果正在看购物车明细，跳转前先收起来
    this.setData({ cartVisible: false });

    wx.navigateTo({
      url: '/pages/checkout/checkout',
    });
  },

  // 清空购物车（先二次确认，避免误触）
  onClear() {
    if (this.data.cartCount === 0) return;

    wx.showModal({
      title: '清空购物车',
      content: '确定要清空已选商品吗？',
      confirmText: '清空',
      confirmColor: '#e8590c',
      success: (res) => {
        if (!res.confirm) return;

        getApp().globalData.cart = {};
        this.setData({ cartVisible: false });
        this.refreshCart();

        wx.showToast({
          title: '已清空',
          icon: 'none',
        });
      },
    });
  },

  // 右上角菜单的「转发」会调用这里（页面内的分享按钮已经移到「我的」页）
  onShareAppMessage() {
    return {
      title: '嘎嘎香 · 乐山油炸串串，越吃越巴适',
      path: '/pages/index/index',
    };
  },
});
