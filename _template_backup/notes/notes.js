// pages/notes/notes.js —— 学习笔记页
// 这一页的内容也是「数据驱动」的：数组里有几项，页面就渲染几张卡片。
// 你可以打开同目录下的 notes.wxml 看看它是怎么循环的。

Page({
  data: {
    sections: [
      {
        title: '小程序由 4 种文件组成',
        body: '每个页面都有 4 个同名文件；整个小程序还有 app.js / app.json / app.wxss 负责全局配置。',
        code: `index.wxml  页面结构（像 HTML）
index.wxss  页面样式（像 CSS）
index.js    页面逻辑（JavaScript）
index.json  页面配置（比如标题）`,
      },
      {
        title: '数据绑定 {{ }}',
        body: 'JS 里 data 中的数据，可以用 {{ }} 显示到页面上。数据变了，页面会自动跟着变。',
        code: `// index.js
data: { name: '炸鸡腿', price: 8 }

<!-- index.wxml -->
<view>{{name}} ¥{{price}}</view>

页面显示：炸鸡腿 ¥8`,
      },
      {
        title: '列表渲染 wx:for',
        body: '数组有几项，wx:for 就会生成几份相同的结构。item 是当前元素，index 是下标。wx:key 用来帮小程序高效更新列表。',
        code: `<view wx:for="{{list}}" wx:key="id">
  {{item.name}} ¥{{item.price}}
</view>`,
      },
      {
        title: '条件渲染 wx:if',
        body: '条件成立时才显示。wx:else 必须紧跟在 wx:if 后面。我们的购物车数量、商品标签都用了它。',
        code: `<view wx:if="{{count > 0}}">已选 {{count}} 份</view>
<view wx:else>还没选东西</view>`,
      },
      {
        title: '事件：bindtap 和 catchtap',
        body: 'bindtap 表示点击。catchtap 也是点击，但会阻止事件向上冒泡。如果首页的 + 号用 bindtap，点它时会同时触发整张卡片的点击事件，直接跳到详情页——所以 + 号必须用 catchtap。',
        code: `<!-- 整张卡片：点击跳详情 -->
<view bindtap="onTapGoods">
  <!-- + 号：阻止冒泡，只加购物车 -->
  <view catchtap="onAdd" data-id="{{item.id}}">+</view>
</view>`,
      },
      {
        title: '事件传参：dataset',
        body: '在标签上写 data-xxx，事件处理函数里用 e.currentTarget.dataset.xxx 获取。注意 data-id 会变成 dataset.id。',
        code: `<view catchtap="onAdd" data-id="{{item.id}}">+</view>

onAdd(e) {
  const id = e.currentTarget.dataset.id
}`,
      },
      {
        title: 'setData：更新数据并刷新页面',
        body: '直接修改 this.data 页面不会刷新，必须调用 this.setData()。这是新手最常踩的坑。',
        code: `// 错误：页面不会变化
this.data.cartCount = 3

// 正确：页面立刻刷新
this.setData({ cartCount: 3 })`,
      },
      {
        title: '页面跳转与参数',
        body: 'wx.navigateTo 打开新页面，url 后面可以用 ?参数=值 传数据；新页面在 onLoad(options) 里接收。',
        code: `// 首页：跳转时带 id
wx.navigateTo({ url: '/pages/detail/detail?id=chicken' })

// 详情页：接收参数
onLoad(options) {
  console.log(options.id) // 'chicken'
}`,
      },
      {
        title: '生命周期 onLoad / onShow',
        body: 'onLoad 只在页面打开时执行一次；onShow 每次页面显示都会执行（包括从别的页面返回）。所以购物车数量要在 onShow 里刷新，否则从详情页返回后数字不会更新。',
        code: `onLoad(options) {
  // 页面第一次打开：读取参数、请求数据
}

onShow() {
  // 每次显示：刷新购物车等实时数据
}`,
      },
      {
        title: '全局数据 getApp()',
        body: 'app.js 里的 globalData 整个小程序共享，任何页面都能读写。我们的购物车就存在那里，所以首页和详情页看到的是同一份数据。',
        code: `// app.js
App({ globalData: { cart: {} } })

// 任意页面
const cart = getApp().globalData.cart

注意：这是内存数据，小程序关闭后会清空。`,
      },
      {
        title: '表单输入 bindinput',
        body: '输入框和点击一样用事件接收。bindinput 会在每次输入时触发，输入的内容在 e.detail.value 里。结算页的「备注」就是这么拿到的。',
        code: `<!-- wxml -->
<textarea value="{{remark}}" bindinput="onRemarkInput" />

// js
onRemarkInput(e) {
  this.setData({ remark: e.detail.value })
}`,
      },
      {
        title: '本地存储 wx.setStorageSync',
        body: '订单提交后存进手机本地，关掉小程序也不会丢。getStorageSync 读取，setStorageSync 写入。它和 globalData 的区别：globalData 一关小程序就没，本地存储会一直留着。',
        code: `// 存
wx.setStorageSync('orders', orders)

// 读（没存过时返回空字符串，所以用 || [] 兜底）
const orders = wx.getStorageSync('orders') || []`,
      },
      {
        title: 'navigateTo / redirectTo / switchTab',
        body: 'navigateTo 打开新页面，可以返回；redirectTo 替换当前页面，不能返回到被替换的页面；switchTab 只能跳到 tabBar 页面，并会清空其他页面。结算提交后用的是 redirectTo，所以按返回键不会又回到结算页。',
        code: `wx.navigateTo({ url: '/pages/detail/detail?id=chicken' })
wx.redirectTo({ url: '/pages/orderSuccess/orderSuccess?id=' + id })
wx.switchTab({ url: '/pages/index/index' })`,
      },
      {
        title: '用 npm 组件库（以 Vant 为例）',
        body: '小程序可以用 npm 安装第三方组件库，省去自己写样式。装好包后要在开发者工具点「工具 → 构建 npm」，再在页面的 json 里注册组件，就能像原生标签一样使用。结算页的步进器、提交栏、确认弹窗都来自 Vant Weapp。',
        code: `// 1. 在 miniprogram 目录安装
npm install @vant/weapp --save

// 2. 页面 json 注册
"usingComponents": {
  "van-stepper": "@vant/weapp/stepper/index"
}

<!-- 3. 在 wxml 里使用 -->
<van-stepper value="{{count}}" bind:change="onChange" />`,
      },
      {
        title: '分享与拨号：open-type 和 wx.makePhoneCall',
        body: '「分享给好友」不能用普通 view：必须用原生 button 并设置 open-type="share"，同时页面里定义 onShareAppMessage 返回分享标题和路径。拨号用 wx.makePhoneCall，号码只能传纯数字，不能带空格或横线。',
        code: `<!-- 分享按钮 -->
<button open-type="share">分享给好友</button>

// 页面 js
onShareAppMessage() {
  return {
    title: '油炸小栈',
    path: '/pages/index/index',
  }
}

// 拨号（纯数字）
wx.makePhoneCall({ phoneNumber: '13800138000' })`,
      },
    ],

    exercises: [
      '改一下 data/goods.js 里的价格和介绍，保存后看模拟器自动刷新',
      '在 goods.js 里新增一个你自己喜欢的炸物（id 不能和已有的重复）',
      '把 goods.js 里某个商品的 soldOut 在 true / false 之间切换，观察首页和详情页的变化',
      '给购物车栏的「清空」加二次确认：点击后先用 wx.showModal 询问，点「确定」再清空',
      '给结算页的备注加几个快捷按钮（比如「不要辣」「多放孜然」），点击后自动填进输入框',
      '给订单加「标记完成」按钮：点击后把该订单的 status 改成 done，观察订单页从「制作中」变成「已完成」',
      '把 app.js 里的示例电话号码换成你自己的，在真机上试试「一键拨号」和「分享给好友」',
    ],
  },
});
