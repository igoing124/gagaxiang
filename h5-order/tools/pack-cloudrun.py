# -*- coding: utf-8 -*-
"""打包微信云托管部署包。

要点（踩过坑的地方）：
1. 必须用正斜杠写 zip 条目名 —— PowerShell Compress-Archive 会写成反斜杠，
   Linux Docker 构建时 COPY 找不到路径，直接构建失败。
2. 排除 node_modules / test / tools / *.md / start.bat / config.example.json。
3. data/ 与 default-data/ 中的「业务流水」类数据（订单/用户/用户优惠券）在包内
   置空，避免把本地测试数据带上生产；菜单与优惠券保留。
   —— 仅作用于包内内容，不修改本地文件。
4. 迁移旧数据时用 --seed 指定目录：该目录里的 orders.json / users.json /
   user-coupons.json / coupons.json / menu.json 会同时写进 data/ 与 default-data/，
   云托管首次启动（CFS 为空）时由 default-data 播种，覆盖掉「置空」逻辑。

用法：
    python tools/pack-cloudrun.py                     # 干净包，订单从 A001 开始
    python tools/pack-cloudrun.py --seed .seed        # 带上迁移过来的旧数据
"""
import argparse
import json
import os
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # h5-order/
OUT = os.path.join(os.path.dirname(ROOT), "云托管部署包.zip")  # 工作区根/

INCLUDE_FILES = [
    "Dockerfile",
    ".dockerignore",
    "package.json",
    "package-lock.json",
    "config.json",
    "server.js",
]
INCLUDE_DIRS = ["lib", "routes", "public"]

# 包内置空为 [] 的数据文件（业务流水）
EMPTY_ARRAYS = ["orders.json", "users.json", "user-coupons.json"]
DATA_DIRS = ["data", "default-data"]

EXCLUDE_NAMES = {"config.example.json"}
EXCLUDE_DIRS = {"backup-before-delivery", "backups"}


def add_file(z, abs_path, arc_name):
    z.write(abs_path, arc_name)


# --seed 目录里允许覆盖的数据文件
SEEDABLE = {
    "orders.json",
    "users.json",
    "user-coupons.json",
    "coupons.json",
    "menu.json",
}


def main():
    parser = argparse.ArgumentParser(description="打包微信云托管部署包")
    parser.add_argument(
        "--seed",
        default="",
        help="迁移数据目录：其中的 orders/users/user-coupons/coupons/menu 会打进包内",
    )
    parser.add_argument("--out", default=OUT, help="输出 zip 路径")
    args = parser.parse_args()

    seed_dir = args.seed
    seed_files = {}

    if seed_dir:
        if not os.path.isdir(seed_dir):
            raise SystemExit("--seed 目录不存在: " + seed_dir)
        for name in SEEDABLE:
            p = os.path.join(seed_dir, name)
            if os.path.exists(p):
                with open(p, "r", encoding="utf-8") as fh:
                    json.load(fh)  # 先校验是合法 JSON，别把坏数据打进包
                seed_files[name] = p

        if not seed_files:
            raise SystemExit("--seed 目录里没有可用的数据文件")

    out = args.out
    if os.path.exists(out):
        os.remove(out)

    written = []
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for name in INCLUDE_FILES:
            p = os.path.join(ROOT, name)
            if not os.path.exists(p):
                raise SystemExit("缺少必需文件: " + name)
            add_file(z, p, name)
            written.append(name)

        for d in INCLUDE_DIRS:
            base = os.path.join(ROOT, d)
            for dirpath, _dirnames, filenames in os.walk(base):
                for fn in filenames:
                    if fn in EXCLUDE_NAMES:
                        continue
                    abs_p = os.path.join(dirpath, fn)
                    arc = os.path.relpath(abs_p, ROOT).replace("\\", "/")
                    add_file(z, abs_p, arc)
                    written.append(arc)

        for d in DATA_DIRS:
            base = os.path.join(ROOT, d)
            for dirpath, dirnames, filenames in os.walk(base):
                dirnames[:] = [x for x in dirnames if x not in EXCLUDE_DIRS]
                for fn in filenames:
                    abs_p = os.path.join(dirpath, fn)
                    arc = os.path.relpath(abs_p, ROOT).replace("\\", "/")

                    if fn in seed_files:
                        # 迁移数据优先：data/ 与 default-data/ 都写成同一份
                        z.write(seed_files[fn], arc)
                    elif fn in EMPTY_ARRAYS:
                        z.writestr(arc, "[]\n")
                    else:
                        add_file(z, abs_p, arc)

                    written.append(arc)

    print("已生成:", out)
    print("条目数:", len(written))
    if seed_files:
        print("已注入迁移数据:", ", ".join(sorted(seed_files)))
    for n in sorted(written):
        print("  -", n)


if __name__ == "__main__":
    main()
