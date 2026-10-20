#!/usr/bin/env bash
# Flatline's text-to-speech service: Piper (a fast, CPU-only speech engine) behind a small Node
# service that adds each preset's sound with ffmpeg. Loopback only; nothing is sent anywhere.
#
#   sudo bash server/install-voice.sh            install or update flatline-voice on :8087
#
# Needs Node 20+ (already there if a Flatline app runs on the box) and installs ffmpeg. Safe to
# re-run: pinned downloads are checked and kept, the service code is updated, and your presets
# (/etc/flatline/voice-presets.json) are left alone. Settings (all optional):
#   FLATLINE_VOICE_PORT      loopback port (default 8087)
#   FLATLINE_VOICE_EXTRA     more Piper voices to fetch, e.g. "en_US-joe-medium en_US-bryce-medium"
#                            (from the same pinned revision; for trying voices out)
#   FLATLINE_VOICE_RESET_PRESETS=1   replace your presets with the shipped ones (a backup is kept)
#   FLATLINE_VOICE_MEMORY_MAX  systemd memory cap (default 1G)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${FLATLINE_VOICE_PORT:-8087}"
MEMORY_MAX="${FLATLINE_VOICE_MEMORY_MAX:-1G}"
EXTRA="${FLATLINE_VOICE_EXTRA:-}"
SERVICE=flatline-voice
USER_NAME=flatline
PREFIX=/opt/flatline
VOICES=/var/lib/flatline/voices
PRESETS=/etc/flatline/voice-presets.json

# Pinned: Piper's last MIT release (rhasspy/piper, archived 2025), checked by SHA-256.
PIPER_TAG=2023.11.14-2
declare -A PIPER_SHA=(
  [x86_64]=a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992
  [aarch64]=fea0fd2d87c54dbc7078d0f878289f404bd4d6eea6e7444a77835d1537ab88eb
)
# Pinned: the voices repository at one revision, and the default voice's files by SHA-256.
VOICES_REV=c10ece1aade47bb51c153c893d14e5bf8e5b7117
DEFAULT_VOICE=en_US-libritts_r-medium
declare -A VOICE_SHA=(
  [en_US-libritts_r-medium.onnx]=10bb85e071d616fcf4071f369f1799d0491492ab3c5d552ec19fb548fac13195
  [en_US-libritts_r-medium.onnx.json]=b471dc60d2d8335e819c393d196d6fbf792817f40051257b269878505bc9afb3
)

[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "FLATLINE_VOICE_PORT must be a number" >&2; exit 1; }
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "Node 20+ is needed (apt-get install nodejs, or your app's Node)." >&2; exit 1; }
"$NODE" -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Node 20+ is needed; this is $("$NODE" -v)." >&2; exit 1; }
ARCH="$(uname -m)"
[ -n "${PIPER_SHA[$ARCH]:-}" ] || { echo "No Piper build for $ARCH." >&2; exit 1; }

echo "Installing ffmpeg..."
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends ffmpeg curl ca-certificates >/dev/null 2>&1 || {
  apt-get update >/dev/null
  apt-get install -y --no-install-recommends ffmpeg curl ca-certificates >/dev/null
}

id "$USER_NAME" &>/dev/null || useradd --system --home /var/lib/flatline --shell /usr/sbin/nologin "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 /var/lib/flatline
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$VOICES"
install -d -m 0755 "$PREFIX" /etc/flatline

# fetch URL DEST [SHA256]: download to DEST.part, check the hash if given, then move into place.
fetch() {
  local url="$1" dest="$2" sha="${3:-}"
  if [ -s "$dest" ] && { [ -z "$sha" ] || echo "$sha  $dest" | sha256sum -c --status; }; then return 0; fi
  curl -fsSL --retry 3 -o "$dest.part" "$url"
  if [ -n "$sha" ] && ! echo "$sha  $dest.part" | sha256sum -c --status; then
    rm -f "$dest.part"; echo "Checksum mismatch for $url" >&2; exit 1
  fi
  mv "$dest.part" "$dest"
}

