# 嘎嘎香 乐山油炸串串 · H5 外卖点单系统

一套只做外卖配送的 H5 点单系统，不依赖微信小程序审核，也不接微信支付。

- 顾客进入页面自动登录，不显示微信登录界面；首次设置昵称、头像、手机号，昵称/头像之后不可修改
- 顾客端支持菜品搜索，并显示「最近点过」「销量较高」推荐
- 顾客填写收货地址，支持一键自动定位
- 配送费 3 元，商品满 50 元免配送费（服务端计算）
- 新人首单满 50 减 5；商家可按顾客手机号精准发券
- 商家后台 `/admin`：订单列表、订单详情、接单/完成/取消、菜品搜索、菜品管理、优惠券管理
- 新订单 15 秒轮询提醒，提示音 + 震动
- 金额全部以「分」存储和计算，服务端重新核算
- Express 单服务 + JSON 文件持久化，不需要数据库

## 快速启动

需要 Node.js 18 或更高版本。

```bash
cd D:\ai\油炸小程序\h5-order
npm install
node server.js
```

启动后：

- 顾客端：`http://localhost:3000`
- 商家端：`http://localhost:3000/admin`
- 商家口令：见 `config.json` 的 `adminPassword`
- 手机测试：手机和电脑连同一个 Wi-Fi，打开控制台打印的局域网地址

## 顾客进入说明

顾客端不再显示微信登录界面。打开页面后会自动创建或恢复本机账号，直接进入点单：

- 已有本机账号：直接显示菜单
- 新账号：先设置昵称、头像、手机号，之后昵称和头像由服务端锁定
- 账号凭证保存在浏览器 localStorage，不需要输入密码
- 手机号用于账号识别、商家联系和优惠券精准发放
- 清除浏览器数据会失去本机账号

顾客端自动进入时固定使用本机登录（请求带 `localOnly`）；即使以后配置了公众号，也不会再弹出微信授权页面。

### 微信公众号授权代码（保留，不显示入口）

公众号授权模块仍保留在 `lib/wechat-auth.js` 和 `routes/wechat-auth.js`，但顾客端没有入口，不会触发。只有以后恢复微信登录入口时才需要配置。

如恢复入口，激活前提四项：

1. 已认证的微信企业服务号（个人订阅号、未认证服务号不支持网页授权）
2. 公众号 AppID、AppSecret
3. 已备案域名 + 公网 HTTPS，并在公众号后台配置「网页授权域名」
4. `config.json` 填写以下内容并重启服务：

```json
{
  "publicBaseUrl": "https://你的已备案域名",
  "wechat": {
    "enabled": true,
    "appId": "wx...",
    "appSecret": "..."
  }
}
```

回调地址由服务端自动拼接为 `publicBaseUrl + /api/auth/wechat/callback`，公众号后台的「网页授权域名」只填 `publicBaseUrl` 的域名（不带协议和路径）。

`config.example.json` 的 `wechat._说明` 里写明了 AppID、AppSecret、回调域名的获取方式。JSON 不支持 `//` 注释，所以使用说明字段承载中文说明；这些字段不参与服务启动校验。

> **未配置不影响营业。** 不填、留空或删除整个 `wechat` 字段时，系统不发起任何微信网络请求、不做启动校验，点单、下单、订单列表、商家接单、菜品管理、优惠券发放和配送费全部正常。

## 自动定位

结算页的「自动定位」使用浏览器定位 + 服务端逆地址解析。

推荐在 `config.json` 填写高德 Web 服务 Key：

```json
"amapKey": "你的高德Web服务Key"
```

