#!/usr/bin/env bash
# Flatline's speech-to-text service: whisper.cpp's server, built at a pinned release and run on
# loopback under its own user. The audio sent to it never leaves the machine.
#
#   sudo bash server/install.sh                 build, download the model, start flatline-whisper
#   sudo FLATLINE_MODEL=base.en bash server/install.sh    a smaller, faster model
#
# Safe to re-run: it rebuilds at the pinned tag, keeps a model that is already there, and
# rewrites the service. Debian or Ubuntu with systemd. Settings (all optional):
#   FLATLINE_WHISPER_TAG  whisper.cpp release (default below)
#   FLATLINE_MODEL        a ggml model name: tiny.en base.en small.en medium.en, or without .en
#                         for other languages (default small.en)
#   FLATLINE_LANGUAGE     en, or auto to detect (default en)
#   FLATLINE_PORT         loopback port (default 8086)
#   FLATLINE_THREADS      CPU threads (default: all)
#   FLATLINE_MEMORY_MAX   systemd memory cap (default 2G)
#   FLATLINE_MODEL_FROM   a folder that already has ggml-<model>.bin: copied instead of downloaded
#   FLATLINE_START        0 = install and enable, but don't start (another service holds the port;
#                         see server/migrate-from-whisper.sh)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }

TAG="${FLATLINE_WHISPER_TAG:-v1.9.5}"
MODEL="${FLATLINE_MODEL:-small.en}"
LANGUAGE="${FLATLINE_LANGUAGE:-en}"
PORT="${FLATLINE_PORT:-8086}"
THREADS="${FLATLINE_THREADS:-$(nproc)}"
MEMORY_MAX="${FLATLINE_MEMORY_MAX:-2G}"
MODEL_FROM="${FLATLINE_MODEL_FROM:-}"
START="${FLATLINE_START:-1}"
SERVICE=flatline-whisper
USER_NAME=flatline
HOME_DIR=/var/lib/flatline
PREFIX=/opt/flatline

[[ "$MODEL" =~ ^[a-z0-9.-]+$ ]] || { echo "FLATLINE_MODEL looks wrong: $MODEL" >&2; exit 1; }
[[ "$PORT" =~ ^[0-9]+$ ]] || { echo "FLATLINE_PORT must be a number" >&2; exit 1; }
case "$MODEL" in *.en) [ "$LANGUAGE" = en ] || echo "Note: $MODEL is English-only; FLATLINE_LANGUAGE=$LANGUAGE is ignored by it." ;; esac

echo "Installing build tools and ffmpeg..."
export DEBIAN_FRONTEND=noninteractive
apt-get install -y --no-install-recommends cmake ffmpeg build-essential git ca-certificates curl >/dev/null 2>&1 || {
  apt-get update >/dev/null
  apt-get install -y --no-install-recommends cmake ffmpeg build-essential git ca-certificates curl >/dev/null
}

id "$USER_NAME" &>/dev/null || useradd --system --home "$HOME_DIR" --shell /usr/sbin/nologin "$USER_NAME"
install -d -o "$USER_NAME" -g "$USER_NAME" -m 0750 "$HOME_DIR"

echo "Building whisper.cpp $TAG..."
SRC="$PREFIX/src"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch -q --depth 1 origin tag "$TAG" && git -C "$SRC" checkout -q "$TAG"
else
  rm -rf "$SRC"; install -d "$PREFIX"
  git clone -q --depth 1 --branch "$TAG" https://github.com/ggml-org/whisper.cpp.git "$SRC"
fi
cmake -S "$SRC" -B "$SRC/build" -DCMAKE_BUILD_TYPE=Release -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
cmake --build "$SRC/build" --config Release -j "$(nproc)" --target whisper-server >/dev/null
install -d -m 0755 "$PREFIX/bin"
BIN="$(find "$SRC/build" -type f -name whisper-server -perm -u+x | head -1)"
[ -n "$BIN" ] || { echo "No whisper-server was built." >&2; exit 1; }
install -m 0755 "$BIN" "$PREFIX/bin/whisper-server"
find "$SRC/build" -name "*.so*" -exec cp -a {} "$PREFIX/bin/" \; 2>/dev/null || true

MODEL_FILE="$HOME_DIR/ggml-$MODEL.bin"
if [ ! -s "$MODEL_FILE" ] && [ -n "$MODEL_FROM" ] && [ -s "$MODEL_FROM/ggml-$MODEL.bin" ]; then
  echo "Copying the $MODEL model from $MODEL_FROM..."
  cp "$MODEL_FROM/ggml-$MODEL.bin" "$MODEL_FILE.part" && mv "$MODEL_FILE.part" "$MODEL_FILE"
  chown "$USER_NAME:$USER_NAME" "$MODEL_FILE"
fi
if [ ! -s "$MODEL_FILE" ]; then
  echo "Downloading the $MODEL model..."
  bash "$SRC/models/download-ggml-model.sh" "$MODEL" "$HOME_DIR" >/dev/null
  chown "$USER_NAME:$USER_NAME" "$MODEL_FILE"
fi

cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Flatline speech-to-text (whisper.cpp, loopback only)
Documentation=https://github.com/REASON-labs/flatline
After=network-online.target

[Service]
User=$USER_NAME
Group=$USER_NAME
WorkingDirectory=$HOME_DIR
Environment=LD_LIBRARY_PATH=$PREFIX/bin
# Loopback only: put an app in front of it, never the internet. --convert takes any audio
# ffmpeg reads (phone memos are AAC, MP4, WebM or Ogg).
ExecStart=$PREFIX/bin/whisper-server --host 127.0.0.1 --port $PORT -m $MODEL_FILE -t $THREADS --convert --language $LANGUAGE
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=$HOME_DIR
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=$MEMORY_MAX

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
if [ "$START" = 0 ]; then
  systemctl enable -q "$SERVICE"
  echo "Installed and enabled $SERVICE (not started). Start it with: systemctl start $SERVICE"
  exit 0
fi
systemctl enable -q --now "$SERVICE"
systemctl restart "$SERVICE"

for _ in $(seq 1 30); do curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 1; done
if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/"; then
  echo "Flatline speech-to-text is running on http://127.0.0.1:$PORT ($MODEL)."
  echo "Point your app at it, e.g. FLATLINE_URL=http://127.0.0.1:$PORT"
else
  echo "The service didn't answer. Check: journalctl -u $SERVICE -n 50" >&2
  exit 1
fi
