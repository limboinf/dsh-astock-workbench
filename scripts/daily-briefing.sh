#!/usr/bin/env bash
#
# 每日收盘简报：系统 cron 调用本脚本 → dsh headless 跑一个全新会话 →
# 模型调用 astock_* 工具取数 → 简报（stdout）落盘到 briefings/<日期>.md
#
# crontab 示例（交易日周一至周五 16:10，A 股 15:00 收盘后留足数据稳定时间）：
#   10 16 * * 1-5 /Users/limbo/work/github/dsh-astock-workbench/scripts/daily-briefing.sh >> "$HOME/.dsh/astock-workbench/cron.log" 2>&1
#
# API key：cron 环境不加载 shell 配置。把 DEEPSEEK_API_KEY 写入
#   $HOME/.dsh/astock-workbench/env
# 内容一行：export DEEPSEEK_API_KEY=sk-xxx

set -euo pipefail

DSH_REPO="${DSH_REPO:-$HOME/work/github/deepseek-harness}"
DATA_DIR="${ASTOCK_DATA_DIR:-$HOME/.dsh/astock-workbench}"
PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# cron 环境补载 API key
# shellcheck disable=SC1091
[ -f "$DATA_DIR/env" ] && . "$DATA_DIR/env"

OUT_DIR="$DATA_DIR/briefings"
mkdir -p "$OUT_DIR"
TODAY="$(TZ=Asia/Shanghai date +%F)"
OUT_FILE="$OUT_DIR/$TODAY.md"

PROMPT="现在是 A 股收盘后。请调用 astock_positions 工具读取我的持仓与实时行情，并按 astock-briefing 技能的规范生成今日持仓简报。要求：所有数字直接引用工具返回文本，禁止心算改写；把简报全文作为你的最终回复输出。"

cd "$DATA_DIR"

# 先写临时文件再落盘：dsh 中途失败时不留下半截简报覆盖当天文件
TMP_FILE="$(mktemp "$OUT_FILE.XXXXXX")"
trap 'rm -f "$TMP_FILE"' EXIT

if pnpm --dir "$DSH_REPO" dsh --profile headless --patch "$PLUGIN_DIR/cordis.dev.patch.yml" "$PROMPT" > "$TMP_FILE"; then
  mv "$TMP_FILE" "$OUT_FILE"
  trap - EXIT
  echo "[$(date '+%F %T')] 简报已生成：$OUT_FILE"
else
  # 失败时保留半截输出便于排查（错误流进 cron.log，但模型已吐出的内容只有这里能看到）
  mv "$TMP_FILE" "$OUT_FILE.partial"
  trap - EXIT
  echo "[$(date '+%F %T')] 简报生成失败，半截输出见：$OUT_FILE.partial" >&2
  exit 1
fi
