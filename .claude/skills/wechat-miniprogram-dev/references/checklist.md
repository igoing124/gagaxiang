# 交付前检查清单

## 自动检查命令

在项目根目录执行：

```bash
# 1. JS 语法
for f in $(find miniprogram -name "*.js"); do node --check "$f" || echo "FAIL $f"; done

# 2. JSON 格式
for f in $(find miniprogram -name "*.json"); do
  node -e "JSON.parse(require('fs').readFileSync('$f','utf8'))" || echo "FAIL $f";
done

# 3. app.json 页面文件是否齐全
node -e "
const fs=require('fs');
const app=JSON.parse(fs.readFileSync('miniprogram/app.json','utf8'));
for (const p of app.pages) {
  for (const ext of ['js','json','wxml','wxss']) {
    const f='miniprogram/'+p+'.'+ext;
    if(!fs.existsSync(f)) console.log('MISSING '+f);
  }
}
"

# 4. WXML 事件绑定是否都有对应方法
for f in $(find miniprogram/pages -name "*.wxml"); do
  page=$(basename $(dirname "$f"));
  for h in $(grep -oE '(bindtap|catchtap)="[a-zA-Z]+"' "$f" | sed -E 's/.*="([a-zA-Z]+)"/\1/' | sort -u); do
    grep -qE "^[[:space:]]*$h\(" "miniprogram/pages/$page/$page.js" || echo "MISSING $page: $h";
  done;
done
```

## 开发者工具里的人工验收

- [ ] 编译无红色报错
- [ ] Console 无报错/警告
- [ ] 所有页面能正常进入和返回
- [ ] 加购、改数量、合计金额正确
- [ ] 售罄商品不能加购
- [ ] 提交订单后购物车清空、订单出现
- [ ] 订单列表显示时间、金额、备注
- [ ] 真机「预览」扫码正常
- [ ] 网络请求域名已配置（如有）
- [ ] 主包体积 < 2MB（「详情 → 基本信息」可看）

## 常见错误对照

| 现象 | 原因 | 处理 |
|---|---|---|
| `van-stepper is not defined` / 组件找不到 | 没构建 npm | 工具 → 构建 npm |
| `未找到 van-dialog 节点` | WXML 缺少 `<van-dialog id="van-dialog" />` | 补上节点 |
| 点击 + 号跳详情 | 用了 bindtap 冒泡 | 改用 catchtap |
| setData 后页面没变 | 直接改了 this.data | 用 `this.setData()` |
| switchTab 跳转失败 | 目标不是 tabBar 页面 | 改用 navigateTo |
| 从详情返回数量不更新 | 没在 onShow 刷新 | 在 onShow 里重算 |
| 真机请求失败 | 域名未配置/非 HTTPS | 后台配置合法域名 |
| 预览提示包太大 | 图片或 npm 包太大 | 移走无用资源/分包 |
| 个人主体无法上线商城 | 类目限制 | 企业或个体工商户主体 |
| 支付调不起来 | 未开通微信支付/未绑商户号 | 后台开通并配置 |

## 发布前

- [ ] 小程序名称、头像、简介、类目已填写
- [ ] 隐私协议/用户信息收集声明已配置
- [ ] 服务类目与主体资质匹配
- [ ] 后端域名已备案并配置到「服务器域名」
- [ ] 体验版真机测试通过
- [ ] 上传代码 → 提交审核 → 发布
