---
"shellbell": minor
---

The Mac app is easier to quit and says when it can't read its own status.

- When Shellbell can't confirm that remote access and keep-awake stopped, Quit asks whether to
  quit anyway instead of reopening Settings, and says what it couldn't confirm. Remote access
  always ends with the app. If your Mac's usual sleep settings couldn't be put back yet,
  Shellbell keeps trying after you quit and says your Mac may stay awake with the lid closed
  until then.
- When the app can't read its status, it says so, with **Try Again**, instead of showing an old
  "Connected" next to greyed-out buttons.
- **Install updates from the app.** After **Check for Updates** finds a newer version, **Install
  and Restart** downloads it, checks it's signed by Shellbell's developer and accepted by macOS,
  then quits, updates and opens Shellbell again. The old app goes to the Trash, and keep-awake
  and closed-lid stay on. If anything doesn't check out, nothing is replaced, and if the new
  version can't be put in place or opened, the current one opens again and says so.
- Closing a pairing while Shellbell can't read its status no longer disconnects your phones.
