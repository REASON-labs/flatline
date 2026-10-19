#!/usr/bin/env bash
# Move a box from an older, hand-made whisper.cpp service to Flatline's (flatline-whisper), on
# the same loopback port, so the apps that use it don't change. If the new service can't
# transcribe, it switches straight back. Nothing is deleted: the old service is only disabled.
#
#   sudo bash migrate-from-whisper.sh                 switch over (needs install.sh next to it)
#   sudo bash migrate-from-whisper.sh --rollback      go back to the old service
#
# Settings (all optional):
#   OLD_SERVICE      the old unit's name (default whisper)
#   OLD_MODEL_DIR    where the old model is, reused instead of downloaded (default /var/lib/whisper)
#   FLATLINE_PORT    the port both use (default 8086); FLATLINE_MODEL etc. as for install.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo." >&2; exit 1; }

OLD="${OLD_SERVICE:-whisper}"
NEW=flatline-whisper
PORT="${FLATLINE_PORT:-8086}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://127.0.0.1:$PORT"

say() { echo "==> $*"; }
up() { for _ in $(seq 1 "${1:-30}"); do curl -fsS -o /dev/null "$URL/" && return 0; sleep 1; done; return 1; }

# One real transcription: a second of tone in, a JSON answer with a "text" field out.
check() {
  local wav; wav="$(mktemp --suffix=.wav)"
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=220:duration=1" -ar 16000 -ac 1 "$wav"
  local out; out="$(curl -fsS --max-time 120 -F "file=@$wav" -F response_format=json "$URL/inference" || true)"
  rm -f "$wav"
  [[ "$out" == *'"text"'* ]]
}

back_to_old() {
  say "Going back to $OLD."
  systemctl stop "$NEW" 2>/dev/null || true
  systemctl disable -q "$NEW" 2>/dev/null || true
  systemctl enable -q "$OLD" && systemctl start "$OLD"
  if up 30 && check; then say "$OLD is answering on $URL again."; else echo "!! $OLD isn't answering either: journalctl -u $OLD -n 50" >&2; fi
}

if [ "${1:-}" = "--rollback" ]; then back_to_old; exit 0; fi

systemctl cat "$OLD" >/dev/null 2>&1 || { echo "No $OLD.service here: nothing to migrate from. Use install.sh." >&2; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is needed for the check (apt-get install ffmpeg)." >&2; exit 1; }
[ -f "$HERE/install.sh" ] || { echo "install.sh must be next to this script." >&2; exit 1; }

say "Before: is $OLD transcribing?"
if up 5 && check; then say "Yes."; else say "No (continuing: the new service may fix it)."; fi

say "Installing $NEW (not started yet: $OLD holds the port)."
FLATLINE_PORT="$PORT" FLATLINE_START=0 FLATLINE_MODEL_FROM="${OLD_MODEL_DIR:-/var/lib/whisper}" bash "$HERE/install.sh"

say "Switching: stopping $OLD, starting $NEW."
systemctl stop "$OLD"
systemctl start "$NEW"
if up 60 && check; then
  systemctl disable -q "$OLD"
  say "Done: $NEW is transcribing on $URL; $OLD is stopped and disabled (its files are untouched)."
  echo "    If anything looks wrong:  sudo bash $0 --rollback"
  echo "    Once you're happy (a few days), remove the old files; see docs/MIGRATING.md."
else
  echo "!! $NEW didn't transcribe. Its log:" >&2
  journalctl -u "$NEW" -n 30 --no-pager >&2 || true
  back_to_old
  exit 1
fi
