#!/usr/bin/env bash
# 一键提交并推送到 GitHub
# 用法：bash tools/push.sh "提交说明"
#       bash tools/push.sh            （不填说明则用时间戳）

set -euo pipefail

cd "$(dirname "$0")/.."

# 清掉可能劫持 Git 流量的代理环境变量（沙箱/工具链常注入，会导致连接被重置）
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy

# ---- 1. 环境检查 ----
if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[错误] 当前目录不是 Git 仓库"
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "[错误] 未配置远程仓库，请先执行："
  echo "       git remote add origin git@github.com:igoing124/gagaxiang.git"
  exit 1
fi

# 远程地址必须是 SSH，否则会走 HTTPS 并被网络干扰
REMOTE_URL=$(git remote get-url origin)
case "$REMOTE_URL" in
  git@*|ssh://*) ;;
  *)
    echo "[修正] 远程地址是 HTTPS，正在切换为 SSH（避免网络重置）"
    git remote set-url origin git@github.com:igoing124/gagaxiang.git
    ;;
esac

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

# ---- 5. 推送 ----
# 走 SSH（ssh.github.com:443），不依赖任何本地代理
echo "[3/3] 推送..."
if ! git push 2>&1 | tee /tmp/gitpush.log | grep -qE '^To |Everything up-to-date'; then
  echo
  echo "[失败] 推送未成功，上方为原始输出。排查顺序："
  echo "  1. 执行 ssh -T git@github.com 看密钥是否仍有效"
  echo "  2. 执行 git remote -v 确认地址是 git@github.com: 开头（SSH），不是 https://"
  echo "  3. 若报 Permission denied，需把 ~/.ssh/id_ed25519.pub 内容加到 GitHub 账号"
  exit 3
fi

echo "[完成] 已推送到 https://github.com/igoing124/gagaxiang"
