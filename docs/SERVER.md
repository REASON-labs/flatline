# The speech-to-text service

`server/install.sh` installs [whisper.cpp](https://github.com/ggml-org/whisper.cpp)'s HTTP server
as a systemd service, `flatline-whisper`, listening on **127.0.0.1 only**.

## Install

```bash
sudo bash server/install.sh
```

Safe to re-run: it rebuilds at the pinned release, keeps a model it already downloaded, rewrites
the unit and restarts it. Settings are environment variables:

| Variable | Default | |
|---|---|---|
| `FLATLINE_WHISPER_TAG` | `v1.9.5` | whisper.cpp release to build. Pinned on purpose; bump it deliberately. |
| `FLATLINE_MODEL` | `small.en` | see below |
| `FLATLINE_LANGUAGE` | `en` | a language code, or `auto` (needs a multilingual model) |
| `FLATLINE_PORT` | `8086` | loopback port |
| `FLATLINE_THREADS` | all cores | CPU threads per transcription |
| `FLATLINE_MEMORY_MAX` | `2G` | systemd memory cap |

```bash
sudo FLATLINE_MODEL=base.en FLATLINE_THREADS=2 bash server/install.sh
```

## Models

English-only models (`.en`) are faster and better at English; the others handle many languages.
Rough figures for a 10-second memo on 4 shared vCPUs:

| Model | Download | RAM | Time |
|---|---|---|---|
| `tiny.en` | 75 MB | ~0.3 GB | ~1 s |
| `base.en` | 140 MB | ~0.4 GB | ~2 s |
| `small.en` (default) | 470 MB | ~0.9 GB | ~6 s |
| `medium.en` | 1.5 GB | ~2.5 GB | ~20 s (raise `FLATLINE_MEMORY_MAX`) |

`small.en` is the sweet spot for phone memos: names and casual speech come out right far more
often than with `base.en`.

## What's installed where

| Path | |
|---|---|
| `/opt/flatline/src` | whisper.cpp source at the pinned tag |
| `/opt/flatline/bin` | `whisper-server` and its libraries |
| `/var/lib/flatline` | the model; the service's only writable place |
| `/etc/systemd/system/flatline-whisper.service` | the unit |

The service runs as the `flatline` system user with no shell, a read-only system, no home
directories, no devices, no capabilities, and a memory cap. It takes any audio ffmpeg can read
(`--convert`), so phone formats (AAC, MP4, WebM, Ogg) go straight in.

## Operating it

```bash
systemctl status flatline-whisper
journalctl -u flatline-whisper -n 50
curl -s -F file=@memo.m4a -F response_format=json http://127.0.0.1:8086/inference
```

From an app, `createTranscriber({ url }).health()` is a cheap "is it up?".

## Security

- Never expose the port to the internet or put it behind a public proxy: whisper's server has no
  authentication. Your app's endpoint is the gate (it checks the session, limits size and rate).
- One transcription uses the CPU fully for a few seconds. Limit how often one person can send
  audio in your app.

## Uninstall

```bash
sudo systemctl disable --now flatline-whisper
sudo rm /etc/systemd/system/flatline-whisper.service && sudo systemctl daemon-reload
sudo rm -rf /opt/flatline /var/lib/flatline && sudo userdel flatline
```
