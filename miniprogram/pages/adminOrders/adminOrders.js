// pages/adminOrders/adminOrders.js —— 商家订单管理
// 需要先在 config 集合的 admin 文档里配置商家 openid
const {
  isCloudEnabled,
  checkAdmin,
  listAllOrders,
  updateOrderStatus,
} = require('../../services/cloud.js');
const { toViewOrder } = require('../../utils/order.js');

// 顶部筛选 tab；count 会在 applyFilter 里重新计算
const TAB_LIST = [
  { key: 'pending', label: '待接单' },
  { key: 'active', label: '进行中' },
  { key: 'completed', label: '已完成' },
  { key: 'all', label: '全部' },
];

// 订单页打开时，每 15 秒自动检查一次新订单
const POLL_INTERVAL = 15000;

function isActiveStatus(status) {
  return status === 'making' || status === 'delivering';
}

function isCompletedStatus(status) {
  return status === 'completed' || status === 'done';
}

Page({
  data: {
    loading: true,
    cloudEnabled: false,
    isAdmin: false,
    openid: '',

    allOrders: [],
    orders: [],
    tabs: TAB_LIST.map((tab) => ({ ...tab, count: 0 })),
    activeTab: 'pending',
    pendingCount: 0,

    updatingId: '',

    pollSeconds: POLL_INTERVAL / 1000,
    newOrderTip: false,
    newOrderTipText: '',
  },

  onLoad() {
    // 这些是页面实例上的状态，不需要渲染到界面
    this.ordersLoaded = false;
    this.knownPendingIds = {};
    this.loadingOrders = null;
    this.pageVisible = false;
    this.pollTimer = null;
    this.audio = null;
  },

  onShow() {
    this.pageVisible = true;

    // 先加载一次，再开始定时检查
    this.loadPage().then(() => {
      // 加载期间可能已经离开页面，避免留下空转的定时器
      if (this.pageVisible) this.startPolling();
    });
  },

  onHide() {
    this.pageVisible = false;
    this.stopPolling();
    this.stopAudio();
  },

  onUnload() {
    this.pageVisible = false;
    this.stopPolling();

    if (this.audio) {
      try {
        this.audio.destroy();
      } catch (e) {
        // 忽略销毁失败
      }
      this.audio = null;
    }
  },

  onPullDownRefresh() {
    this.loadPage().then(() => {
      wx.stopPullDownRefresh();
    });
  },

  async loadPage() {
    this.setData({ loading: true });

    try {
      const cloudEnabled = await isCloudEnabled();

      if (!cloudEnabled) {
        this.setData({
          loading: false,
          cloudEnabled: false,
          isAdmin: false,
        });
        return;
      }

      const admin = await checkAdmin();

      this.setData({
        cloudEnabled: true,
        isAdmin: admin.isAdmin,
        openid: admin.openid,
      });

      if (!admin.isAdmin) {
        this.setData({ loading: false });
        return;
      }

      await this.loadOrders();
    } catch (e) {
      console.error('商家订单加载失败', e);
      this.setData({ loading: false });
      wx.showToast({ title: '订单加载失败，请重试', icon: 'none' });
    }
  },

  async loadOrders(options = {}) {
    // 定时刷新和手动刷新可能同时触发，复用同一个请求；
    // 接单/完成等操作需要 force，确保拿到更新后的状态
    if (this.loadingOrders) {
      if (!options.force) return this.loadingOrders;

      try {
        await this.loadingOrders;
      } catch (e) {
        // 上一次请求失败时忽略，继续重新请求
      }
    }

    if (this.loadingOrders) return this.loadingOrders;

    this.loadingOrders = this.fetchOrders(options);

    try {
      return await this.loadingOrders;
    } finally {
      this.loadingOrders = null;
    }
  },

  async fetchOrders() {
    const raw = await listAllOrders();
    const allOrders = raw.map(toViewOrder);

    const pending = allOrders.filter((order) => order.status === 'pending');
    const pendingIds = {};
    pending.forEach((order) => {
      pendingIds[order._id] = true;
    });

    // 第一次加载时把当前待接单都当作新订单提醒一次；
    // 之后只提醒上次没见过的订单 id
    const newOrders = this.ordersLoaded
      ? pending.filter((order) => !this.knownPendingIds[order._id])
      : pending;

    this.knownPendingIds = pendingIds;
    this.ordersLoaded = true;

    const nextData = { allOrders, loading: false };

    if (pending.length === 0) {
      nextData.newOrderTip = false;
    }

    if (newOrders.length > 0) {
      nextData.newOrderTip = true;
      nextData.newOrderTipText =
        newOrders.length > 1
          ? `有 ${newOrders.length} 个新订单，请及时接单`
          : '有新订单，请及时接单';
    }

    this.setData(nextData, () => {
      this.applyFilter(this.data.activeTab);

      if (newOrders.length > 0 && this.pageVisible) {
        this.playAlert(nextData.newOrderTipText);
      }
    });
  },

  // ==================== 新订单提醒 ====================
  startPolling() {
    this.stopPolling();

    this.pollTimer = setInterval(() => {
      if (!this.pageVisible || !this.data.isAdmin) return;

      this.loadOrders({ silent: true }).catch((e) => {
        console.warn('自动刷新订单失败', e);
      });
    }, POLL_INTERVAL);
  },

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  stopAudio() {
    if (!this.audio) return;

    try {
      this.audio.stop();
    } catch (e) {
      // 忽略停止失败
    }
  },

  // 震动 + 提示音 + 顶部提示条
  playAlert(text) {
    const title = text || '有新订单，请及时接单';

    wx.showToast({
      title,
      icon: 'none',
      duration: 3000,
    });

    if (wx.vibrateLong) {
      wx.vibrateLong({ fail: () => {} });
    }

    try {
      if (!this.audio && wx.createInnerAudioContext) {
        this.audio = wx.createInnerAudioContext();
        // 代码包内的音频要用相对路径（不要以 / 开头）
        this.audio.src = 'audio/new-order.wav';
        this.audio.volume = 1;
        // iOS 上静音键打开时也尽量播放提示音
        this.audio.obeyMuteSwitch = false;
        this.audio.onError((err) => {
          console.warn('新订单提示音播放失败', err);
        });
      }

      if (this.audio) {
        this.audio.stop();
        this.audio.play();
      }
    } catch (e) {
      console.warn('新订单提示音播放失败', e);
    }
  },

  onTestAlert() {
    this.playAlert('测试提醒：声音和震动已触发');
  },

  onNewOrderTipTap() {
    this.setData({ newOrderTip: false }, () => {
      this.applyFilter('pending');
      wx.pageScrollTo({ scrollTop: 0, duration: 200 });
    });
  },

  // 按 tab 过滤，同时更新每个 tab 上的数量
  applyFilter(tabKey) {
    const all = this.data.allOrders;

    const counts = {
      pending: all.filter((order) => order.status === 'pending').length,
      active: all.filter((order) => isActiveStatus(order.status)).length,
      completed: all.filter((order) => isCompletedStatus(order.status)).length,
      all: all.length,
    };

    let orders = all;

    if (tabKey === 'pending') {
      orders = all.filter((order) => order.status === 'pending');
    } else if (tabKey === 'active') {
      orders = all.filter((order) => isActiveStatus(order.status));
    } else if (tabKey === 'completed') {
      orders = all.filter((order) => isCompletedStatus(order.status));
    }

    this.setData({
      activeTab: tabKey,
      orders,
      pendingCount: counts.pending,
      tabs: TAB_LIST.map((tab) => ({
        ...tab,
        count: counts[tab.key] || 0,
      })),
    });
  },

  onTab(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.activeTab) return;

    if (key === 'pending' && this.data.newOrderTip) {
      this.setData({ newOrderTip: false });
    }

    this.applyFilter(key);
  },

  onRefresh() {
    this.loadPage().then(() => {
      wx.showToast({ title: '已刷新', icon: 'none' });
    });
  },

  // ==================== 状态变更 ====================
  onAccept(e) {
    return this.changeStatus(e.currentTarget.dataset.id, 'making');
  },

  onDeliver(e) {
    return this.changeStatus(e.currentTarget.dataset.id, 'delivering');
  },

  onComplete(e) {
    const dbId = e.currentTarget.dataset.id;

    wx.showModal({
      title: '完成订单',
      content: '确认已经送达并完成这笔订单吗？',
      confirmText: '确认完成',
      confirmColor: '#2b8a3e',
      success: (res) => {
        if (res.confirm) this.changeStatus(dbId, 'completed');
      },
    });
  },

  onCancel(e) {
    const dbId = e.currentTarget.dataset.id;

    wx.showModal({
      title: '取消订单',
      content: '取消后订单会保留在「全部」里，用掉的优惠券会退回给顾客。确定取消吗？',
      confirmText: '取消订单',
      confirmColor: '#c0392b',
      success: (res) => {
        if (res.confirm) this.changeStatus(dbId, 'cancelled');
      },
    });
  },

  async changeStatus(dbId, status) {
    if (!dbId || this.data.updatingId) return;

    const successText = {
      making: '已接单',
      delivering: '已出发',
      completed: '已完成',
      cancelled: '已取消',
    };

    this.setData({ updatingId: dbId });

    try {
      await updateOrderStatus(dbId, status);
      await this.loadOrders({ force: true });
      wx.showToast({
        title: successText[status] || '已更新',
        icon: 'success',
      });
    } catch (e) {
      console.error('修改订单状态失败', e);
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ updatingId: '' });
    }
  },

  // ==================== 其他操作 ====================
  onCall(e) {
    const phone = e.currentTarget.dataset.phone;
    if (!phone) return;

    wx.makePhoneCall({
      phoneNumber: phone,
      fail: () => {},
    });
  },

  onOpenCoupons() {
    wx.navigateTo({
      url: '/pages/adminCoupons/adminCoupons',
    });
  },

  onOpenDishes() {
    wx.navigateTo({
      url: '/pages/adminDishes/adminDishes',
    });
  },

  onCopyOpenid() {
    if (!this.data.openid) {
      wx.showToast({ title: '暂未获取到 openid', icon: 'none' });
      return;
    }

    wx.setClipboardData({
      data: this.data.openid,
      success: () => {
        wx.showToast({ title: '已复制 openid', icon: 'success' });
      },
    });
  },
});
