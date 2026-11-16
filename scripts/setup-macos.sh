#!/bin/bash
set -euo pipefail
umask 077

# The public preview is versioned because GitHub's /latest skips prereleases.
release_version=0.2.1
release_base=https://github.com/avad-technologies/rndevtools/releases/download
app_name='RN Devtools.app'
publisher='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "434X69L4Z5"'
app_identifier=io.github.adalloul0928.rndevtools

usage() {
    cat <<'EOF'
Usage: bash scripts/setup-macos.sh [--agents codex,claude] [--applications-dir /absolute/path] [--dmg /absolute/file.dmg]

Install or upgrade RN Devtools and configure Codex and Claude Code.
Setup restarts an older desktop and restores its active lanes. A new copy
goes into ~/Applications. Supply --dmg to use an official, notarized DMG.
Use --agents codex or --agents claude to configure one client.
EOF
}

fail() {
    printf '%s\n' "$*" >&2
    exit 1
}

agents=codex,claude
applications_dir=
dmg=
while (( $# )); do
    case "$1" in
        --help|-h) usage; exit 0 ;;
        --agents|--applications-dir|--dmg)
            (( $# >= 2 )) || fail "$1 requires a value."
            case "$1" in
                --agents) agents=$2 ;;
                --applications-dir) applications_dir=$2 ;;
                --dmg) dmg=$2 ;;
            esac
            shift 2
            ;;
        *) fail "Unknown option: $1. See --help." ;;
    esac
done

case "$agents" in
    codex|claude|codex,claude|claude,codex) ;;
    *) fail 'Choose codex, claude, or codex,claude with --agents.' ;;
