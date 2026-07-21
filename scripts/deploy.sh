#!/usr/bin/env bash
# tank_war 一键部署脚本:VITE_BASE 构建 + rsync 上传 + nginx reload
# ============================================================
# 配置通过环境变量覆盖(默认值=当前部署环境),换机器/路径时覆盖即可:
#   TANK_HOST  服务器(默认 root@119.29.2.189)
#   TANK_KEY   SSH 私钥路径(默认 ~/Desktop/ssh/tencent_com.pem)
#   TANK_DIR   服务器目标目录(默认 /usr/share/nginx/html/tank)
#   TANK_BASE  部署子路径 base(默认 /tank/,须首尾带 /)
#   TANK_PORT  访问端口(默认 8080)
# 用法: npm run deploy
# 示例: TANK_BASE=/tank2/ TANK_DIR=/usr/share/nginx/html/tank2 npm run deploy
set -euo pipefail

HOST="${TANK_HOST:-root@119.29.2.189}"
KEY="${TANK_KEY:-/Users/finlaywu/Desktop/ssh/tencent_com.pem}"
DIR="${TANK_DIR:-/usr/share/nginx/html/tank}"
BASE="${TANK_BASE:-/tank/}"
PORT="${TANK_PORT:-8080}"

# 校验私钥存在
if [ ! -f "$KEY" ]; then
  echo "✗ 私钥不存在: $KEY (用 TANK_KEY= 覆盖)" >&2
  exit 1
fi
chmod 600 "$KEY" 2>/dev/null || true

SSH="ssh -i $KEY -o BatchMode=yes"

echo "[1/3] 构建 (VITE_BASE=$BASE)"
VITE_BASE="$BASE" npm run build

echo "[2/3] 上传 dist/ → $HOST:$DIR"
rsync -az --delete -e "ssh -i $KEY -o BatchMode=yes" dist/ "$HOST:$DIR/"

echo "[3/3] nginx reload"
$SSH "$HOST" 'nginx -s reload'

IP="${HOST#*@}" # 去掉 user@ 前缀
echo ""
echo "✓ 部署完成 → http://$IP:$PORT$BASE"
