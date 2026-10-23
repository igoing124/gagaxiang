// pages/profile/profile.js ——「我的」页：微信登录、历史订单、下单总额
// 注意：这是一个纯本地 Demo，没有后端。
// wx.login 只能确认微信登录调用成功，拿到的 code 不会发给服务器；
// 登录状态、头像和订单都保存在本机，换手机或清缓存后不会同步。
const {
  toViewOrder,
  sumTotal,
} = require('../../utils/order.js');
const {
  listOrders,
  listCoupons,
  saveUserProfile,
  checkAdmin,
} = require('../../services/cloud.js');

// 本地存储里保存登录用户的 key
const LOGIN_KEY = 'loginUser';

Page({
  data: {
    loaded: false, // 是否已经读取过本地数据（避免登录卡片闪一下）
    loggedIn: false, // 是否已登录
    settingUp: false, // 是否正在设置头像昵称
    loggingIn: false, // 防止重复点「微信登录」
    completing: false, // 防止重复点「完成登录」
    changingAvatar: false, // 已登录后更换头像时防止重复点击
    user: null, // { nickName, avatarUrl, loginAt }
    draftNickName: '', // 设置资料时的昵称草稿
    draftAvatarPath: '', // 设置资料时的头像临时路径
    avatarChanged: false, // 这次是否重新选了头像
    recentOrders: [], // 最近 5 笔订单
    orderCount: 0, // 历史订单总数
    totalSpent: 0, // 下单总额（未在线收款，按订单金额累计）
    coupons: [], // 我的优惠券
    store: null, // 门店信息，onLoad 时从 app.globalData 读取
    showAdminEntry: false, // 只有商家（或还没配置商家时）才显示商家入口
  },

  // onLoad：门店信息是静态数据，从全局数据复制一次
  onLoad() {
    this.setData({
      store: getApp().globalData.store,
    });
  },

  // 每次页面显示都刷新登录状态和订单统计
  onShow() {
    // 正在设置头像昵称时不能刷新：打开相册/相机也可能触发 onShow，
    // 这里如果重置数据，设置卡片和草稿会消失。
    if (this.data.settingUp) return;

    this.loadProfile();
  },

  // 读取登录状态和订单，算出「我的」页要显示的数据
  async loadProfile() {
    const user = wx.getStorageSync(LOGIN_KEY);

    // 没有登录，或者登录数据不完整：显示登录卡片
    if (!user || !user.nickName) {
      this.setData({
        loaded: true,
        loggedIn: false,
        user: null,
        recentOrders: [],
        orderCount: 0,
        totalSpent: 0,
        coupons: [],
        showAdminEntry: false,
      });
      return;
    }

    let orders = [];
    let coupons = [];

    try {
      orders = await listOrders();
    } catch (e) {
      console.error('订单加载失败', e);
    }

    try {
      coupons = await listCoupons();
    } catch (e) {
      console.error('优惠券加载失败', e);
    }

    this.setData({
      loaded: true,
      loggedIn: true,
      user,
      // 最近订单只展示 5 笔，完整列表去「管理订单」看
      recentOrders: orders.slice(0, 5).map(toViewOrder),
      // 统计必须用全量订单计算，不能用 recentOrders
      orderCount: orders.length,
      totalSpent: sumTotal(orders),
      coupons,
    });

    // 商家入口单独判断：普通顾客不显示
    this.loadAdminEntry();
  },

  // 只有管理员能看到商家入口；还没配置任何管理员时先显示，方便首次配置
  async loadAdminEntry() {
    try {
      const admin = await checkAdmin();

      // 检查期间可能已经退出登录，避免退出后又冒出商家入口
      const user = wx.getStorageSync(LOGIN_KEY);
      if (!user || !user.nickName) {
        this.setData({ showAdminEntry: false });
        return;
      }

      this.setData({
        showAdminEntry:
          admin.cloudEnabled && (admin.isAdmin || !admin.hasAdmin),
      });
    } catch (e) {
      console.error('商家权限检查失败', e);
      this.setData({ showAdminEntry: false });
    }
  },

  // 点「微信一键登录」
  onLogin() {
    if (this.data.loggingIn) return;
    this.setData({ loggingIn: true });

    wx.login({
      // 用 complete：不管成功失败都进入设置资料。
      // 这是本地演示，没有后端，login 的 code 不会被使用。
      complete: (res) => {
        const failed =
          res && res.errMsg && res.errMsg.indexOf('fail') !== -1;

        this.setData({
          loggingIn: false,
          settingUp: true,
          // 微信用昵称输入框获取，这里不预填假名字
          draftNickName: '',
          draftAvatarPath: '',
          avatarChanged: false,
        });

        if (failed) {
          wx.showToast({
            title: '微信登录不可用，使用本地身份',
            icon: 'none',
          });
        }
      },
    });
  },

  // 选择头像：先用 chooseMedia 拿到临时路径，点「完成登录」时再持久化
  onChooseAvatar() {
    // 正在保存登录信息时不要再打开相册
    if (this.data.completing) return;

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;

        this.setData({
          draftAvatarPath: file.tempFilePath,
          avatarChanged: true,
        });
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';

        // 用户点「取消」时不用提示
        if (msg.indexOf('cancel') !== -1) return;

        wx.showToast({
          title: '选择头像失败',
          icon: 'none',
        });
      },
    });
  },

  // 昵称输入
  onNicknameInput(e) {
    this.setData({ draftNickName: e.detail.value });
  },

  // 不选头像，使用默认的 🍗
  onResetAvatar() {
    this.setData({
      draftAvatarPath: '',
      avatarChanged: false,
    });
  },

  // 草稿头像加载失败（比如临时文件被系统清理）
  onDraftAvatarError() {
    this.setData({
      draftAvatarPath: '',
      avatarChanged: false,
    });
  },

  // 已登录头像加载失败：清掉路径，显示默认头像
  onAvatarError() {
    const user = this.data.user;
    if (!user) return;

    const nextUser = { ...user, avatarUrl: '' };
    wx.setStorageSync(LOGIN_KEY, nextUser);
    this.setData({ user: nextUser });
  },

  // 已登录后更换头像：昵称保持不变
  onChangeAvatar() {
    if (this.data.changingAvatar || this.data.completing) return;

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (!file) return;

        this.saveAvatar(file.tempFilePath);
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || '';

        if (msg.indexOf('cancel') !== -1) return;

        wx.showToast({
          title: '选择头像失败',
          icon: 'none',
        });
      },
    });
  },

  // 把新头像保存到本地，只更新 avatarUrl，不动 nickName
  saveAvatar(tempFilePath) {
    this.setData({ changingAvatar: true });

    const finish = (savedFilePath) => {
      const user = this.data.user;

      // 如果期间已经退出登录，就不要再把用户写回去
      if (!user) {
        this.setData({ changingAvatar: false });
        return;
      }

      const oldAvatarUrl = user.avatarUrl;
      const nextUser = { ...user, avatarUrl: savedFilePath };

      wx.setStorageSync(LOGIN_KEY, nextUser);
      this.setData({ user: nextUser, changingAvatar: false });

      // 删掉旧头像文件，失败也不影响使用
      if (oldAvatarUrl && oldAvatarUrl !== savedFilePath) {
        try {
          wx.getFileSystemManager().removeSavedFile({
            filePath: oldAvatarUrl,
            fail: () => {},
          });
        } catch (e) {
          // 忽略清理失败
        }
      }

      wx.showToast({
        title: '头像已更新',
        icon: 'success',
      });
    };

    try {
      wx.getFileSystemManager().saveFile({
        tempFilePath,
        success: (res) => {
          if (!res.savedFilePath) {
            this.setData({ changingAvatar: false });
            wx.showToast({
              title: '头像保存失败',
              icon: 'none',
            });
            return;
          }
          finish(res.savedFilePath);
        },
        fail: () => {
          this.setData({ changingAvatar: false });
          wx.showToast({
            title: '头像保存失败',
            icon: 'none',
          });
        },
      });
    } catch (e) {
      this.setData({ changingAvatar: false });
      wx.showToast({
        title: '头像保存失败',
        icon: 'none',
      });
    }
  },

  // 点「完成登录」：保存头像、昵称，然后刷新订单统计
  onCompleteSetup() {
    if (this.data.completing) return;

    const nickName = this.data.draftNickName.trim();
    if (!nickName) {
      wx.showToast({
        title: '请先点击输入框选择微信昵称',
        icon: 'none',
      });
      return;
    }

    this.setData({ completing: true });

    // 把登录信息存到本地，然后刷新页面
    const saveUser = (avatarUrl) => {
      const user = {
        nickName,
        avatarUrl,
        loginAt: Date.now(),
      };

      wx.setStorageSync(LOGIN_KEY, user);

      // 云端 users 集合同步昵称，商家发券时方便认人
      saveUserProfile(nickName);

      this.setData({
        completing: false,
        settingUp: false,
        loggedIn: true,
        user,
        draftNickName: '',
        draftAvatarPath: '',
        avatarChanged: false,
      });

      this.loadProfile();

      wx.showToast({
        title: '登录成功',
        icon: 'success',
      });
    };

    // 只有重新选过头像才需要保存；保存失败就回退到默认头像，
    // 不能把临时路径存起来，因为小程序重启后临时文件会失效。
    if (this.data.avatarChanged && this.data.draftAvatarPath) {
      try {
        wx.getFileSystemManager().saveFile({
          tempFilePath: this.data.draftAvatarPath,
          success: (res) => {
            saveUser(res.savedFilePath || '');
          },
          fail: () => {
            saveUser('');
          },
        });
      } catch (e) {
        // 文件系统不可用时也不要卡在「登录中...」
        saveUser('');
      }
    } else {
      saveUser('');
    }
  },

  // 取消设置资料，回到登录卡片
  onCancelSetup() {
    // 正在保存时不允许取消，避免保存回调完成后又突然变成已登录
    if (this.data.completing) return;

    this.setData({
      settingUp: false,
      draftNickName: '',
      draftAvatarPath: '',
      avatarChanged: false,
    });
  },

  // 退出登录：只删除登录信息，订单要保留
  onLogout() {
    // 头像还在保存时先别退出，避免文件保存回调与退出操作打架
    if (this.data.changingAvatar) {
      wx.showToast({
        title: '正在更新头像，请稍候',
        icon: 'none',
      });
      return;
    }

    wx.showModal({
      title: '退出登录',
      content: '退出后订单仍会保留在本机，确定退出吗？',
      confirmText: '退出',
      confirmColor: '#e8590c',
      success: (res) => {
        if (!res.confirm) return;

        const avatarUrl = this.data.user && this.data.user.avatarUrl;

        // 顺手清理保存过的头像文件，失败也不影响退出
        if (avatarUrl) {
          try {
            wx.getFileSystemManager().removeSavedFile({
              filePath: avatarUrl,
              fail: () => {},
            });
          } catch (e) {
            // 文件系统不可用时忽略，不能因为清理头像导致退不出去
          }
        }

        // 只删登录信息，绝对不能用 clearStorageSync，否则订单也没了
        wx.removeStorageSync(LOGIN_KEY);

        this.setData({
          loggedIn: false,
          settingUp: false,
          user: null,
          draftNickName: '',
          draftAvatarPath: '',
          avatarChanged: false,
          recentOrders: [],
          orderCount: 0,
          totalSpent: 0,
          coupons: [],
          showAdminEntry: false,
        });

        wx.showToast({
          title: '已退出登录',
          icon: 'none',
        });
      },
    });
  },

  // 一键拨号（开发者工具可能无法真正拨号，需要真机验证）
  onCall() {
    const store = this.data.store;

    if (!store || !store.phone) {
      wx.showToast({
        title: '暂无联系电话',
        icon: 'none',
      });
      return;
    }

    wx.makePhoneCall({
      phoneNumber: store.phone,
      fail: (err) => {
        const msg = (err && err.errMsg) || '';

        // 用户点「取消」也会进入 fail，这种情况不需要提示
        if (msg.indexOf('cancel') !== -1) return;

        wx.showToast({
          title: '拨号失败',
          icon: 'none',
        });
      },
    });
  },

  // 页面里的分享按钮和右上角转发都会调用这里
  onShareAppMessage() {
    return {
      title: '嘎嘎香 · 乐山油炸串串，越吃越巴适',
      path: '/pages/index/index',
    };
  },

  // 商家入口：订单管理 + 优惠券，权限在页面里检查
  onAdminEntry() {
    wx.navigateTo({
      url: '/pages/adminOrders/adminOrders',
    });
  },

  // 去完整的订单管理页（删除、清空、再来一单）
  onManageOrders() {
    wx.navigateTo({
      url: '/pages/orders/orders',
    });
  },

  // 没有订单时，去点单页
  onGoOrder() {
    wx.switchTab({
      url: '/pages/index/index',
    });
  },
});
