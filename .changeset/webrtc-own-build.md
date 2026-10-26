---
"shellbell": minor
---

Run direct connections on a WebRTC binary Shellbell builds itself, with current crypto. The
prebuilt one carried OpenSSL 1.1.1 on Linux, which stopped receiving security fixes in 2023, and
an OpenSSL 3.6 release on macOS that missed two security updates. The new build links OpenSSL
3.5 LTS (supported until 2030) and libdatachannel 0.24.6, which fixes a stall when connecting
through a TURN server and ICE timers that drifted across sleep. It also leaves out the audio,
video and WebSocket code Shellbell never used, and runs on macOS 13, which the old binary didn't.
The Mac app, the Linux download and npm installs all ship the same build, with the licence of
every library compiled into it.

The computer also logs how each direct connection goes (same network, over the internet, or
through a TURN server), its round trip and how long it took to set up, without addresses.
