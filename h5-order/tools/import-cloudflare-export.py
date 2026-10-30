#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 Cloudflare 商家后台导出的 JSON 备份，转换成微信云托管用的数据文件。

用法：
    python tools/import-cloudflare-export.py backup-20261029.json --out .seed
    python tools/pack-cloudrun.py --seed .seed

输入（Cloudflare /api/admin/export 的返回）：
    { exportedAt, menu, orders, users, couponTemplates, userCoupons, dishImages }

输出（写入 --out 目录）：
    orders.json  users.json  user-coupons.json  coupons.json  menu.json

说明：
  * 两套后端是同一份代码演化出来的，订单 / 用户 / 用户券 / 菜单的字段完全一致，
    所以这里做的是「原样搬运 + 字段校验」，不重新计算金额。
  * 菜品图片在 Cloudflare 上是 /api/menu/image/<key>/<version> 这种地址，
    云托管版只接受 data:image/... 内联图。遇到这种地址会直接报错，
    需要在云托管后台重新上传一次菜品图片（菜单其余字段照常迁移）。
"""

import argparse
import json
import os
import sys

REQUIRED_KEYS = ("menu", "orders", "users", "couponTemplates", "userCoupons")
OUTPUT_FILES = {
    "menu": "menu.json",
    "orders": "orders.json",
    "users": "users.json",
    "couponTemplates": "coupons.json",
    "userCoupons": "user-coupons.json",
}


def fail(message):
    print("错误：" + message, file=sys.stderr)
    raise SystemExit(1)


def load_backup(path):
    if not os.path.exists(path):
        fail("找不到备份文件：" + path)

    with open(path, "r", encoding="utf-8-sig") as fh:
        try:
            data = json.load(fh)
        except json.JSONDecodeError as err:
            fail("备份不是合法 JSON：" + str(err))

    if not isinstance(data, dict):
        fail("备份格式不对：顶层应该是对象（含 menu / orders / users ...）")

    missing = [key for key in REQUIRED_KEYS if key not in data]
    if missing:
        fail("备份缺少字段：" + "、".join(missing) + "（是不是导错了文件？）")

    for key in REQUIRED_KEYS:
        if not isinstance(data[key], list):
            fail("字段 " + key + " 应该是数组")

    return data


def check_menu_images(menu):
    remote = [
        dish.get("name") or dish.get("id") or "?"
        for dish in menu
        if str(dish.get("imageUrl") or "").startswith("/api/menu/image/")
    ]

    if remote:
        fail(
            "有 %d 道菜的图片还是 Cloudflare 的地址（%s）。\n"
            "      云托管版只接受内联图片，请先在云托管后台把这几个菜重新上传图片，\n"
            "      或者把备份里的 imageUrl 清空后再导入（其余字段不受影响）。"
            % (len(remote), "、".join(remote[:5]))
        )


def write_json(out_dir, name, payload):
    path = os.path.join(out_dir, name)
    tmp = path + ".tmp"

    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    os.replace(tmp, path)
    return path


def main():
    parser = argparse.ArgumentParser(
        description="Cloudflare 备份 → 云托管数据文件"
    )
    parser.add_argument("backup", help="商家后台导出的 JSON 备份文件")
    parser.add_argument(
        "--out",
        default=".seed",
        help="输出目录（默认 .seed），随后用 pack-cloudrun.py --seed 打进部署包",
    )
    parser.add_argument(
        "--allow-remote-images",
        action="store_true",
        help="遇到 Cloudflare 图片地址时不清空、直接搬运（不推荐，云托管上会 404）",
    )
    args = parser.parse_args()

    data = load_backup(args.backup)

    if not args.allow_remote_images:
        check_menu_images(data["menu"])

    os.makedirs(args.out, exist_ok=True)

    print("备份时间：", data.get("exportedAt") or "未知")
    print("迁移明细：")

    for key, filename in OUTPUT_FILES.items():
        payload = data[key]
        write_json(args.out, filename, payload)
        print("  %-18s %4d 条 → %s" % (key, len(payload), filename))

    # 菜单里如果带了 Cloudflare 的图片地址，明确告诉用户这批菜需要重新传图
    remote_images = [
        dish.get("name") or dish.get("id")
        for dish in data["menu"]
        if str(dish.get("imageUrl") or "").startswith("/api/menu/image/")
    ]
    if remote_images:
        print(
            "\n注意：%d 道菜的图片地址还是 Cloudflare 的，云托管上会打不开，"
            "需要在后台重新上传：%s" % (len(remote_images), "、".join(remote_images[:8]))
        )

    print("\n下一步：python tools/pack-cloudrun.py --seed " + args.out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
