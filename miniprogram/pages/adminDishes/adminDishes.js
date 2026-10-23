// pages/adminDishes/adminDishes.js —— 商家菜品管理
// 需要先在 config 集合的 admin 文档里配置商家 openid
const {
  isCloudEnabled,
  checkAdmin,
  adminListDishes,
  saveDish,
  toggleDish,
  seedDishes,
} = require('../../services/cloud.js');
const localGoods = require('../../data/goods.js');

function emptyForm(category) {
  return {
    id: '',
    name: '',
    category: category || '',
    price: '',
    unit: '份',
    desc: '',
    emoji: '🍢',
    tag: '',
    soldOut: false,
    enabled: true,
  };
}

Page({
  data: {
    loading: true,
    cloudEnabled: false,
    isAdmin: false,
    openid: '',

    dishes: [],
    visibleDishes: [],
    dishCategories: [],
    filterCategories: ['全部'],
    filterCategory: '全部',

    formVisible: false,
    editing: false,
    saving: false,
    updatingId: '',
    seeding: false,
    localDishCount: localGoods.length,

    form: emptyForm(''),
  },

  onShow() {
    this.loadPage();
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

      await this.loadDishes();
    } catch (e) {
      console.error('菜品管理加载失败', e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
  },

  async loadDishes() {
    const dishes = await adminListDishes();

    const dishCategories = Array.from(
      new Set(dishes.map((dish) => dish.category).filter(Boolean))
    );

    let filterCategory = this.data.filterCategory;
    if (
      filterCategory !== '全部' &&
      dishCategories.indexOf(filterCategory) === -1
    ) {
      filterCategory = '全部';
    }

    this.setData(
      {
        dishes,
        dishCategories,
        filterCategories: ['全部'].concat(dishCategories),
        filterCategory,
        loading: false,
      },
      () => this.applyFilter()
    );
  },

  applyFilter() {
    const { dishes, filterCategory } = this.data;

    this.setData({
      visibleDishes:
        filterCategory === '全部'
          ? dishes
          : dishes.filter((dish) => dish.category === filterCategory),
    });
  },

  onFilterCategory(e) {
    const category = e.currentTarget.dataset.category;
    if (!category || category === this.data.filterCategory) return;

    this.setData({ filterCategory: category }, () => this.applyFilter());
  },

  // ==================== 新增 / 编辑 ====================
  onNewDish() {
    const defaultCategory =
      this.data.filterCategory !== '全部'
        ? this.data.filterCategory
        : this.data.dishCategories[0] || '';

    this.setData({
      formVisible: true,
      editing: false,
      form: emptyForm(defaultCategory),
    });
  },

  onEditDish(e) {
    const id = e.currentTarget.dataset.id;
    const dish = this.data.dishes.find((item) => item.id === id);
    if (!dish) return;

    this.setData({
      formVisible: true,
      editing: true,
      form: {
        id: dish.id,
        name: dish.name,
        category: dish.category,
        price: String(dish.price),
        unit: dish.unit,
        desc: dish.desc || '',
        emoji: dish.emoji || '🍢',
        tag: dish.tag || '',
        soldOut: !!dish.soldOut,
        enabled: dish.enabled !== false,
      },
    });
  },

  onCancelForm() {
    this.setData({
      formVisible: false,
      editing: false,
      saving: false,
    });
  },

  onNameInput(e) {
    this.setData({ form: { ...this.data.form, name: e.detail.value } });
  },

  onCategoryInput(e) {
    this.setData({ form: { ...this.data.form, category: e.detail.value } });
  },

  onFormCategory(e) {
    this.setData({
      form: { ...this.data.form, category: e.currentTarget.dataset.category },
    });
  },

  onPriceInput(e) {
    this.setData({ form: { ...this.data.form, price: e.detail.value } });
  },

  onUnitInput(e) {
    this.setData({ form: { ...this.data.form, unit: e.detail.value } });
  },

  onDescInput(e) {
    this.setData({ form: { ...this.data.form, desc: e.detail.value } });
  },

  onEmojiInput(e) {
    this.setData({ form: { ...this.data.form, emoji: e.detail.value } });
  },

  onTagInput(e) {
    this.setData({ form: { ...this.data.form, tag: e.detail.value } });
  },

  onSoldOutChange(e) {
    this.setData({ form: { ...this.data.form, soldOut: e.detail.value } });
  },

  onEnabledChange(e) {
    this.setData({ form: { ...this.data.form, enabled: e.detail.value } });
  },

  async onSaveDish() {
    if (this.data.saving) return;

    const form = this.data.form;
    const name = form.name.trim();
    const category = form.category.trim();
    const price = Number(form.price);

    if (!name) {
      wx.showToast({ title: '请填写菜品名称', icon: 'none' });
      return;
    }

    if (!category) {
      wx.showToast({ title: '请填写菜品分类', icon: 'none' });
      return;
    }

    if (!(price > 0)) {
      wx.showToast({ title: '价格要大于 0', icon: 'none' });
      return;
    }

    this.setData({ saving: true });

    try {
      await saveDish({
        id: form.id || '',
        name,
        category,
        price,
        unit: form.unit.trim() || '份',
        desc: form.desc.trim(),
        emoji: form.emoji.trim() || '🍢',
        tag: form.tag.trim(),
        soldOut: form.soldOut,
        enabled: form.enabled,
      });

      // 保存后切到这道菜所属的分类，方便马上看到结果
      this.setData({ filterCategory: category });
      await this.loadDishes();

      this.setData({
        saving: false,
        formVisible: false,
        editing: false,
      });

      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      console.error('保存菜品失败', e);
      this.setData({ saving: false });
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
    }
  },

  // ==================== 售罄 / 上下架 ====================
  async onToggleDish(e) {
    const id = e.currentTarget.dataset.id;
    const field = e.currentTarget.dataset.field;

    if (!id || this.data.updatingId) return;

    const dish = this.data.dishes.find((item) => item.id === id);
    if (!dish) return;

    const nextValue =
      field === 'soldOut' ? !dish.soldOut : dish.enabled === false;

    this.setData({ updatingId: id });

    try {
      await toggleDish(id, field, nextValue);
      await this.loadDishes();

      let title = '已更新';
      if (field === 'soldOut') {
        title = nextValue ? '已标售罄' : '已恢复';
      } else {
        title = nextValue ? '已上架' : '已下架';
      }

      wx.showToast({ title, icon: 'success' });
    } catch (e) {
      console.error('切换菜品状态失败', e);
      wx.showToast({ title: e.message || '操作失败', icon: 'none' });
    } finally {
      this.setData({ updatingId: '' });
    }
  },

  // ==================== 导入本地菜单 ====================
  onSeed() {
    if (this.data.seeding) return;

    wx.showModal({
      title: '导入本地菜单',
      content: `会把本地 goods.js 里云端还没有的菜品补进去，不会覆盖你已经改过的价格。确定吗？`,
      confirmText: '导入',
      confirmColor: '#e8590c',
      success: async (res) => {
        if (!res.confirm) return;

        this.setData({ seeding: true });

        try {
          const result = await seedDishes(localGoods);
          await this.loadDishes();

          wx.showToast({
            title:
              result.seeded > 0
                ? `已导入 ${result.seeded} 道菜`
                : '本地菜品都已在云端',
            icon: 'none',
          });
        } catch (e) {
          console.error('导入菜单失败', e);
          wx.showToast({ title: e.message || '导入失败', icon: 'none' });
        } finally {
          this.setData({ seeding: false });
        }
      },
    });
  },

  // ==================== 导航 / 复制 ====================
  onOpenOrders() {
    if (getCurrentPages().length > 1) {
      wx.navigateBack();
      return;
    }

    wx.redirectTo({
      url: '/pages/adminOrders/adminOrders',
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
