// tools/sync-menu.js —— 从小程序目录同步菜单模板到 H5
// 用法：在 h5-order 目录执行 node tools/sync-menu.js
//
// 注意：这个脚本只更新 data/menu.js（菜单源文件）。
// data/menu.json 是商家后台实际使用的可变菜单；
// 如果想让商家改价/上下架全部重置为小程序菜单，
// 先备份，再删除 data/menu.json 后重启服务。
const fs = require('fs');
const path = require('path');

const source = path.join(__dirname, '..', '..', 'miniprogram', 'data', 'goods.js');
const target = path.join(__dirname, '..', 'data', 'menu.js');

delete require.cache[require.resolve(source)];
const goods = require(source);

const normalized = goods.map((g) => ({
  id: String(g.id),
  emoji: g.emoji || '🍢',
  name: String(g.name || ''),
  category: String(g.category || '其他'),
  desc: String(g.desc || ''),
  price: Number(g.price) || 0,
  unit: String(g.unit || '份'),
  tag: String(g.tag || ''),
  soldOut: !!g.soldOut,
}));

const content = `// h5-order/data/menu.js
// 从 ..\\miniprogram\\data\\goods.js 复制而来，共 ${normalized.length} 道菜。
// 这是菜单模板；商家后台实际使用 data/menu.json。
// 如果小程序菜单有改动，重新运行 h5-order/tools/sync-menu.js 同步模板。
module.exports = ${JSON.stringify(normalized, null, 2)};
`;

fs.writeFileSync(target, content);
console.log('已同步菜单模板', normalized.length, '道菜到 data/menu.js');
console.log('提示：data/menu.json 不会被覆盖，商家改过的价格和上下架状态会保留。');
