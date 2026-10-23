# 微信小程序速查表

## 文件结构

```
miniprogram/
  app.js          全局逻辑、globalData、onLaunch
  app.json        pages、window、tabBar、usingComponents
  app.wxss        全局样式
  pages/<name>/   index.js/.json/.wxml/.wxss
  components/<name>/  自定义组件四件套
  data/           本地数据模块
  miniprogram_npm/    构建 npm 后生成，不要手改
```

## WXML 语法

| 语法 | 示例 | 说明 |
|---|---|---|
| 数据绑定 | `{{name}}` | 显示 data 中的值 |
| 运算 | `{{price * count}}` | 支持算术、三元、比较 |
| 列表 | `<view wx:for="{{list}}" wx:key="id">{{item.name}}</view>` | `item` 当前项，`index` 下标 |
| 条件 | `wx:if` / `wx:elif` / `wx:else` | 相邻节点才能配对 |
| 块 | `<block wx:for>` | 不渲染自身节点 |
| 模板 | `<template is="..." data="..." />` | 复用结构 |
| 引用 | `<import src>` / `<include src>` | 引入模板/片段 |

## 事件

```xml
<view bindtap="onTap" data-id="{{item.id}}">点我</view>
<view catchtap="onAdd" data-id="{{item.id}}">+</view>
<input bindinput="onInput" />
```

```js
onTap(e) {
  const id = e.currentTarget.dataset.id
}
onInput(e) {
  const value = e.detail.value
}
```

- `bindtap` → 冒泡；`catchtap` → 阻止冒泡
- `bind:change` 用于自定义组件事件（Vant 常用）
- `e.target` 是实际触发节点，`e.currentTarget` 是绑定事件的节点

## 页面生命周期

| 钩子 | 时机 |
|---|---|
| `onLoad(options)` | 页面加载一次，接收路由参数 |
| `onShow()` | 每次显示（包括返回） |
| `onReady()` | 首次渲染完成 |
| `onHide()` | 隐藏（跳走、切 tab） |
| `onUnload()` | 页面销毁 |
| `onPullDownRefresh()` | 下拉刷新（需配置） |
| `onReachBottom()` | 触底 |

## 导航

```js
wx.navigateTo({ url: '/pages/detail/detail?id=1' }) // 入栈，可返回
wx.redirectTo({ url: '/pages/success/success' })    // 替换当前页
wx.switchTab({ url: '/pages/index/index' })         // 只能跳 tabBar
wx.navigateBack({ delta: 1 })                       // 返回
```

接收参数：`onLoad(options) { options.id }`

## 本地存储

```js
wx.setStorageSync('orders', orders)
const orders = wx.getStorageSync('orders') || []
wx.removeStorageSync('orders')
```

## 常用 API

| API | 用途 |
|---|---|
| `wx.showToast({ title, icon:'none' })` | 轻提示 |
| `wx.showModal({ title, content, success })` | 确认弹窗 |
| `wx.showLoading` / `wx.hideLoading` | 加载中 |
| `wx.request` | 网络请求（需配置合法域名） |
| `wx.previewImage` | 预览图片 |
| `wx.chooseMedia` | 选图片/视频 |
| `wx.getSystemInfoSync` | 设备信息 |
| `wx.nextTick` | 渲染后执行 |

## 常用组件

- 视图：`view`、`text`、`image`、`scroll-view`、`swiper`
- 表单：`button`、`input`、`textarea`、`picker`、`switch`、`radio`、`checkbox`
- 媒体：`video`、`camera`、`canvas`
- 地图：`map`

## Vant Weapp

```json
// 页面 json
{
  "usingComponents": {
    "van-stepper": "@vant/weapp/stepper/index",
    "van-submit-bar": "@vant/weapp/submit-bar/index",
    "van-dialog": "@vant/weapp/dialog/index"
  }
}
```

```xml
<van-stepper value="{{count}}" min="{{0}}" bind:change="onChange" />
<van-submit-bar price="{{total * 100}}" button-text="提交订单" bind:submit="onSubmit" />
<van-dialog id="van-dialog" />
```

```js
const Dialog = require('@vant/weapp/dialog/dialog').default
Dialog.confirm({ title: '确认下单', message: '...' }).then(() => {}).catch(() => {})
```

- 安装：`cd miniprogram && npm install @vant/weapp --save`
- 安装后必须在开发者工具点「工具 → 构建 npm」
- 组件用 CSS 变量定制颜色，例如 `--stepper-background-color`

## 云开发

```js
// app.js
wx.cloud.init({ env: '你的环境ID', traceUser: true })

// 调用云函数
wx.cloud.callFunction({ name: 'fn', data: { ... } })

// 数据库
const db = wx.cloud.database()
db.collection('orders').add({ data: {...} })
db.collection('orders').where({ ... }).get()
```

- 云函数代码放 `cloudfunctions/<name>/index.js`，每个函数单独上传部署
- 数据库权限在云开发控制台配置
- 云开发需要在小程序后台开通环境
