// pages/adminCoupons/adminCoupons.js —— 商家发券
// 需要先在云数据库 config 集合的 admin 文档里配置商家 openid
const {
  isCloudEnabled,
  checkAdmin,
  listCouponTemplates,
  saveCouponTemplate,
  issueCoupon,
  listUsers,
} = require('../../services/cloud.js');

Page({
  data: {
    loading: true,
    cloudEnabled: false,
    isAdmin: false,
    openid: '',

    templates: [],
    users: [],

    editing: false,
    form: {
      couponId: '',
      name: '',
      threshold: '',
      discount: '',
      autoIssue: false,
      onlyFirstOrder: false,
      enabled: true,
    },

    selectedTemplateId: '',
    issueOpenid: '',
    saving: false,
    issuing: false,
  },

  onShow() {
    this.loadPage();
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
        loading: false,
        cloudEnabled: true,
        isAdmin: admin.isAdmin,
        openid: admin.openid,
      });

      if (admin.isAdmin) {
        await this.loadTemplates();
        await this.loadUsers();
      }
    } catch (e) {
      console.error('商家页加载失败', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  async loadTemplates() {
    try {
      const templates = await listCouponTemplates();

      // 默认选中「新人首单券」，没有就选第一张
      const exists = templates.some(
        (t) => t.couponId === this.data.selectedTemplateId
      );
      let selectedTemplateId = exists
        ? this.data.selectedTemplateId
        : '';

      if (!selectedTemplateId && templates.length > 0) {
        const defaultTpl =
          templates.find((t) => t.couponId === 'new_user_50_5') ||
          templates[0];
        selectedTemplateId = defaultTpl.couponId;
      }

      this.setData({ templates, selectedTemplateId });
    } catch (e) {
      console.error('优惠券模板加载失败', e);
      wx.showToast({ title: e.message || '加载失败', icon: 'none' });
    }
  },

  async loadUsers() {
    try {
      const users = await listUsers();
      this.setData({ users });
    } catch (e) {
      console.error('用户列表加载失败', e);
    }
  },

  // 没有商家权限时，方便复制 openid 去云数据库配置
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

  // 返回订单管理页；如果是直接进入本页，就重定向过去
  onOpenOrders() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }

    wx.redirectTo({
      url: '/pages/adminOrders/adminOrders',
    });
  },

  // ==================== 表单 ====================
  onNameInput(e) {
    this.setData({ form: { ...this.data.form, name: e.detail.value } });
  },

  onThresholdInput(e) {
    this.setData({ form: { ...this.data.form, threshold: e.detail.value } });
  },

  onDiscountInput(e) {
    this.setData({ form: { ...this.data.form, discount: e.detail.value } });
  },

  onAutoIssueChange(e) {
    this.setData({ form: { ...this.data.form, autoIssue: e.detail.value } });
  },

  onOnlyFirstOrderChange(e) {
    this.setData({
      form: { ...this.data.form, onlyFirstOrder: e.detail.value },
    });
  },

  onEnabledChange(e) {
    this.setData({ form: { ...this.data.form, enabled: e.detail.value } });
  },

  onNewCoupon() {
    this.setData({
      editing: false,
      form: {
        couponId: '',
        name: '',
        threshold: '',
        discount: '',
        autoIssue: false,
        onlyFirstOrder: false,
        enabled: true,
      },
    });
  },

  onEditCoupon(e) {
    const couponId = e.currentTarget.dataset.id;
    const tpl = this.data.templates.find((t) => t.couponId === couponId);
    if (!tpl) return;

    this.setData({
      editing: true,
      form: {
        couponId: tpl.couponId,
        name: tpl.name,
        threshold: String(tpl.threshold),
        discount: String(tpl.discount),
        autoIssue: tpl.autoIssue === 'newUser',
        onlyFirstOrder: !!tpl.onlyFirstOrder,
        enabled: tpl.enabled !== false,
      },
    });
  },

  async onSaveCoupon() {
    if (this.data.saving) return;

    const form = this.data.form;
    const name = form.name.trim();
    const threshold = Number(form.threshold);
    const discount = Number(form.discount);

    if (!name) {
      wx.showToast({ title: '请填写优惠券名称', icon: 'none' });
      return;
    }

    if (!(threshold > 0)) {
      wx.showToast({ title: '门槛金额要大于 0', icon: 'none' });
      return;
    }

    if (!(discount > 0)) {
      wx.showToast({ title: '优惠金额要大于 0', icon: 'none' });
      return;
    }

    this.setData({ saving: true });

    try {
      const result = await saveCouponTemplate({
        couponId: form.couponId || '',
        name,
        threshold,
        discount,
        autoIssue: form.autoIssue ? 'newUser' : 'manual',
        onlyFirstOrder: form.onlyFirstOrder,
        enabled: form.enabled,
      });

      await this.loadTemplates();

      this.setData({
        saving: false,
        editing: true,
        form: { ...this.data.form, couponId: result.couponId },
      });

      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      console.error('保存优惠券失败', e);
      this.setData({ saving: false });
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  async onToggleEnabled(e) {
    const couponId = e.currentTarget.dataset.id;
    const tpl = this.data.templates.find((t) => t.couponId === couponId);
    if (!tpl) return;

    try {
      await saveCouponTemplate({
        ...tpl,
        enabled: !tpl.enabled,
      });

      await this.loadTemplates();

      wx.showToast({
        title: tpl.enabled ? '已停用' : '已启用',
        icon: 'none',
      });
    } catch (err) {
      console.error('切换优惠券状态失败', err);
      wx.showToast({ title: err.message || '操作失败', icon: 'none' });
    }
  },

  // ==================== 发放 ====================
  onSelectTemplate(e) {
    this.setData({ selectedTemplateId: e.currentTarget.dataset.id });
  },

  onIssueOpenidInput(e) {
    this.setData({ issueOpenid: e.detail.value });
  },

  onPickUser(e) {
    this.setData({ issueOpenid: e.currentTarget.dataset.openid || '' });
  },

  async onIssueToUser() {
    if (this.data.issuing) return;

    const couponId = this.data.selectedTemplateId;
    const openid = this.data.issueOpenid.trim();

    if (!couponId) {
      wx.showToast({ title: '请先选择一张优惠券', icon: 'none' });
      return;
    }

    if (!openid) {
      wx.showToast({ title: '请填写用户 openid', icon: 'none' });
      return;
    }

    this.setData({ issuing: true });

    try {
      const result = await issueCoupon(couponId, openid);
      this.setData({ issuing: false });

      wx.showToast({
        title: `已发放 ${result.issued} 张`,
        icon: 'none',
      });
    } catch (e) {
      console.error('发放优惠券失败', e);
      this.setData({ issuing: false });
      wx.showToast({ title: e.message || '发放失败', icon: 'none' });
    }
  },

  onIssueToAll() {
    if (this.data.issuing) return;

    const couponId = this.data.selectedTemplateId;

    if (!couponId) {
      wx.showToast({ title: '请先选择一张优惠券', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '发给全部用户',
      content: '会给 users 集合里的所有用户各发一张，确定吗？',
      confirmText: '发放',
      confirmColor: '#e8590c',
      success: async (res) => {
        if (!res.confirm) return;

        this.setData({ issuing: true });

        try {
          const result = await issueCoupon(couponId, '');
          this.setData({ issuing: false });

          wx.showToast({
            title: `已发放 ${result.issued} 张`,
            icon: 'none',
          });
        } catch (e) {
          console.error('批量发券失败', e);
          this.setData({ issuing: false });
          wx.showToast({ title: e.message || '发放失败', icon: 'none' });
        }
      },
    });
  },
});
