#!/usr/bin/env bash
#
# 发布研发版到 GitHub dev 分支：校验 → 提交 → 推送。
# 不创建 tag，不触发 SleazyFork 正式同步。
#
# 用法：
#   ./scripts/publish-dev.sh "研发改动说明"
#   ./scripts/publish-dev.sh --dry-run

set -euo pipefail

SCRIPT_FILE="missav-enhancer.user.js"
BRANCH="dev"
REMOTE="origin"
DRY_RUN=0
COMMIT_MSG=""

info() { printf '%s\n' "$*"; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*"; }
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *) COMMIT_MSG="$arg" ;;
    esac
done

cd "$(dirname "$0")/.."
[ "$(git rev-parse --abbrev-ref HEAD)" = "$BRANCH" ] || die "当前不在 dev 分支"

node --check "$SCRIPT_FILE"
ok "语法检查通过（node --check）"

if [ -f "/Users/Alan/.agents/skills/scriptcat-userscript/scripts/check.mjs" ]; then
    node /Users/Alan/.agents/skills/scriptcat-userscript/scripts/check.mjs "$SCRIPT_FILE"
    ok "ScriptCat 静态检查通过"
fi

version=$(grep -m1 '^// @version' "$SCRIPT_FILE" | sed -E 's|^// *@version +||' | tr -d '[:space:]')
printf '%s\n' "$version" | grep -Eq '^4\.0\.[0-9]+-dev\.[0-9]+$' \
    || die "研发版 @version 必须符合 4.0.x-dev.N，当前为 $version"
ok "研发版版本：$version"

git diff --check
ok "diff 检查通过"

if [ -n "$(git status --porcelain)" ]; then
    msg=${COMMIT_MSG:-"dev: update $version"}
    if [ "$DRY_RUN" = 1 ]; then
        info "dry-run：以下改动将以「${msg}」提交"
        git status --short
    else
        git add -A
        git commit -m "$msg" >/dev/null
        ok "已提交：${msg}"
    fi
else
    ok "工作区干净"
fi

if [ "$DRY_RUN" = 1 ]; then
    ok "将推送 ${BRANCH} 到 ${REMOTE}（不创建 tag、不触发正式发布）"
else
    PROXY="${PROXY_URL:-http://127.0.0.1:33210}"
    if git -c http.proxy="$PROXY" push "$REMOTE" "$BRANCH"; then
        ok "已推送研发版到 GitHub dev"
    else
        warn "代理推送失败，退回直连重试…"
        git push "$REMOTE" "$BRANCH"
        ok "已推送研发版到 GitHub dev"
    fi
fi

info "研发版 Raw：https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/dev/missav-enhancer.user.js"
