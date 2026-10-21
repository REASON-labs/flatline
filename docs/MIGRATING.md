# Moving from an older whisper.service

Some boxes already run whisper.cpp under a hand-made `whisper.service` (whisper.cpp in
`/opt/whisper`, the model in `/var/lib/whisper`, port 8086). `server/migrate-from-whisper.sh`
moves them to Flatline's `flatline-whisper` **on the same port**, so the apps using it need no
change, and switches straight back if the new service can't transcribe.

It is rehearsed in CI on every push: migrate, roll back, and a forced failure that switches back
by itself.

## What it does

1. Checks the old service answers (for the record; it carries on either way).
2. Runs `install.sh` without starting the new service (the old one holds the port), copying the
   old model instead of downloading it again.
3. Stops the old service, starts `flatline-whisper`, and sends it one real transcription.
4. If that works: disables the old service (its files stay). If not: stops the new one and
   starts the old one again, and exits with an error.

## Run it

Copy the two scripts to the server and run the migration there (it takes a few minutes, mostly
building whisper.cpp):

```bash
scp server/install.sh server/migrate-from-whisper.sh you@your-server:/tmp/
ssh -t you@your-server 'sudo bash /tmp/migrate-from-whisper.sh'
```

The model and port follow the defaults (`small.en`, 8086); set `FLATLINE_MODEL`, `FLATLINE_PORT`,
`OLD_SERVICE` or `OLD_MODEL_DIR` in front of `bash` if yours differ.

## Check it

```bash
ssh you@your-server 'systemctl is-active flatline-whisper; systemctl is-enabled whisper || true'
```

Then use the app's voice feature once (a voice memo, say).

## Going back

```bash
ssh -t you@your-server 'sudo bash /tmp/migrate-from-whisper.sh --rollback'
```

## Cleaning up (after a few days)

Once you're sure, remove the old service's files. This can't be undone, so look first:

```bash
ssh -t you@your-server 'sudo rm /etc/systemd/system/whisper.service && sudo systemctl daemon-reload && sudo rm -rf /opt/whisper /var/lib/whisper && sudo userdel whisper'
```

# Upgrading the voice service to 0.3 (the cast)

0.3 makes the voice a cast of characters. Dixie is now **Flatline**; `dixie` keeps working as her
other name, so nothing that asks for it breaks.

```bash
sudo cp /etc/flatline/voice-presets.json /etc/flatline/voice-presets.json.$(date +%Y%m%d%H%M%S).bak
scp -r server you@your-server:/tmp/flatline-server
ssh -t you@your-server 'sudo bash /tmp/flatline-server/install-voice.sh'
```

The installer fetches the cast's voices (about 270 MB more), keeps every preset you have exactly
as it is, and adds the new ones: `flatline` as a copy of **your** `dixie` (so your tuning carries
over), then `kestrel`, `iris`, `ashford`, `hoshi` and `calder`. It keeps a dated backup when it
adds anything. A request with no preset now gets `flatline` (or `dixie` where there is no
`flatline`).

Check it:

```bash
ssh you@your-server 'curl -s http://127.0.0.1:8087/'   # presets include flatline ... calder; default "flatline"
```

Apps: `createSpeaker().speak()` and the browser's `dixie.speak()` no longer send `"dixie"` when
no preset is given; the service picks its default. Pick a character's preset from `flatline/cast`.
