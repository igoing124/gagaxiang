// app.js —— 整个小程序的「入口」，小程序里只有一个 App 实例
const { envList } = require('./envList.js');

App({
  // globalData 是全局共享的数据，任何页面都能用 getApp() 读写
  globalData: {
    shopName: '嘎嘎香 乐山油炸串串',
    // 购物车：键是商品 id，值是数量，例如 { wo_sun: 2, xia: 1 }
    cart: {},
    // 云开发是否可用：初始为 null，onLaunch 里用 Promise 决定
    // 没配置云环境或云函数调用失败时，页面会继续使用本地存储
    cloudReady: null,
    openid: '',
    // 正式使用时保持 true：云服务不可用就不允许下单，
    // 避免订单只存在顾客手机里、商家完全收不到。
    // 只做本地演示时可以改成 false。
    requireCloudForOrders: true,
    // 门店信息，「我的」页底部的门店卡片会用到
    // 注意：phone 只能写纯数字（拨号 API 不接受空格和横线），phoneText 只用于页面展示
    store: {
      hours: '每天 17:00 - 次日 00:30',
      phone: '15528775725',
      phoneText: '155 2877 5725',
      // 配送配置：配送费 3 元，商品满 50 元免配送费
      deliveryFee: 3,
      freeDeliveryThreshold: 50,
    },
  },

  // 生命周期：小程序启动时执行一次
  onLaunch() {
    console.log('嘎嘎香启动啦');

    let resolveReady;
    this.globalData.cloudReady = new Promise((resolve) => {
      resolveReady = resolve;
    });

    // cloudInited：只表示「云开发环境已经可用」，不等 login 云函数。
    // 菜单这类只读请求用它当门闸，首屏就不用排队等登录（登录要跑十几个数据库操作）。
    let resolveInited;
    this.globalData.cloudInited = new Promise((resolve) => {
      resolveInited = resolve;
    });

    // 没有配置云环境（envList 为空）时，直接使用本地存储模式
    if (!wx.cloud || !envList || envList.length === 0) {
      resolveInited(false);
      resolveReady(false);
      return;
    }

    // 初始化云开发，并用 login 云函数确认环境可用
    wx.cloud.init({
      env: envList[0],
      traceUser: true,
    });

    // wx.cloud.init 是同步配置，之后就能直接 callFunction，
    // 所以这里立刻放行，让菜单请求和登录请求并行跑。
    resolveInited(true);

    wx.cloud
      .callFunction({
        name: 'api',
        data: { action: 'login' },
      })
      .then(async (res) => {
        const openid = res && res.result && res.result.openid;
        if (!openid) throw new Error('云函数没有返回 openid');

        this.globalData.openid = openid;

        // 第一次连接时自动创建数据库集合和默认新人券
        // 失败也不阻塞，可能已经在云控制台手动建好了
        const initKey = 'cloudInitDone_' + envList[0];
        if (!wx.getStorageSync(initKey)) {
          try {
            await wx.cloud.callFunction({
              name: 'api',
              data: { action: 'init' },
            });
            wx.setStorageSync(initKey, true);
          } catch (e) {
            console.warn(
              '云数据库自动初始化失败，请手动创建数据库集合',
              e
            );
          }
        }

        resolveReady(true);
        console.log('云开发已连接');
      })
      .catch((err) => {
        // 常见原因：云函数 api 没上传部署、环境 ID 填错、云开发未开通
        console.error('云开发不可用，已回退到本地模式', err);
        resolveReady(false);
      });
  },
});
