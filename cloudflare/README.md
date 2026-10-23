# 嘎嘎香 H5 点单 · Cloudflare Workers 部署版

把 `h5-order` 的 Express + JSON 文件应用移植到 Cloudflare Workers，接口和算价规则保持不变。

- 顾客端：`/`
- 商家端：`/admin`（口令通过 Cloudflare Secret 保存）
- 线上地址：`https://xaingdepibao.icu`
- 测试地址：`https://gagaxiang-order.gagaxiang.workers.dev`（大陆网络通常无法直连）

> 部署状态（2026-10-23）：已上线并通过 12 组线上回归，脚本
> `gagaxiang-order` 占 100% 流量，`xaingdepibao.icu` 已绑定并启用免费 HTTPS，
> 当前生产版本以 `wrangler deployments list` 为准。

> ⚠️ `*.workers.dev` 在中国大陆被 DNS 污染 + SNI 阻断，**店内顾客大概率打不开**。
> 要正式营业，需要绑定一个自己的域名（见「绑定自定义域名」），或者改用国内托管。

## 架构

```
浏览器
  │
  ├── 静态页面  → Workers Assets（直接读 ../h5-order/public，不复制、不改动原文件）
  └── /api/*    → Durable Object（单实例）→ SQLite 存储
```

- 所有请求都进同一个 Durable Object：单线程串行，等价于原来 Node 单进程同步写文件，
  两个顾客同时下单不会互相覆盖。
- 数据表 `docs`：`menu.json`、`orders.json`、`users.json`、`coupons.json`、`user-coupons.json`
  各存一行 JSON，键名和原 `data/` 目录一一对应。
- 取餐号按北京时间（UTC+8）每天从 A001 重新开始。
- 金额仍然全部由服务端按菜单价格、配送费、优惠券规则重新计算。

## 目录

```
cloudflare/
  wrangler.jsonc        部署配置（绑定、静态资源、环境变量）
  src/worker.js         入口：/api 转 Durable Object，其余走静态资源
  src/app.js            全部业务逻辑（从 h5-order/server.js 移植）
  src/store.js          Durable Object SQLite 文档存储
  src/seed/menu.js      首次部署写入的 47 道菜
  src/seed/coupons.js   首次部署写入的新人券模板
  test/shop.test.mjs    本地逻辑测试（15 组）
  test/online.mjs       对任意地址跑完整下单回归（12 组）
```

## 本地运行与测试

```bash
cd cloudflare
npm install            # 只装 wrangler（devDependency）
npm test               # 纯 Node 逻辑测试，不需要 Cloudflare 账号
npx wrangler dev       # 本地 Workers 运行时，http://127.0.0.1:8787
node test/online.mjs http://127.0.0.1:8787
```

## 部署

首次部署：

```bash
cd cloudflare
npm install
npx wrangler login     # 浏览器授权；或使用 CLOUDFLARE_API_TOKEN 环境变量
npx wrangler deploy
```

Windows 上直接双击 `deploy.bat` 即可（它会自动处理中文路径问题，见文末「常见问题」）。
想先在本地跑真实 Workers 运行时，双击 `dev.bat`。

使用 API Token（适合没有浏览器的环境）：

```powershell
$env:CLOUDFLARE_API_TOKEN = "你的 Token"
npx wrangler deploy
```

Token 权限：Workers Scripts:Edit、Durable Objects:Edit、Account Settings:Read。
（后台 → My Profile → API Tokens → 模板 Edit Cloudflare Workers）

部署后：

```bash
npx wrangler tail      # 实时看日志和报错
```

## 配置

门店信息和配送费在 `wrangler.jsonc` 的 `vars` 里：

| 变量 | 含义 | 当前值 |
| --- | --- | --- |
| `STORE_NAME` | 店名 | 嘎嘎香 乐山油炸串串 |
| `SHOP_PHONE` | 门店电话 | 15528775725 |
| `HOURS` | 营业时间 | 每天 17:00 - 次日 00:30 |
| `NOTICE` | 下单提示 | 外卖配送，提交订单后商家会电话联系确认，线下支付 |
| `DELIVERY_FEE_CENTS` | 配送费（分） | 300 |
| `FREE_DELIVERY_THRESHOLD_CENTS` | 满多少免配送费（分） | 5000 |
| `SHOP_AMAP_KEY` | 高德 Web 服务 Key | 通过加密 Secret 配置 |

改完执行一次 `npx wrangler deploy` 生效。

商家口令只保存在加密 Secret 中，不要写进 `wrangler.jsonc`、前端源码或公开仓库。
首次部署或更换口令时执行：

```bash
npx wrangler secret put SHOP_ADMIN_PASSWORD
```

高德定位 Key 同样使用加密 Secret，不要把真实 Key 提交到 Git：

```bash
npx wrangler secret put SHOP_AMAP_KEY
```

线上回归测试也通过环境变量读取口令：

```powershell
$env:ADMIN_PASSWORD="你的口令"
node test/online.mjs https://你的域名
```

