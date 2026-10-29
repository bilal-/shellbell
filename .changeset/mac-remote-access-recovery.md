---
"shellbell": patch
---

The Mac app brings remote access back by itself when its connection to the service is lost, and
a slow or unexpected answer no longer ends remote access in the first place. Keep-awake, the
coding agents list and Quit say what is happening instead of waiting on a service that had
stopped. A failed closed-lid setup now says which step failed, and the Mac service's log records
what happened instead of a bare "agent-event".

Closed-lid keep-awake works again after updating the Mac app. The closed-lid helper kept running
the old version after an update, and macOS would not let the new app talk to it. The helper now
restarts itself as the new version once it holds nothing.
