---
"shellbell": patch
---

Several reliability fixes for the computer:

- A phone approved while the computer had lost its relay connection is no longer saved as
  paired; the pairing code stays open so the phone can simply try again.
- `shellbell start` says why it could not start, such as Shellbell already running, instead
  of a bare "operation-failed".
- After a Linux `shellbell update`, the installer's staging folder in your home folder is
  shown so you can remove it.
- tmux no longer leaves an extra background check running when a phone starts the first
  tmux session.
- The Mac app restores remote access after a lost connection even while the old service
  is still stopping, keeps working when the controller is briefly busy, and restarts remote
  access that stopped by itself after setup or a switch from headless.
- The Mac app no longer checks the system's sleep settings every few seconds while
  keep-awake is off.