## 数据与备份

数据在 Durable Object 的 SQLite 里，没有 `data/*.json` 文件可拷。

- 菜单/订单/优惠券都可以在 `/admin` 里查看和操作
- 商家登录后可以点后台顶部「备份数据」，直接下载完整 JSON 备份；
  也可以使用接口：

```bash
# 先登录拿 token
curl -X POST https://你的域名/api/admin/login \
  -H "Content-Type: application/json" \
  -d '{"password":"你的口令"}'

# 再导出（把 TOKEN 换成上一步返回的 token）
curl https://你的域名/api/admin/export \
  -H "x-admin-token: TOKEN" -o backup-2026-10-23.json
```

`/api/admin/export` 会返回菜单、订单、账号、优惠券模板和已发券，建议每天营业结束存一份。

## 绑定自定义域名

`workers.dev` 在大陆不可用，正式使用请绑自己的域名（约 ¥10–60/年）：

1. 在任意注册商买一个域名
2. Cloudflare 后台 → Add a site → 输入域名 → 选 Free 计划
3. 到注册商把 NS 改成 Cloudflare 给的两个地址，等待生效（几分钟到 24 小时）
4. 域名状态变成 Active 后，执行：

```bash
npx wrangler deploy --domain order.你的域名.com
```

或者后台 → Workers & Pages → `gagaxiang-order` → Settings → Domains & Routes → Add custom domain。

> 大陆访问 Cloudflare 免费版的自定义域名通常可以打开，但延迟比国内机房高。
> 如果对速度要求高，建议直接用微信云托管（项目根目录已有 `微信云托管部署指南.md` 和 Dockerfile）。

## 和 Express 版的差异

| 项目 | Express 版 | Cloudflare 版 |
| --- | --- | --- |
| 存储 | `data/*.json` | Durable Object SQLite |
| 进程 | Node 单进程 | 单 Durable Object（同样串行） |
| 静态资源 | `express.static` | Workers Assets（读 `h5-order/public`） |
| 限流/会话 | 内存 | Durable Object 内存（实例重启后商家需重新登录） |
| 微信网页授权 | 可选模块 | **未移植**（当前顾客端本来就不使用） |
| 取餐号日期 | 服务器本地时区 | 固定北京时间 |
| 部署 | pm2 / 云托管 | `wrangler deploy` |

顾客端、商家端页面完全复用，没有改动 `h5-order/public` 里的文件。

## 常见问题

**打开 workers.dev 超时 / 解析到 Facebook IP？**
大陆 DNS 污染，换自定义域名，或本地把 DNS 换成 8.8.8.8 并使用代理访问。

实测（2026-10-23，本机）：`nslookup gagaxiang-order.gagaxiang.workers.dev` 返回
`108.160.166.253` / `2a03:2880:f127:283:face:b00c:0:25de`，均为 Facebook 段地址；
即便指定 `1.1.1.1` 作为 DNS 服务器仍被劫持，因此本机 curl / Node fetch 均超时。
**这是国内网络的限制，不是部署失败**——可用 Cloudflare API 或境外网络确认脚本确实在线。

**构建报 `Cannot read file "xxx": winapi error #5`？**
根因：esbuild.exe / workerd.exe 这类原生二进制**放在中文路径下**（本项目为
`D:\ai\油炸小程序`）时，Windows 打开任何文件都返回 ACCESS_DENIED（OS Error 5）。
把二进制复制到 ASCII 路径后即恢复正常，与文件本身、沙箱、杀软无关（已逐一排除）。

修复：把 `esbuild.exe` 与 `workerd.exe` 复制到 `%USERPROFILE%\.esbuild-bin\`，
再用环境变量指过去：

```powershell
$env:ESBUILD_BINARY_PATH   = "$env:USERPROFILE\.esbuild-bin\esbuild.exe"
$env:MINIFLARE_WORKERD_PATH = "$env:USERPROFILE\.esbuild-bin\workerd.exe"
npx wrangler deploy
```

`deploy.bat` / `dev.bat` 已内置这段逻辑（首次运行会自动复制），日常直接用它们即可。
注意：复制出来的二进制与 `npm install` 的版本绑定，**升级 wrangler 后需重新复制**。

**无法访问线上地址时怎么验证？**
本地起真实 Workers 运行时（同样是 workerd + Durable Object + SQLite），再跑回归：

```bash
dev.bat                                   # http://127.0.0.1:8787
node test/online.mjs http://127.0.0.1:8787
```

**商家后台提示登录过期？**
Durable Object 实例重启会清空内存里的会话，重新输入口令即可。

**优惠券/菜单数据想重置？**
在 `/admin` 里改；彻底重置需要清空 Durable Object 存储（目前没有开放接口，可换一个新的 DO 名称重新部署）。

**并发下单会不会丢单？**
所有 `/api/*` 请求都进同一个 Durable Object，按到达顺序串行处理；写 SQLite 是同步的。
`test/shop.test.mjs` 里有 10 个并发下单的用例。