echo "Piper $PIPER_TAG ($ARCH)..."
TARBALL="$PREFIX/piper_linux_$ARCH-$PIPER_TAG.tar.gz"
fetch "https://github.com/rhasspy/piper/releases/download/$PIPER_TAG/piper_linux_$ARCH.tar.gz" "$TARBALL" "${PIPER_SHA[$ARCH]}"
rm -rf "$PREFIX/piper.new" && mkdir -p "$PREFIX/piper.new"
tar -xzf "$TARBALL" -C "$PREFIX/piper.new" --strip-components=1
rm -rf "$PREFIX/piper" && mv "$PREFIX/piper.new" "$PREFIX/piper"
chmod -R u=rwX,go=rX "$PREFIX/piper"

# voice_url NAME FILE: e.g. en_US-joe-medium -> en/en_US/joe/medium/FILE
voice_url() {
  local name="$1" file="$2" lang rest speaker quality
  lang="${name%%-*}"; rest="${name#*-}"; quality="${rest##*-}"; speaker="${rest%-*}"
  echo "https://huggingface.co/rhasspy/piper-voices/resolve/$VOICES_REV/${lang%%_*}/$lang/$speaker/$quality/$file"
}
for v in "$DEFAULT_VOICE" $EXTRA; do
  [[ "$v" =~ ^[a-z]{2}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$ ]] || { echo "Not a Piper voice name: $v" >&2; exit 1; }
  echo "Voice $v..."
  for f in "$v.onnx" "$v.onnx.json"; do fetch "$(voice_url "$v" "$f")" "$VOICES/$f" "${VOICE_SHA[$f]:-}"; done
done
chown -R "$USER_NAME:$USER_NAME" "$VOICES"

echo "The service..."
install -d -m 0755 "$PREFIX/voice"
install -m 0644 "$HERE/voice/server.mjs" "$HERE/voice/chain.mjs" "$HERE/voice/flatten.mjs" "$HERE/voice/presets.json" "$PREFIX/voice/"
if [ ! -s "$PRESETS" ] || [ "${FLATLINE_VOICE_RESET_PRESETS:-0}" = 1 ]; then
  [ -s "$PRESETS" ] && cp "$PRESETS" "$PRESETS.$(date +%Y%m%d%H%M%S).bak"
  install -m 0644 "$HERE/voice/presets.json" "$PRESETS"
fi

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Flatline text-to-speech (Piper + ffmpeg, loopback only)
Documentation=https://github.com/REASON-labs/flatline
After=network-online.target

[Service]
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=/var/lib/flatline
Environment=NODE_ENV=production
Environment=FLATLINE_VOICE_PORT=$PORT
Environment=PIPER_BIN=$PREFIX/piper/piper
Environment=FLATLINE_VOICES_DIR=$VOICES
Environment=FLATLINE_VOICE_PRESETS=$PRESETS
ExecStart=$NODE $PREFIX/voice/server.mjs
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=/var/lib/flatline
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=$MEMORY_MAX

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable -q "$SERVICE"
systemctl restart "$SERVICE"

URL="http://127.0.0.1:$PORT"
for _ in $(seq 1 20); do curl -fsS -o /dev/null "$URL/" && break; sleep 1; done
CHECK="$(mktemp --suffix=.wav)"
if curl -fsS --max-time 60 -H 'content-type: application/json' -d '{"text":"Flatline voice check.","format":"wav"}' -o "$CHECK" "$URL/speak" && [ "$(head -c 4 "$CHECK")" = "RIFF" ]; then
  rm -f "$CHECK"
  echo "Flatline voice is running on $URL (presets in $PRESETS; restart $SERVICE after editing)."
else
  rm -f "$CHECK"
  echo "The voice service didn't speak. Check: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
