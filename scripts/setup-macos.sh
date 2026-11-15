#!/bin/bash
set -euo pipefail

# The public preview is versioned because GitHub's /latest skips prereleases.
release_version=0.2.1
release_base=https://github.com/avad-technologies/rndevtools/releases/download
app_name='RN Devtools.app'
publisher='anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "434X69L4Z5"'
app_identifier=io.github.adalloul0928.rndevtools

usage() {
    cat <<'EOF'
Usage: bash scripts/setup-macos.sh [--agents codex,claude] [--applications-dir /absolute/path] [--dmg /absolute/file.dmg]

Install or reuse RN Devtools, start the desktop, and configure Codex and Claude Code.
Use --agents codex or --agents claude to configure one client. Setup reuses an
existing app in /Applications, otherwise it installs in ~/Applications.
Supply --dmg to use an official, notarized DMG for a new installation.
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
    if [[ -e "/Applications/$app_name" || -L "/Applications/$app_name" ]]; then
        applications_dir=/Applications
    fi
fi
[[ "$applications_dir" == /* ]] || fail 'Pass an absolute path for --applications-dir.'
app="$applications_dir/$app_name"

scratch=$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/rndevtools-setup.XXXXXXXX")
staging=
mount_dir="$scratch/mounted"
mounted=false
cleanup() {
    if [[ -n "$staging" ]]; then
        /bin/rm -rf "$staging"
    fi
    if $mounted && ! /usr/bin/hdiutil detach "$mount_dir" >/dev/null; then
        printf 'Could not eject %s. Eject it before removing %s.\n' "$mount_dir" "$scratch" >&2
        return
    fi
    /bin/rm -rf "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

verify_app() {
    local bundle=$1
    [[ -d "$bundle" && ! -L "$bundle" && -x "$bundle/Contents/Resources/native/rndevtools" ]] &&
        /usr/bin/codesign --verify --deep --strict -R="$publisher and identifier \"$app_identifier\"" "$bundle"
}

if [[ -e "$app" || -L "$app" ]]; then
    verify_app "$app" || fail "The installed app at $app failed the RN Devtools signature check."
    printf 'Using %s\n' "$app"
else
    expected_version=
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
    if [[ -n "$expected_version" ]]; then
        version=$(/usr/bin/plutil -extract CFBundleShortVersionString raw -expect string -o - "$mount_dir/$app_name/Contents/Info.plist")
        [[ "$version" == "$expected_version" ]] || fail "The downloaded app is version $version. Expected $expected_version."
    fi
    /bin/mkdir -p "$applications_dir"
    staging=$(/usr/bin/mktemp -d "$applications_dir/.rndevtools-setup.XXXXXXXX")
    /usr/bin/ditto "$mount_dir/$app_name" "$staging/$app_name"
    verify_app "$staging/$app_name" || fail 'The copied app failed the RN Devtools signature check.'
    /bin/mv -n "$staging/$app_name" "$applications_dir/"
    verify_app "$app" || fail "The app at $app failed the RN Devtools signature check."
    printf 'Installed %s\n' "$app"
fi

cli="$app/Contents/Resources/native/rndevtools"
if ! "$cli" doctor --request-timeout-ms 1500 > /dev/null 2> "$scratch/doctor-error"; then
    /usr/bin/open -a "$app"
    ready=false
    for _ in {1..15}; do
        if "$cli" doctor --request-timeout-ms 1500 > /dev/null 2> "$scratch/doctor-error"; then
            ready=true
            break
        fi
        /bin/sleep 1
    done
    if ! $ready; then
        /bin/cat "$scratch/doctor-error" >&2
        fail 'RN Devtools did not become reachable. Open the app in your macOS session and rerun setup.'
    fi
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