esac
[[ $(/usr/bin/uname -s) == Darwin ]] || fail 'RN Devtools setup requires macOS.'
[[ $(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null) == 1 ]] || fail 'The downloadable desktop requires Apple silicon.'
(( EUID != 0 )) || fail 'Run setup as the macOS user who will use RN Devtools.'
if [[ -n "$dmg" ]]; then
    [[ "$dmg" == /* && -f "$dmg" ]] || fail 'Pass an absolute path to an existing DMG.'
fi
if [[ -z "$applications_dir" ]]; then
    applications_dir="$HOME/Applications"
    if [[ -e "/Applications/$app_name" || -L "/Applications/$app_name" || -d /Applications/.rndevtools-upgrade ]]; then
        applications_dir=/Applications
    fi
fi
[[ "$applications_dir" == /* ]] || fail 'Pass an absolute path for --applications-dir.'
app="$applications_dir/$app_name"
cli="$app/Contents/Resources/native/rndevtools"
script_dir=$(cd "$(/usr/bin/dirname "${BASH_SOURCE[0]}")" && pwd -P)

# Every installed copy uses the same per-user desktop socket and agent config.
lock_dir="$HOME/Library/Application Support/RN Devtools/setup"
/bin/mkdir -p "$lock_dir"
if [[ ${RNDEVTOOLS_SETUP_LOCK-} != "$lock_dir/lock" ]]; then
    set -- --agents "$agents" --applications-dir "$applications_dir"
    if [[ -n "$dmg" ]]; then set -- "$@" --dmg "$dmg"; fi
    exec /usr/bin/lockf -k -t 0 "$lock_dir/lock" /usr/bin/env \
        RNDEVTOOLS_SETUP_LOCK="$lock_dir/lock" /bin/bash "$script_dir/setup-macos.sh" "$@"
fi

scratch=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/rndevtools-setup.XXXXXXXX")
staging=
mount_dir="$scratch/mounted"
mounted=false
transaction="$applications_dir/.rndevtools-upgrade"
backup="$transaction/previous.app"
plan="$transaction/lanes.json"
rollback_pending=false
installed_candidate=false
cleanup() {
    local status=$?
    if $rollback_pending; then
        if roll_back; then
            printf 'Reopened the previous RN Devtools. Run setup again to retry the upgrade.\n' >&2
        else
            printf 'Could not complete rollback. The upgrade files are in %s.\n' "$transaction" >&2
        fi
    fi
    if [[ -n "$staging" ]]; then
        /bin/rm -rf "$staging"
    fi
    if $mounted && ! /usr/bin/hdiutil detach "$mount_dir" >/dev/null; then
        printf 'Could not eject %s. Eject it before removing %s.\n' "$mount_dir" "$scratch" >&2
        return "$status"
    fi
    /bin/rm -rf "$scratch"
    return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_app() {
    local bundle=$1
    [[ -d "$bundle" && ! -L "$bundle" && -x "$bundle/Contents/Resources/native/rndevtools" ]] &&
        /usr/bin/codesign --verify --deep --strict -R="$publisher and identifier \"$app_identifier\"" "$bundle"
}

installer_state() {
    /usr/bin/osascript -l JavaScript "$script_dir/setup-macos-state.js" "$@"
}

bundle_version() {
    /usr/bin/plutil -extract CFBundleShortVersionString raw -expect string -o - "$1/Contents/Info.plist"
}

quit_desktop() {
    local pid deadline
    pid=$(installer_state quit "$app_identifier" "$app") || return 1
    if [[ "$pid" == stopped ]]; then return 0; fi
    # The desktop drains its lane and native services before it exits.
    deadline=$((SECONDS + 120))
    while /bin/kill -0 "$pid" 2>/dev/null; do
        if (( SECONDS >= deadline )); then
            printf 'RN Devtools is still quitting.\n' >&2
            return 1
        fi
        /bin/sleep 1
    done
    [[ $(installer_state status "$app_identifier" "$app") == stopped ]]
}

start_desktop() {
    local status opened=false deadline=$((SECONDS + 60))
    while (( SECONDS < deadline )); do
        status=$(installer_state status "$app_identifier" "$app") || return 1
        if [[ "$status" == running ]]; then
            if "$cli" jobs --operation list --request-timeout-ms 3000 > "$scratch/connection-result" 2>&1; then return 0; fi
        elif ! $opened; then
            /usr/bin/open -a "$app" || return 1
            opened=true
        fi
        /bin/sleep 1
    done
    if [[ -s "$scratch/connection-result" ]]; then /bin/cat "$scratch/connection-result" >&2; fi
    return 1
}

read_lanes() {
    "$cli" lane --operation ls --request-timeout-ms 15000 > "$1"
}

read_lane_status() {
    read_lanes "$scratch/current-lanes.json" || return 1
    "$cli" simulators --request-timeout-ms 15000 > "$scratch/current-simulators.json" || return 1
    installer_state lane-status "$plan" "$1" "$scratch/current-lanes.json" "$scratch/current-simulators.json"
}

restore_lane() {
    local index=$1 status deadline worktree branch expected_branch attempt retryable
    status=$(read_lane_status "$index") || return 1
    if [[ "$status" == ready ]]; then return 0; fi
    worktree=$(/usr/bin/plutil -extract "lanes.$index.worktreePath" raw -o - "$plan") || return 1
    expected_branch=$(/usr/bin/plutil -extract "lanes.$index.branch" raw -o - "$plan") || return 1
    if branch=$(/usr/bin/git -C "$worktree" symbolic-ref --quiet HEAD); then
        branch=${branch#refs/heads/}
    elif /usr/bin/git -C "$worktree" rev-parse --verify HEAD > /dev/null; then
        branch=detached
    else
        return 1
    fi
    if [[ "$branch" != "$expected_branch" ]]; then
        printf 'The branch in %s changed during the upgrade.\n' "$worktree" >&2
        return 1
    fi
    installer_state request "$plan" "$index" > "$scratch/lane-request.json" || return 1
    # Use the recorded lane owner. A lane created in the desktop has no agent.
    for attempt in 1 2; do
        if /usr/bin/env -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID -u RNDEVTOOLS_AGENT_SESSION_ID \
            "$cli" lane --stdin --request-timeout-ms 120000 \
            < "$scratch/lane-request.json" > "$scratch/lane-result.json" 2>&1; then
            break
        fi
        retryable=$(/usr/bin/plutil -extract error.retryable raw -o - "$scratch/lane-result.json" 2>/dev/null) || retryable=false
        /usr/bin/plutil -extract error.message raw -o - "$scratch/lane-result.json" >&2 || true
        if [[ "$attempt" == 2 || "$retryable" != true ]]; then return 1; fi
        /bin/sleep 2
        status=$(read_lane_status "$index") || return 1
        if [[ "$status" == ready ]]; then return 0; fi
    done
    deadline=$((SECONDS + 180))
    while (( SECONDS < deadline )); do
        status=$(read_lane_status "$index") || return 1
        if [[ "$status" == ready ]]; then return 0; fi
        /bin/sleep 2
    done
    return 1
}

restore_lanes() {
    local count index id failures=0
    if [[ ! -f "$plan" ]]; then return 0; fi
    count=$(/usr/bin/plutil -extract lanes raw -expect array -o - "$plan") || return 1
    for (( index=0; index<count; index++ )); do
        id=$(/usr/bin/plutil -extract "lanes.$index.id" raw -o - "$plan") || return 1
        if restore_lane "$index"; then
            printf 'Lane %s is ready on its original Simulator and Metro port.\n' "$id"
        else
            printf 'Lane %s needs recovery. Its saved configuration is in %s.\n' "$id" "$plan" >&2
            failures=$((failures + 1))
        fi
    done
    (( failures == 0 ))
}

finish_transaction() {
    # Only remove files owned by this transaction.
    if [[ -d "$backup" ]]; then
        verify_app "$backup" || return 1
        /bin/rm -rf "$backup" || return 1
    fi
    /bin/rm -f "$plan" "$transaction/lanes.pending" || return 1
    /bin/rmdir "$transaction"
}

roll_back() {
    if [[ -d "$backup" ]]; then
        verify_app "$backup" || return 1
        if [[ -e "$app" ]]; then
            $installed_candidate || return 1
            verify_app "$app" || return 1
            quit_desktop || return 1
            /bin/mv "$app" "$staging/failed.app" || return 1
        fi
        /bin/mv "$backup" "$app" || return 1
    fi
    start_desktop || return 1
    restore_lanes || return 1
    finish_transaction
}

stage_download() {
    local expected_version=
    if [[ -z "$dmg" ]]; then
        expected_version=$release_version
        dmg="$scratch/RN-Devtools.dmg"
        printf 'Downloading RN Devtools %s…\n' "$release_version"
        /usr/bin/curl -q --fail --location --silent --show-error --retry 2 \
            --connect-timeout 15 --max-time 300 --proto '=https' --proto-redir '=https' \
            --output "$dmg" "$release_base/desktop-v$release_version/RN-Devtools-$release_version-arm64.dmg"
    fi
    /usr/bin/codesign --verify --strict -R="$publisher" "$dmg" || fail 'The DMG failed the RN Devtools publisher signature check.'
    /usr/sbin/spctl --assess --type open --context context:primary-signature "$dmg" || fail 'Gatekeeper rejected the RN Devtools DMG.'
    /bin/mkdir "$mount_dir"
    /usr/bin/hdiutil attach -readonly -nobrowse -mountpoint "$mount_dir" "$dmg" >/dev/null
    mounted=true
    /usr/sbin/spctl --assess --type execute "$mount_dir/$app_name" || fail 'Gatekeeper rejected the app in the DMG.'
    downloaded_version=$(bundle_version "$mount_dir/$app_name")
    if [[ -n "$expected_version" ]]; then
        [[ "$downloaded_version" == "$expected_version" ]] || fail "The downloaded app is version $downloaded_version. Expected $expected_version."
    fi
    /bin/mkdir -p "$applications_dir"
    staging=$(/usr/bin/mktemp -d "$applications_dir/.rndevtools-setup.XXXXXXXX")
    /usr/bin/ditto "$mount_dir/$app_name" "$staging/$app_name"
    verify_app "$staging/$app_name" || fail 'The copied app failed the RN Devtools signature check.'
}

prepare_upgrade() {
    local status
    status=$(installer_state status "$app_identifier" "$app")
    /bin/mkdir -m 700 "$transaction"
    if [[ "$status" == running ]]; then
        read_lanes "$scratch/old-lanes.json"
        installer_state snapshot "$scratch/old-lanes.json" > "$transaction/lanes.pending"
    else
        printf '%s\n' '{"lanes":[]}' > "$transaction/lanes.pending"
    fi
    /bin/mv "$transaction/lanes.pending" "$plan"
    rollback_pending=true
    quit_desktop
    /bin/mv "$app" "$backup"
}

# Recover a plan left by an interrupted swap or an unfinished lane restore.
if [[ -e "$transaction" || -L "$transaction" ]]; then
    [[ -d "$transaction" && ! -L "$transaction" && -O "$transaction" ]] || fail "Cannot use upgrade directory $transaction."
    if [[ ! -e "$app" ]]; then
        verify_app "$backup" || fail "Cannot restore the previous app at $backup."
        /bin/mv "$backup" "$app"
    fi
    verify_app "$app" || fail "The existing app at $app failed verification."
    start_desktop || fail "RN Devtools could not reopen. The upgrade files are in $transaction."
    restore_lanes || fail 'Lane recovery is incomplete. Rerun setup to retry.'
    finish_transaction || fail "Could not clear completed upgrade files in $transaction."
fi

installed_version=
download=true
if [[ -e "$app" || -L "$app" ]]; then
    verify_app "$app" || fail "The installed app at $app failed the RN Devtools signature check."
    installed_version=$(bundle_version "$app")
    if [[ -z "$dmg" ]]; then
        order=$(installer_state compare "$release_version" "$installed_version")
        if [[ "$order" != 1 ]]; then download=false; fi
    fi
fi

if $download; then
    stage_download
    installer_state status "$app_identifier" "$app" > /dev/null
    if [[ -n "$installed_version" ]]; then
        order=$(installer_state compare "$downloaded_version" "$installed_version")
        if [[ "$order" != 1 ]]; then download=false; fi
    fi
fi

if $download; then
    if [[ -n "$installed_version" ]]; then prepare_upgrade; fi
    /bin/mv -n "$staging/$app_name" "$applications_dir/"
    [[ ! -e "$staging/$app_name" ]] || fail "The installation path $app became occupied."
    installed_candidate=true
    verify_app "$app" || fail "The app at $app failed the RN Devtools signature check."
    printf 'Installed RN Devtools %s at %s.\n' "$downloaded_version" "$app"
else
    printf 'Using RN Devtools %s at %s.\n' "$installed_version" "$app"
fi

start_desktop || fail 'RN Devtools did not become reachable. Open it in your macOS session and rerun setup.'
if $rollback_pending; then
    rollback_pending=false
    restore_lanes || fail 'RN Devtools was upgraded. Rerun setup to finish lane recovery.'
    finish_transaction || fail "Could not clear completed upgrade files in $transaction."
fi

skipped=false
configure() {
    local client=$1 report="$scratch/setup.json" count index action detail file
    shift
    "$cli" setup --agents "$client" "$@" > "$report"
    [[ $(/usr/bin/plutil -extract doctor.ok raw -o - "$report") == true ]] || fail 'RN Devtools setup could not verify the desktop connection.'
    count=$(/usr/bin/plutil -extract changes raw -expect array -o - "$report")
    for (( index=0; index<count; index++ )); do
        action=$(/usr/bin/plutil -extract "changes.$index.action" raw -o - "$report")
        if [[ "$action" == skip ]]; then
            file=$(/usr/bin/plutil -extract "changes.$index.path" raw -o - "$report")
            detail=$(/usr/bin/plutil -extract "changes.$index.detail" raw -o - "$report")
            printf 'Skipped %s (%s)\n' "$file" "$detail" >&2
            skipped=true
        fi
    done
}

help_text=$("$cli" setup --help)
if [[ "$help_text" == *--codex-hooks* ]]; then
    configure "$agents"
else
    if [[ "$agents" == *codex* ]]; then
        # The 0.2.0 CLI installs Codex hooks by default. Keep this path prompt-free.
        configure codex --no-hook
        printf 'This build supports Codex MCP and skills. Run setup again after installing a build with Codex command rules.\n'
    fi
    if [[ "$agents" == *claude* ]]; then
        configure claude
    fi
fi

if $skipped; then
    fail 'RN Devtools is reachable. Review the skipped settings above before starting a new agent session.'
fi
printf 'RN Devtools is reachable. Start new agent sessions to load the configuration.\n'
