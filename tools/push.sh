#!/usr/bin/env bash
# 一键提交并推送到 GitHub
# 用法：bash tools/push.sh "提交说明"
#       bash tools/push.sh            （不填说明则用时间戳）

set -euo pipefail

cd "$(dirname "$0")/.."

# ---- 1. 环境检查 ----
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[错误] 当前目录不是 Git 仓库"
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "[错误] 未配置远程仓库，请先执行："
  echo "       git remote add origin https://github.com/igoing124/gagaxiang.git"
  exit 1
fi

# ---- 2. 变更检查 ----
if [ -z "$(git status --porcelain)" ]; then
  echo "[提示] 没有需要提交的改动，工作区是干净的"
  exit 0
fi

# ---- 3. 敏感文件拦截 ----
# 列出这次会进入提交的文件，命中敏感关键字就中止
SUSPECT=$(git status --porcelain | awk '{print $2}' | grep -E \
  '登录信息|密码|口令|password|passwd|\.env$|\.dev\.vars|secret|token|\.pem$|\.key$|credential' \
  || true)

if [ -n "$SUSPECT" ]; then
  echo "[警告] 以下文件疑似包含凭据，已中止提交："
  echo "$SUSPECT" | sed 's/^/         /'
  echo
  echo "  确认无敏感内容后，把它们加入 .gitignore，或手动执行 git add 单独处理。"
  exit 2
fi

# ---- 4. 提交 ----
MSG="${1:-}"
if [ -z "$MSG" ]; then
  MSG="update: $(date '+%Y-%m-%d %H:%M')"
fi

echo "[1/3] 暂存改动..."
git add -A
git status --short | sed 's/^/      /'

echo "[2/3] 提交：$MSG"
git commit -q -m "$MSG"

# ---- 5. 代理检查 ----
# 网络不通时自动尝试 FlClash 的 7890 端口
echo "[3/3] 推送..."
if ! git push 2>&1 | tee /tmp/gitpush.log | grep -qE '^To |Everything up-to-date'; then
  if grep -qE 'schannel|Could not resolve|Failed to connect|Connection' /tmp/gitpush.log 2>/dev/null; then
    echo "[提示] 网络异常，尝试使用本地代理 127.0.0.1:7890 重试..."
    if git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push; then
      echo "[完成] 已通过代理推送成功"
      echo "       若经常需要，执行：git config http.proxy http://127.0.0.1:7890"
      exit 0
    fi
    echo "[失败] 代理也推送不成功。请确认 FlClash 是否已开启。"
    exit 3
  fi
  echo "[失败] 推送未成功，上方为原始输出"
  exit 3
fi

echo "[完成] 已推送到 https://github.com/igoing124/gagaxiang"
