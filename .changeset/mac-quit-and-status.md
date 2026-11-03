---
"shellbell": minor
---

The Mac app is easier to quit and says when it can't read its own status.

- When Shellbell can't confirm that remote access and keep-awake stopped, Quit asks whether to
  quit anyway instead of reopening Settings. Quitting stops both regardless: the service stops
  with the app, and the Mac returns to its usual sleep settings.
- When the app can't read its status, it says so, with **Try Again**, instead of showing an old
  "Connected" next to greyed-out buttons.
- **Install updates from the app.** After **Check for Updates** finds a newer version, **Install
  and Restart** downloads it, checks it's signed by Shellbell's developer and accepted by macOS,
  then quits, updates and opens Shellbell again. The old app goes to the Trash, and keep-awake
  and closed-lid stay on. If anything doesn't check out, nothing is replaced.
