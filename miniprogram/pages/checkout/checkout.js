// pages/checkout/checkout.js —— 确认订单（配送）页
// Vant 的 Dialog 是 CommonJS 模块，所以取 .default
const Dialog = require('@vant/weapp/dialog/dialog').default;
const { roundMoney } = require('../../utils/order.js');
const {
  getCachedAddress,
  getAddress,
  saveAddress,
  createOrder,
  listCoupons,
  listDishes,
} = require('../../services/cloud.js');

Page({
  data: {
    list: [], // 购物车里的商品（带 count 和 subtotal）
    cartCount: 0,
    totalPrice: 0,
    remark: '',
    submitting: false, // 防止连点提交

    // 配送信息
    store: null,
    receiverName: '',
    receiverPhone: '',
    address: '',
    deliveryFee: 0,
    freeDeliveryThreshold: 50,
    freeDeliveryGap: 0,

    // 优惠券
    coupons: [],
    selectedCouponId: '',
    couponUsed: false,
    discount: 0,

    payablePrice: 0,
    payablePriceFen: 0,
    tipText: '',
    menuLoading: true,
  },

  // onLoad：读取门店配送配置和上次保存的收货地址
  async onLoad() {
    const store = getApp().globalData.store;
    const cached = getCachedAddress() || {};

    this.dishes = [];
    this.dishesLoaded = false;

    this.setData({
      store,
      receiverName: cached.name || '',
      receiverPhone: cached.phone || '',
      address: cached.address || '',
      freeDeliveryThreshold: store.freeDeliveryThreshold,
    });

    // 先加载菜单，才能把购物车 id 转成商品信息
    await this.loadDishes();

    // 云端有更新的地址时再补进来（用户已经开始输入的字段不覆盖）
    this.loadSavedAddress();
  },

  // 加载菜单；购物车里已经不在菜单中的旧菜品会在 refreshCart 里自动忽略
  async loadDishes() {
    let dishes = [];

    try {
      dishes = await listDishes();
    } catch (e) {
      console.error('菜单加载失败', e);
    }

    this.dishes = Array.isArray(dishes) ? dishes : [];

    this.dishesLoaded = true;
    this.setData({ menuLoading: false });
    this.refreshCart();
    this.loadCoupons();
  },

  async loadSavedAddress() {
    try {
      const saved = await getAddress();
      if (!saved) return;

      this.setData({
        receiverName: this.data.receiverName || saved.name || '',
        receiverPhone: this.data.receiverPhone || saved.phone || '',
        address: this.data.address || saved.address || '',
      });
    } catch (e) {
      console.warn('读取收货地址失败', e);
    }
  },

  // 每次页面显示都重新读购物车和优惠券（首次进入时菜单还在加载）
  onShow() {
    if (!this.dishesLoaded) return;
    this.refreshCart();
    this.loadCoupons();
  },

  // 读取当前用户可用的优惠券
  async loadCoupons() {
    try {
      const coupons = await listCoupons();
      this.setData({ coupons });
      this.refreshCart();
    } catch (e) {
      console.error('优惠券加载失败', e);
      this.setData({ coupons: [] });
      this.refreshCart();
    }
  },

  // 把全局购物车整理成页面要显示的数据
  refreshCart() {
    if (!this.dishesLoaded) return;

    const cart = getApp().globalData.cart;
    const store = this.data.store || getApp().globalData.store;

    // 只保留数量大于 0 的商品，并算出每项小计
    const list = this.dishes
      .filter((g) => (cart[g.id] || 0) > 0)
      .map((g) => {
        const count = cart[g.id];
        return {
          ...g,
          count,
          subtotal: roundMoney(count * g.price),
        };
      });

    let cartCount = 0;
    let totalPrice = 0;
    list.forEach((g) => {
      cartCount += g.count;
      totalPrice += g.subtotal;
    });
    totalPrice = roundMoney(totalPrice);

    // 配送费：商品金额达到免配送门槛就不收
    const deliveryFee =
      totalPrice >= store.freeDeliveryThreshold ? 0 : store.deliveryFee;
    const freeDeliveryGap = roundMoney(
      Math.max(0, store.freeDeliveryThreshold - totalPrice)
    );

    // 根据当前购物车金额，更新每张优惠券是否可用
    const coupons = this.data.coupons.map((c) => {
      const threshold = Number(c.threshold) || 0;
      const minSpendOk = totalPrice >= threshold;

      return {
        ...c,
        minSpendOk,
        gap: roundMoney(Math.max(0, threshold - totalPrice)),
        eligible: minSpendOk && !c.blockedByFirstOrder,
      };
    });

    const selected = coupons.find(
      (c) => c.id === this.data.selectedCouponId
    );
    const selectedEligible = selected && selected.eligible;
    const selectedCouponId = selectedEligible ? selected.id : '';
    const discount = selectedEligible
      ? roundMoney(selected.discount)
      : 0;
    const couponUsed = selectedEligible;

    const payablePrice = roundMoney(
      Math.max(0, totalPrice + deliveryFee - discount)
    );
    const payablePriceFen = Math.round(payablePrice * 100);

    const tipParts = [`共 ${cartCount} 份`];
    tipParts.push(deliveryFee > 0 ? `配送费 ¥${deliveryFee}` : '免配送费');
    if (discount > 0) tipParts.push(`已优惠 ¥${discount}`);

    this.setData({
      list,
      cartCount,
      totalPrice,
      deliveryFee,
      freeDeliveryGap,
      coupons,
      selectedCouponId,
      couponUsed,
      discount,
      payablePrice,
      payablePriceFen,
      tipText: tipParts.join(' · '),
    });
  },

  // 选择 / 取消优惠券
  onSelectCoupon(e) {
    const id = e.currentTarget.dataset.id;
    const coupon = this.data.coupons.find((c) => c.id === id);
    if (!coupon) return;

    if (coupon.blockedByFirstOrder) {
      wx.showToast({ title: '这张券仅限首单使用', icon: 'none' });
      return;
    }

    if (!coupon.minSpendOk) {
      wx.showToast({
        title: `还差 ¥${coupon.gap} 可用`,
        icon: 'none',
      });
      return;
    }

    this.setData({
      selectedCouponId: this.data.selectedCouponId === id ? '' : id,
    });
    this.refreshCart();
  },

  // 收货人
  onReceiverNameInput(e) {
    this.setData({ receiverName: e.detail.value });
  },

  // 手机号
  onReceiverPhoneInput(e) {
    this.setData({ receiverPhone: e.detail.value });
  },

  // 收货地址
  onAddressInput(e) {
    this.setData({ address: e.detail.value });
  },

  // Vant Stepper 数量变化：e.detail 就是新的数量
  onStepperChange(e) {
    const id = e.currentTarget.dataset.id;
    const value = e.detail;
    const cart = getApp().globalData.cart;

    if (value > 0) {
      cart[id] = value;
    } else {
      delete cart[id];
    }

    this.refreshCart();
  },

  // 备注输入
  onRemarkInput(e) {
    this.setData({ remark: e.detail.value });
  },

  // 校验配送信息，通过时返回整理后的值
  validateDelivery() {
    const name = this.data.receiverName.trim();
    const phone = this.data.receiverPhone.trim();
    const address = this.data.address.trim();

    if (!name) {
      wx.showToast({ title: '请填写收货人', icon: 'none' });
      return null;
    }

    if (!/^\d{11}$/.test(phone)) {
      wx.showToast({ title: '请填写 11 位手机号', icon: 'none' });
      return null;
    }

    if (!address) {
      wx.showToast({ title: '请填写收货地址', icon: 'none' });
      return null;
    }

    return { name, phone, address };
  },

  // 点「提交订单」：先校验配送信息，再用 Vant Dialog 二次确认
  onSubmit() {
    if (this.data.cartCount === 0) {
      wx.showToast({ title: '购物车是空的', icon: 'none' });
      return;
    }

    const receiver = this.validateDelivery();
    if (!receiver) return;

    if (this.data.submitting) return;

    const discountText =
      this.data.discount > 0 ? `，已优惠 ¥${this.data.discount}` : '';

    Dialog.confirm({
      title: '确认下单',
      message: `送至 ${receiver.address}，共 ${this.data.cartCount} 份，订单金额 ¥${this.data.payablePrice}${discountText}，付款方式为线下支付。`,
      confirmButtonText: '确认下单',
      cancelButtonText: '再看看',
      confirmButtonColor: '#ff7a00',
    })
      .then(() => {
        this.doSubmit();
      })
      .catch(() => {
        // 用户点了「再看看」，什么都不做
      });
  },

  // 真正提交订单
  async doSubmit() {
    if (this.data.submitting) return;

    const receiver = this.validateDelivery();
    if (!receiver) return;

    this.setData({ submitting: true });

    const now = new Date();
    const pad = (n) => (n < 10 ? '0' + n : '' + n);

    // 本地演示模式用的临时订单号；云端下单时由云函数重新生成
    const orderId =
      'YZ' +
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds()) +
      pad(now.getMilliseconds()) +
      (Math.floor(Math.random() * 90) + 10);

    const selectedCoupon = this.data.coupons.find(
      (c) => c.id === this.data.selectedCouponId
    );
    const userCouponId =
      this.data.couponUsed && selectedCoupon ? selectedCoupon.id : '';
    const coupon = userCouponId
      ? {
          userCouponId,
          couponId: selectedCoupon.couponId,
          name: selectedCoupon.name,
          threshold: selectedCoupon.threshold,
          discount: this.data.discount,
        }
      : null;

    const order = {
      id: orderId,
      items: this.data.list.map((g) => ({
        id: g.id,
        name: g.name,
        price: g.price,
        count: g.count,
      })),
      cartCount: this.data.cartCount,
      totalPrice: roundMoney(this.data.totalPrice),
      discount: roundMoney(this.data.discount),
      payablePrice: roundMoney(this.data.payablePrice),
      userCouponId,
      coupon,
      deliveryType: 'delivery',
      receiverName: receiver.name,
      receiverPhone: receiver.phone,
      address: receiver.address,
      deliveryFee: roundMoney(this.data.deliveryFee),
      remark: this.data.remark.trim(),
      createdAt: now.getTime(),
      // 新订单等待商家接单；接单后由商家改成「制作中」
      status: 'pending',
    };

    try {
      // 云开发可用时写云数据库。正式使用模式不允许回退到本地，
      // 否则订单只存在顾客手机里，商家收不到。
      const created = await createOrder(order);

      // 地址本地缓存一份，云端可用时同步到云数据库
      await saveAddress({
        name: receiver.name,
        phone: receiver.phone,
        address: receiver.address,
      });

      // 云函数会重新生成唯一订单号；本地演示模式则沿用本地编号
      order.id = (created && created.id) || order.id;
    } catch (e) {
      console.error('提交订单失败', e);
      this.setData({ submitting: false });
      wx.showToast({
        title: (e && e.message) || '下单失败，请重试',
        icon: 'none',
      });
      return;
    }

    // 下单成功后清空购物车
    getApp().globalData.cart = {};

    // redirectTo：把结算页替换成成功页，返回时不会又回到结算页
    wx.redirectTo({
      url: `/pages/orderSuccess/orderSuccess?id=${order.id}`,
    });
  },

  // 返回点单页
  onBack() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