高德 Key 在 [高德开放平台](https://console.amap.com/) 创建，类型选择「Web 服务」。服务端会先把浏览器 WGS84 坐标转换成高德 GCJ-02 坐标，再解析地址。

- 未配置 Key 时会尝试 OpenStreetMap 免费解析；在中国大陆可能很慢或无法访问
- 定位需要浏览器允许位置权限，正式环境必须使用 HTTPS
- 定位只负责带出大致地址，顾客仍需补充小区、楼栋和门牌号
- 定位坐标会随订单保存，商家在订单详情里可以点「打开地图导航」

## 配送费规则

在 `config.json` 配置：

```json
"deliveryFeeCents": 300,
"freeDeliveryThresholdCents": 5000
```

- 商品小计不满 50 元：配送费 3 元
- 商品小计满 50 元：配送费 0 元
- 优惠券按商品小计判断门槛，不与配送费叠加
- 金额全部由服务端计算，客户端无法伪造

## 商家使用说明（10 步）

1. 修改 `config.json`：商家口令、店名、电话、营业时间、配送费、满免门槛
2. 建议填写 `amapKey`，让顾客可以一键定位
3. 运行 `npm install`，再运行 `node server.js`
4. 浏览器打开 `/admin`，用 `adminPassword` 登录
5. 进入「菜品管理」，核对 47 道菜的价格/单位，按需改价、上新、售罄、上下架
6. 进入「优惠券」，确认新人券满 50 减 5，按需新增或调整
7. 需要给某位顾客发券时，在「发放优惠券」填写顾客登录绑定的手机号
8. 营业时把 `/admin` 订单页一直开着，打开设备音量；有新单会响铃、震动并置顶
9. 顾客下单后，点订单卡片查看完整配送信息，再「接单」→「出餐完成」
10. 每天营业结束备份 `data/` 和 `config.json`

> 商家后台必须保持打开才能每 15 秒检查新订单；关闭网页后不会提醒。

## 数据文件

| 文件 | 内容 |
| --- | --- |
| `data/menu.json` | 实际使用的菜单（商家改价/上下架会写这里） |
| `data/menu.js` | 从小程序同步来的原始菜单模板 |
| `data/users.json` | 顾客账号、昵称、头像、手机号、登录凭证 |
| `data/orders.json` | 订单（金额单位为分，含配送地址和坐标） |
| `data/coupons.json` | 优惠券模板 |
| `data/user-coupons.json` | 已发放到账号的优惠券 |
| `config.json` | 门店配置、商家口令、地图和微信授权配置 |

每天结束建议备份 `data/` 和 `config.json`。`data/backup-before-delivery/` 是本次改成外卖模式前的自动备份。

## 优惠券规则

- 新账号完成资料设置后自动获得「新人首单券」：满 50 减 5，仅限首单
- 商家发券时填写顾客手机号，只会发给该手机号绑定的账号
- 手机号必须先在顾客端完成登录和资料设置
- 同一个账号已有同款未使用券时不会重复发放
- 订单取消后，已使用的优惠券自动退回账号
- 已取消订单不计入「首单」

## 菜单同步与价格恢复

H5 的初始菜单来自 `miniprogram/data/goods.js`，同步命令：

```bash
node tools/sync-menu.js
```

它只更新模板 `data/menu.js`，不会覆盖商家在后台改过的 `data/menu.json`。

本次已经把 `data/menu.json` 中 47 道菜的价格按 `data/menu.js` 的原始价格逐项恢复。之后商家在后台改价会正常生效。

## 部署方式

外卖订单需要顾客在店外使用，推荐公网 HTTPS 部署。

### 公网服务器 + 域名

1. 准备 Node.js 18+ 云服务器和已备案域名
2. 上传 `h5-order`，运行 `npm install`
3. 用 systemd 或 pm2 守护 `node server.js`
4. Nginx/Caddy 反向代理到 `127.0.0.1:3000`，配置 HTTPS
5. 在 `config.json` 设置 `publicBaseUrl` 为公网 HTTPS 地址
6. 如需恢复微信授权入口，再在公众号后台配置网页授权域名（当前顾客端不显示入口，可跳过）

Nginx 示例：

```nginx
server {
    listen 80;
    server_name order.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name order.example.com;

    ssl_certificate     /etc/letsencrypt/live/order.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/order.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

使用反向代理时，启动环境加 `TRUST_PROXY=1`，用于真实客户端 IP 限流和微信回调地址。

### 局域网测试

店内测试可以直接用电脑局域网地址打开，但：

- 手机浏览器可能因为 HTTP 禁止定位
- 顾客离开店内 Wi-Fi 后无法访问
- 不建议作为正式外卖使用

## 订单并发与金额安全

- 服务端不信任客户端传的价格和总额，只接收菜品 id、数量、优惠券 id、地址和坐标
- 菜品价格、配送费、优惠券门槛/优惠、总额全部由服务端按 `menu.json`、`config.json` 和 `user-coupons.json` 重新计算
- 写 JSON 使用「临时文件 + 改名」的原子写入；Node 单线程同步写入，两个顾客同时下单不会互相覆盖
- 订单和优惠券状态变更失败会回滚，避免出现“订单成功但券没核销”的不一致
- 顾客查单需要下单时返回的随机 token，或使用本人登录账号
- 商家后台口令只存在服务端，不会出现在前端源码

## 测试

```bash
npm test
```

烟测使用临时数据和端口，覆盖：47 道菜原始价格、登录与资料锁定、手机号唯一、满 50 免配送费、不满 50 收 3 元、地址/手机号校验、新人券、取消退券、按手机号发券、订单详情字段、菜品改价/上新/售罄/上下架、10 个并发下单、重启后 JSON 持久化、口令不出现在前端、桌码已删除。

## 安全与限制

- 公网部署务必使用 HTTPS；收集手机号、地址和定位时注意隐私
- `data/orders.json` 和 `data/users.json` 含个人信息，限制服务器文件权限并每日备份
- 默认的本机登录在清除浏览器数据后无法找回账号；正式运营建议配置微信网页授权
- 手机号没有短信验证，按手机号发券依赖顾客填写真实手机号
- 单进程 + JSON 文件适合单店小流量；订单量很大时应换 SQLite/MySQL/PostgreSQL
- 没有在线支付、退款、骑手调度、关闭页面后的推送提醒
- 小程序端原项目仍保留在 `miniprogram/`，H5 在 `h5-order/`，互不影响
