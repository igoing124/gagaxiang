---
name: wechat-miniprogram-dev
description: 开发、修改、排查微信小程序（原生 WXML/WXSS/JS、Vant Weapp、云开发）。当用户提到小程序页面、组件、数据绑定、事件、生命周期、购物车、订单、结算、tabBar、npm 构建、真机预览或发布时使用。
---

# 微信小程序开发

## 工作流程

1. **先读再改**：读 `app.json`、目标页面的四件套、相关数据模块，不要凭空猜文件内容。
2. **保持新手友好**：中文注释、命名直白、少用抽象封装；用户是初学者时解释「为什么」。
3. **改完自检**（能跑命令就跑）：
   - 所有改动的 JS 用 `node --check` 检查语法
   - 所有改动的 JSON 用 `JSON.parse` 校验
   - WXML 里的 `bindtap` / `catchtap` / `bindinput` 等事件，逐个确认 JS 里有同名方法
   - `app.json` 的 `pages` 每一项都要有 `.js/.json/.wxml/.wxss` 四个文件
4. **改动了 npm 依赖**：提醒用户在开发者工具点「工具 → 构建 npm」。
5. **无法验证渲染时**：明确说「语法和配置已检查，但模拟器效果需要你在开发者工具确认」，不要假装跑过。

## 当前项目：嘎嘎香 乐山油炸串串

- 路径：`D:\ai\油炸小程序`，原生小程序 + Vant Weapp 1.11.7
- 页面：`index` 点单、`detail` 详情、`checkout` 结算、`orderSuccess` 成功、`orders` 订单列表、`profile` 我的（本地微信登录、我的优惠券、历史订单、下单总额、头像可换、昵称锁定、门店信息/拨号/分享、商家入口仅管理员可见；未配置管理员时临时对登录用户可见）、`adminOrders` 商家订单管理（接单/配送/完成/取消）、`adminDishes` 商家菜品管理（改价/上新/售罄/上下架/导入本地菜单）、`adminCoupons` 商家发券（都需云开发 + 管理员 openid）
- 菜单数据：`miniprogram/data/goods.js` 只是本地兜底和首次导入来源；顾客端通过 `services/cloud.js` 的 `listDishes` 优先读云数据库 `dishes`，云端没有菜单或云函数失败时回退本地。`listDishes` 有 5 分钟内存缓存，商家改菜单后 `saveDish`/`toggleDish`/`seedDishes` 会立即失效缓存
- 分类：每个商品有 `category`（素菜类/荤菜类/大串类）；首页从当前菜单自动提取分类，筛选只影响显示的 `list`，底部合计和购物车弹层仍用全量数据
- 最近点过：`index` 通过 `services/cloud.js` 读订单，按最近订单优先排序，最多 6 个；推荐卡片可直接加购
- 购物车：`app.globalData.cart`（内存，格式 `{ 商品id: 数量 }`）
- 订单：页面统一通过 `miniprogram/services/cloud.js` 读写；云开发可用时存云数据库 `orders`，否则存本地 storage；订单展示转换在 `miniprogram/utils/order.js`。正式模式 `app.js` 的 `requireCloudForOrders: true`，云不可用时 `createOrder` 直接报错，不允许只写本地
- 下单安全：`createOrder` 云函数不信任客户端的商品/价格/总额/配送费，按 `dishes` 集合的当前菜价和 `config/store` 的配送费重新计算；校验收货信息、数量、售罄/下架状态，并由服务端生成唯一订单号 `id`。客户端用云函数返回的 `id` 跳转成功页
- 订单状态：`pending` 待接单（新订单默认）→ `making` 制作中 → `delivering` 配送中 → `completed` 已完成；`cancelled` 已取消。兼容旧值 `done`/`canceled`。状态只能单向流转，云函数 `adminUpdateOrderStatus` 校验
- 商家订单：`adminOrders` 页通过 `listAllOrders` 读取全部订单，按 tab 过滤；接单/配送/完成/取消调用 `updateOrderStatus`。取消订单会把 `userCoupons` 里的券退回未使用；`getOrderCount` 不计已取消订单，所以首单券可以重新使用。需管理员权限
- 新订单提醒：`adminOrders` 在 `onShow` 启动 15 秒轮询，`onHide`/`onUnload` 停止；用待接单订单的 `_id` 判断新订单，首次加载也会提醒现有待接单。提醒方式为 `wx.vibrateLong` + `InnerAudioContext` 播放 `miniprogram/audio/new-order.wav`（代码包内用相对路径 `audio/new-order.wav`）+ 顶部提示条。状态变更后用 `loadOrders({ force: true })` 避免和轮询请求竞争。仅页面打开时有效，关闭小程序需订阅消息。
- 商家菜品：`adminDishes` 页通过 `adminListDishes` 读取全部菜品（含下架），`saveDish` 新增/编辑，`toggleDish` 切换 `soldOut`/`enabled`，`seedDishes` 把 `goods.js` 合并进云端（只补缺失 id，不覆盖已改菜品）。顾客端 `listDishes` 只返回 `enabled !== false` 的菜品，`soldOut` 仍返回但不可加购
- 结算：配送模式；校验 `receiverName/receiverPhone/address`，订单存 `deliveryType: 'delivery'`、`deliveryFee`、`address`
- 优惠券：模板存 `coupons`，用户券存 `userCoupons`；默认新人首单券 `new_user_50_5`（满 50 减 5，`autoIssue: 'newUser'`，`onlyFirstOrder: true`）。云函数 `login` 在用户无订单且未领过时自动发券；`createOrder` 服务端校验归属/未使用/门槛/首单并核销。结算页可选用券，订单存 `discount`、`payablePrice`、`coupon`、`userCouponId`。本地模式只有固定新人券
- 商家发券：从 `adminOrders` 右上角进入 `adminCoupons`；页面先 `checkAdmin`。管理员 openid 配在 `config` 集合 `_id: 'admin'` 的 `openids` 数组。可新建/编辑/停用模板，给指定 openid 或 `users` 全体发券
- 金额：订单同时存 `totalPrice`（商品金额）、`discount`、`payablePrice`（商品 + 配送费 - 优惠），展示和统计优先用 `payablePrice`
- 配送：配送费 `deliveryFee` 元，商品金额满 `freeDeliveryThreshold` 免配送费；地址本地缓存 `deliveryAddress`，云端可用时同步 `addresses` 集合。客户端展示读 `app.js` 的 `store`，服务端结算读 `config` 集合 `_id: 'store'` 的文档，两处要同步修改
- 登录：`wx.setStorageSync('loginUser', { nickName, avatarUrl, loginAt })`；本地昵称/头像，云开发时用 openid 区分用户；头像用 `wx.chooseMedia` + `FileSystemManager.saveFile` 持久化；昵称用 `<input type="nickname">`，登录后锁定
- 云开发：`envList.js` 填环境 ID；`app.js` 的 `cloudReady` Promise 决定云/本地模式；云函数 `cloudfunctions/api`，集合 `orders`/`addresses`/`coupons`/`userCoupons`/`users`/`config`/`dishes`（首次登录自动创建并写入默认新人券，菜单需商家手动导入）；商家动作 `adminListOrders`/`adminUpdateOrderStatus`/`adminListDishes`/`adminSaveDish`/`adminToggleDish`/`adminSeedDishes`/`adminListCoupons`/`adminSaveCoupon`/`adminIssueCoupon`/`adminListUsers`；任何一步失败自动回退本地。**改云函数后必须重新上传部署**
- 主题：橙 `#FF7A00`、深棕 `#3A2417`、米白 `#FFF8F0`
- 约定：字段用 `soldOut`（驼峰）；菜品 id 稳定，订单只存 id + 名称/价格快照；价格单位是元（可能有小数，如 0.7），用 `roundMoney` 保留两位；Vant `submit-bar` 的 `price` 单位是分，用 `payablePriceFen`
- 未使用：`cloudfunctions/quickstartFunctions/`（官方模板遗留）、`_template_backup/`（备份）
- 音频：`miniprogram/audio/new-order.wav`；`InnerAudioContext.src` 用代码包相对路径，不能写 `file://` 或绝对文件系统路径

