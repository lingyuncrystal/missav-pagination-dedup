#!/usr/bin/env bash
#
# 一键发布 missav-pagination-dedup：
#   校验 → 提交 → 打 tag → 推送 GitHub
#
# GitHub 收到 push 后通过 Webhook 通知 Sleazyfork 拉取 raw 文件；
# Sleazyfork 仅当 @version 比线上版本新时才会发布新版本。
#
# 用法：
#   ./scripts/publish.sh ["提交说明"]     正式发布
#   ./scripts/publish.sh --dry-run        只跑检查，不提交、不推送
#
# 可选环境变量：
#   SLEAZYFORK_WEBHOOK_URL   若设置，发布时自动确保 GitHub webhook 已配置
#                            （在 Sleazyfork 脚本管理页的同步设置里生成）

set -euo pipefail

SCRIPT_FILE="missav-enhancer.user.js"
CHANGELOG_FILE="CHANGELOG.md"
REMOTE="origin"
BRANCH="main"
RAW_URL="https://raw.githubusercontent.com/lingyuncrystal/missav-pagination-dedup/main/missav-enhancer.user.js"

cd "$(dirname "$0")/.."

# ---------- 输出 ----------
if [ -t 1 ]; then
    C_BLUE=$'\033[1;34m'; C_GREEN=$'\033[1;32m'; C_YELLOW=$'\033[1;33m'; C_RED=$'\033[1;31m'; C_OFF=$'\033[0m'
else
    C_BLUE=''; C_GREEN=''; C_YELLOW=''; C_RED=''; C_OFF=''
fi
info() { printf '%s==>%s %s\n' "$C_BLUE"  "$C_OFF" "$*"; }
ok()   { printf '%s  ✓%s %s\n' "$C_GREEN" "$C_OFF" "$*"; }
warn() { printf '%s  !%s %s\n' "$C_YELLOW" "$C_OFF" "$*"; }
die()  { printf '%s错误：%s%s\n' "$C_RED" "$C_OFF" "$*" >&2; exit 1; }

# ---------- 语义化版本比较：$1 > $2 ? ----------
version_gt() {
    awk -v a="${1#v}" -v b="${2#v}" 'BEGIN{
        n = split(a, x, "."); m = split(b, y, ".");
        for (i = 1; i <= 4; i++) {
            xi = (i <= n) ? x[i] + 0 : 0;
            yi = (i <= m) ? y[i] + 0 : 0;
            if (xi > yi) exit 0;
            if (xi < yi) exit 1;
        }
        exit 1;
    }'
}

# ---------- 参数 ----------
DRY_RUN=0
COMMIT_MSG=""
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        *) COMMIT_MSG="$arg" ;;
    esac
done
[ "$DRY_RUN" = 1 ] && warn "dry-run 模式：只检查，不提交、不推送"

# ---------- 0. 分支检查 ----------
current_branch=$(git rev-parse --abbrev-ref HEAD)
[ "$current_branch" = "$BRANCH" ] || die "当前在分支 ${current_branch}，请先切换到 $BRANCH 再发布"

# ---------- 1. 语法检查 ----------
if command -v node >/dev/null 2>&1; then
    node --check "$SCRIPT_FILE" && ok "语法检查通过（node --check）"
else
    warn "未找到 node，跳过语法检查"
fi

# ---------- 2. 读取 @version ----------
version=$(grep -m1 '^// @version' "$SCRIPT_FILE" | sed -E 's|^// *@version +||' | tr -d '[:space:]')
[ -n "$version" ] || die "在 $SCRIPT_FILE 头部找不到 @version"
ok "当前版本：$version"

