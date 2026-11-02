---
"shellbell": minor
---

Shellbell runs in the background in one step: `shellbell install` sets it up, starts it and
keeps it starting whenever you log in, then shows a QR code to pair your phone. It replaces the
`service` commands, which needed several steps, and on Linux also `host init --new`: a new Linux
computer gets its identity by itself. Shellbell never makes a second identity where one already
exists, such as a copy from another computer or an older `~/.shellbell`.

- `shellbell start` starts the background Shellbell, and offers to set it up when it isn't yet.
  `shellbell stop` stops it until you next log in, `shellbell restart` restarts it, and
  `shellbell uninstall` removes it while your phones stay paired.
- `shellbell run` keeps Shellbell in one terminal window, for containers and testing.
- `shellbell pair` ends with "Paired with <phone>. You're all set." When Shellbell isn't running
  in the background yet, it offers to set that up first, and a pairing made in a terminal window
  keeps working until you close it instead of stopping after five minutes.
- `shellbell status` says in plain words how Shellbell runs, which phones are paired and
  connected, and which terminals and relay are ready. `shellbell phones` lists paired phones even
  while Shellbell isn't running.
- On Linux, `install` says when Shellbell stops at logout and what keeps it running. A computer
  without a systemd user session, such as a container, is told to use `shellbell run`, and
  nothing is changed.
- `shellbell update` restarts the background Shellbell on the new version. After
  `npm install -g shellbell`, the background Shellbell notices its new files and restarts on
  them by itself within a few minutes, waiting while a phone is looking at a session (at most
  ten minutes). `shellbell status` and `shellbell doctor` say when an older version is still
  running.
