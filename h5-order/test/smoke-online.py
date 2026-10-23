# -*- coding: utf-8 -*-
"""线上端到端冒烟测试：登录 -> 完善资料 -> 下单"""
import json
import sys
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "https://chuan-chuan-order.app.workbuddy.host"
SHARE = "?sharecode=GKXJKJNW4S" if "workbuddy.host" in BASE else ""


def post(path, payload, token=None):
    req = urllib.request.Request(
        BASE + path + SHARE,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    if token:
        req.add_header("x-user-token", token)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode("utf-8"))


# 1. 登录（普通浏览器场景：静默创建本机账号）
status, login = post("/api/auth/login", {"localOnly": True})
print("1) 登录:", status, login.get("mode"), "token获取:", bool(login.get("token")))
token = login["token"]

# 2. 完善资料
status, profile = post(
    "/api/auth/profile",
    {"nickname": "系统冒烟测试", "phone": "13800000000",
     "avatar": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="},
    token=token,
)
print("2) 资料:", status, json.dumps(profile, ensure_ascii=False)[:200])

# 3. 下单（测试订单，备注已标明）
status, order = post(
    "/api/order",
    {
        "items": [{"id": "wo_sun", "count": 2}],
        "recipientName": "冒烟测试",
        "phone": "13800000000",
        "address": "测试地址-请勿配送",
        "note": "系统自动测试订单，可直接拒单",
    },
    token=token,
)
print("3) 下单:", status)
if status == 201:
    print("   取号:", order.get("pickupNo"), "| 状态:", order.get("status"),
          "| 金额(分):", order.get("totalCents"), "| 订单号:", order.get("id"))
    print("   结论: 顾客在线下单链路完整可用 ✓")
else:
    print("   失败详情:", order)