# ---------- 3. 与上一个 tag 比较 ----------
last_tag=$(git tag -l 'v*' --sort=-v:refname | head -1 || true)
if [ -n "$last_tag" ]; then
    last_version=${last_tag#v}
    if [ "$version" = "$last_version" ]; then
        if [ -z "$(git status --porcelain)" ]; then
            ok "v$version 已发布，且没有未提交的改动，无需发布"
            exit 0
        fi
        die "有未提交改动，但 @version 仍是 ${last_version}。请先 bump 版本号、更新 CHANGELOG 再发布"
    fi
    version_gt "$version" "$last_version" \
        || die "@version $version 没有大于上一个版本 ${last_version}（Sleazyfork 只接受更高版本）"
    ok "版本递增：$last_version → $version"
else
    warn "仓库还没有任何 tag，这将是第一个发布版本"
fi

# ---------- 4. CHANGELOG 检查与日期补全 ----------
grep -q "^## \[$version\]" "$CHANGELOG_FILE" \
    || die "CHANGELOG.md 没有 [$version] 条目，请先补充更新日志"
today=$(date +%F)
heading_line=$(grep -n "^## \[$version\]" "$CHANGELOG_FILE" | cut -d: -f1 | head -1)
heading=$(sed -n "${heading_line}p" "$CHANGELOG_FILE")
if [ "$heading" != "## [$version] - $today" ]; then
    escaped=$(printf '%s' "$version" | sed 's/[].[\*^$]/\\&/g')
    sed -i '' "${heading_line}s|^## \[$escaped\].*|## [$version] - $today|" "$CHANGELOG_FILE"
    ok "CHANGELOG 条目日期已更新为 $today"
else
    ok "CHANGELOG 条目已存在（${today}）"
fi

# ---------- 5. 提交改动 ----------
if [ -n "$(git status --porcelain)" ]; then
    msg=${COMMIT_MSG:-"release: v$version"}
    if [ "$DRY_RUN" = 1 ]; then
        info "dry-run：以下改动将以「${msg}」提交"
        git status --short
    else
        git add -A
        git commit -m "$msg" >/dev/null
        ok "已提交：$msg"
    fi
else
    ok "工作区干净，无需提交"
fi

# ---------- 6. 打 tag ----------
tag="v$version"
if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    die "tag $tag 已存在。Sleasyfork 不会重复发布同一版本，请 bump @version"
fi
if [ "$DRY_RUN" = 1 ]; then
    ok "将创建 tag $tag"
else
    git tag -a "$tag" -m "$tag"
    ok "已创建 tag $tag"
fi

# ---------- 7. 推送 GitHub ----------
# 直连经常被断（Empty reply / Connection reset / 长时间挂起）：
# 先试代理（可用 PROXY_URL 覆盖），失败再退回直连
PROXY="${PROXY_URL:-http://127.0.0.1:33210}"
if [ "$DRY_RUN" = 1 ]; then
    ok "将推送 $BRANCH 与 $tag 到 $REMOTE"
else
    if git -c http.proxy="$PROXY" push "$REMOTE" "$BRANCH" "$tag"; then
        ok "已推送到 GitHub（走代理 $PROXY）"
    else
        warn "代理推送失败，退回直连重试…"
        git push "$REMOTE" "$BRANCH" "$tag"
        ok "已推送到 GitHub（直连）"
    fi
fi

# ---------- 8. GitHub webhook（可选，需 SLEAZYFORK_WEBHOOK_URL） ----------
if [ "$DRY_RUN" = 0 ] && [ -n "${SLEAZYFORK_WEBHOOK_URL:-}" ]; then
    if command -v gh >/dev/null 2>&1; then
        existing=$(gh api repos/{owner}/{repo}/hooks --jq '.[] | select(.config.url == env.SLEAZYFORK_WEBHOOK_URL) | .id' || true)
        if [ -n "$existing" ]; then
            ok "GitHub webhook 已存在（hook id: ${existing}）"
        else
            hook_id=$(gh api repos/{owner}/{repo}/hooks -X POST \
                -f name=web -F active=true -F 'events[]=push' \
                -f "config.url=$SLEAZYFORK_WEBHOOK_URL" \
                -f config.content_type=json -F config.insecure_ssl=0 --jq .id)
            ok "GitHub webhook 已创建（hook id: ${hook_id}）"
        fi
    else
        warn "未找到 gh CLI，跳过 webhook 自动配置"
    fi
fi

# ---------- 9. 线上校验（尽力而为） ----------
info "校验线上文件…"
sleep 2
remote_version=$( { curl -fsSL --max-time 10 --proxy "$PROXY" "$RAW_URL" 2>/dev/null \
    || curl -fsSL --max-time 10 "$RAW_URL" 2>/dev/null; } \
    | grep -m1 '^// @version' | sed -E 's|^// *@version +||' | tr -d '[:space:]' || true)
if [ -z "$remote_version" ]; then
    warn "无法访问 ${RAW_URL}（网络受限？），跳过校验，请稍后在浏览器确认"
elif [ "$remote_version" = "$version" ]; then
    ok "GitHub raw 已是最新版本 $version"
else
    warn "GitHub raw 还是 ${remote_version}（CDN 可能有数秒延迟，稍后再确认）"
fi

# ---------- 完成 ----------
echo
info "发布完成"
echo "  GitHub    tag $tag 已推送"
echo "  Sleazyfork webhook 触发后自动同步（通常 1 分钟内），仅当 @version 更新时才发布"
echo "  若尚未在 Sleazyfork 配置同步，见 README「发布流程」"
