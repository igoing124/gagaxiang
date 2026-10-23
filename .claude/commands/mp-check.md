---
description: 检查微信小程序项目的语法、配置、事件绑定和 npm 构建状态
allowed-tools: Bash, Read, Glob, Grep
---

检查当前微信小程序项目，只读不修改，最后输出问题清单。

执行以下检查：

1. 找出 `miniprogram/` 下所有 `.js`，逐个运行 `node --check`，报告语法错误。
2. 找出所有 `.json`，用 `node -e "JSON.parse(...)"` 校验，报告格式错误。
3. 读取 `miniprogram/app.json` 的 `pages`，确认每个页面的 `.js/.json/.wxml/.wxss` 四个文件都存在。
4. 提取所有 WXML 中的 `bindtap`、`catchtap`、`bindinput`、`bind:change`、`bind:submit` 等事件名，确认对应页面的 JS 里有同名方法。
5. 检查 `miniprogram/package.json`：如果有依赖但 `miniprogram/miniprogram_npm` 不存在，提醒需要「工具 → 构建 npm」。
6. 检查 `app.json` 的 tabBar 页面是否都在 pages 列表里。
7. 检查代码里引用的本地图片路径是否存在。

输出格式：先给「通过/失败」总览，再按严重程度列出问题（文件路径 + 行号 + 修复建议）。没有发现问题就明确说「全部通过」。
