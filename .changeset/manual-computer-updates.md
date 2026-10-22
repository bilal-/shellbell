---
"shellbell": minor
---

Add manual computer update checks. The Mac app offers Check for Updates in General
settings, with release notes and the official compatible installer. The CLI adds
`shellbell update --check` and confirmed verified Linux archive installation,
preserving previous runtimes and pairings. Other installation methods receive
appropriate update instructions. Checks, downloads and service activation remain
explicit user actions; there are no background checks or automatic downloads.