## 核心规则

- 四件套：`.wxml` 结构、`.wxss` 样式、`.js` 逻辑、`.json` 配置
- `app.json` 的 `pages` 第一项是启动页；tabBar 页面必须在 `pages` 里
- 数据绑定 `{{ }}`；列表 `wx:for` + `wx:key`；条件 `wx:if / wx:elif / wx:else`
- 事件：`bindtap` 点击；`catchtap` 点击且阻止冒泡；传参用 `data-*`，取值 `e.currentTarget.dataset.*`
- 页面刷新必须 `this.setData()`；直接改 `this.data` 不会渲染
- 生命周期：`onLoad` 只执行一次；`onShow` 每次显示都执行
- 导航：`navigateTo` 可返回、`redirectTo` 替换当前页、`switchTab` 只能跳 tabBar 页、`navigateBack` 返回
- 存储：`wx.setStorageSync / getStorageSync`（同步）；`globalData` 关小程序即清空
- 主包上限 2MB；图片、npm 组件库是大头
- npm 组件库：`npm install` 后必须「构建 npm」，再在页面 JSON 的 `usingComponents` 注册
- 平台插件 ≠ 组件库：平台插件走 `app.json` 的 `plugins` + `plugin://`，需要后台申请授权

## 常见坑

- JavaScript 大小写敏感：`soldout` 和 `soldOut` 是两个字段
- 卡片里的「+」按钮要用 `catchtap`，否则会触发外层的卡片跳转
- tabBar 页面只能用 `switchTab` 跳转
- 微信开发者工具的服务端口默认关闭，CLI 自动化前需要用户手动开启
- 修改 npm 包后不重新「构建 npm」会提示组件找不到
- 移动/删除图片前先 grep 引用，尤其是模板遗留资源
- 个人主体小程序通常不能上线商城/餐饮交易类目；微信支付要商户号

## 参考

- `references/cheatsheet.md`：WXML / 事件 / API / Vant 速查
- `references/checklist.md`：交付前检查命令与排错对照表
- 官方文档：https://developers.weixin.qq.com/miniprogram/dev/framework/
- Vant Weapp：https://vant-ui.github.io/vant-weapp/#/quickstart
