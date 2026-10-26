# @shellbell/mobile

## 1.0.0

### Launch candidate changes

- Make Conversation read more like the agent's own screen. Replies no longer carry a
  `[copy]` line: long-press a reply to copy it, and its marker turns into a check for a
  moment. Tool work shows the agent's status dot, green when done and amber on failure,
  with `[+]` to open it, and every block sits one blank row apart. Markdown tables are
  drawn with box lines and fitted to the screen, and code or links inside bold text are
  styled instead of showing their backticks.
- Open Claude Code and Codex sessions straight into Conversation. While the computer works
  out which conversation a session is showing, the view says it is opening instead of
  showing the terminal first; if that takes more than eight seconds, or the computer says
  Conversation isn't available, the terminal shows.

- Match Conversation's text to Terminal. It follows the same font size setting, row height
  and marker width, with one blank row between blocks as in the agent's own screen.
- Rework the pairing scanner. The camera runs only while scanning and turns off once a
  code is read; a card shows the computer's name and fingerprint. A code that isn't a
  pairing code is noted over the live camera, which keeps scanning, and an expired code
  is caught before connecting. Each problem names what went wrong with one next step:
  **Try again** reuses the code at most twice, and only before the request reached the
  relay; a pairing approved on the computer but not saved can be saved again without a
  new request; an already paired computer opens directly. Choosing **Pair computer**
  accepts a custom relay shown on the card, with no second prompt.
- Reset the pre-launch marketing version to 1.0.0. This candidate includes all
  earlier 1.1.0 beta changes and the terminal framing fix below. Existing internal
  builds and tags retain their original version and build identities.

- Frame smaller host terminals in the center horizontally while keeping their top
  edge steady. Output reaching the final row no longer moves the grid down the
  screen. Preserve history scrolling through the surrounding margins, horizontal
  panning for larger grids, selection and terminal mouse coordinates.

- Mark each agent in the session list with a badge in its own colour, and use its
  proper name, such as Antigravity for `agy`, in place of a generic sparkle.

- Open each agent in the view that suits it. Claude Code and Codex sessions open in
  Conversation, because their terminal keeps no history to scroll back through.
  Antigravity and plain shells open in Terminal, with Conversation one tap away.

- Lay out Conversation like a chat. Your messages are bubbles, agent replies render
  Markdown (lists, code blocks with Copy, links that show their address first), and the
  tool steps between them fold into one line such as "Ran 4 commands, read 2 files" that
  opens to each step and its output. A running agent shows its current step. Earlier
  messages now load as you scroll up, without tapping.

- Show that a session is waiting for you in the keys row instead of a taller
  panel, so the terminal no longer jumps when an agent starts or stops waiting.
  The row leads with a Waiting label, then Esc, the arrows and Enter. Answer
  chips read from the screen are gone until the computer can check that the
  prompt they answer is still showing.

## 1.1.0

- Drain pending terminal parser work when changing views, preserve selection when
  a stale raw reset is rejected, and clear a raw-renderer error once a fresh seed
  has recovered. A stalled raw renderer offers reload after ten foreground seconds.

### Internal candidate changes

- Keep the terminal viewport steady while received output catches up with rendering; ordinary progress stays in the session header instead of inserting a row above the terminal. Paused output shows its reason and recovery controls over the existing Terminal view without resizing it.
- Align Expo 57.0.31, expo-network 57.0.3, expo-notifications 57.0.24 and expo-router 57.0.29 with the SDK compatibility matrix, including the xcode 4 project-generation dependency.

- Keep bounded terminal scrollback across compatible reconnects and renderer reloads, load proven older native pages, and preserve the visible terminal when an older prefix is evicted. Gaps and retention limits remain visible.
- Add a Conversation view for supported Claude Code and Codex sessions after the computer owner enables **Show agent conversations**. Older conversation pages load separately from terminal history; unsupported or unbound sources stay in Terminal.
- Group the **+** menu by terminal engine, then choose an available desktop app and **Fit phone**, **Custom**, or **Computer default** size. Dimensions are requests that the desktop app may adjust; existing windows are unchanged.
- Make touch flicks scroll with momentum and stop on a new touch. Keep terminal keys accessible when dismissing contextual replies, including Shift + Left.

- Make waiting actions match the prompt: honor displayed menu reply keys, show
  Yes/No only for explicit y/n prompts, and otherwise offer navigation and
  Shift + Left. Keep Enter visible, retain navigation, and restore keys after a reply.
- Fix native startup by keeping browser-only terminal rendering code out of the
  phone's retained-stream imports.
- Remove the lock overlay after unlocking so an invisible native modal cannot
  block navigation or terminal controls.
- Keep arrow keys ahead of letter shortcuts when selecting Shift, Ctrl or Alt in
  the terminal key row.
- Retain bounded terminal history across compatible reconnects and renderer reloads, with visible boundaries when output continuity cannot be proven. Show Catching up, Paused with a reason, and Ended; retry delivery stalls while the view is active. Keep malformed output paused for explicit retry. Herdr history replacements and phone memory limits are labeled.
- Use source-backed cursor and alternate-screen facts for inferred replies and Live keys, while preserving conservative secret-prompt masking in Herdr raw and snapshot views.

- Close the contextual waiting replies to restore all terminal keys, including
  Shift + Left, without sending an answer. The close control stays available in
  compact panes and while disconnected.

- tmux and Herdr sessions stream as the terminal's own output when the computer supports it,
  so the phone's terminal (xterm.js) handles scrolling, history and full-screen programs
  itself, with nothing stitched from snapshots. A waiting agent's numbered choices still
  appear as buttons. Answers the terminal gives to programs' queries are
  never typed into the shell. Reading view, older computers and other terminals keep using
  snapshots, and a stream the computer cannot keep up falls back to them on its own.
- A computer's session list says when a terminal needs a step on that computer, such as
  "iTerm2 needs one more step on your Mac", and where to do it.
- Update the private protocol dependency to 0.4.0. It adds the optional TURN
  setting's relay fields, which the phone does not use; phone behaviour is unchanged.
- Update the private protocol dependency to 0.3.0. The phone speaks only secure v2:
  terminal data travels only on the direct route, and TURN servers from the relay
  are used when a direct connection is blocked.
- Tapping the terminal no longer raises the phone keyboard or lets autocorrect
  type into the shell; the compose bar and Live keys field take typing.
- Tab no longer retypes a draft that is still being sent.
- A notification's pending session open no longer pulls you back after you move
  elsewhere.
- Update Expo to the latest SDK 57 patch releases.
- New output no longer rewrites the whole terminal while an omitted-history row
  is shown, which made the view flicker and jump.
- A Herdr workspace heading names the app showing it, such as `HERDR · web · in
  Ghostty`, and stays visible above a single session when it does.
- A new session opened from a session's menu appears in the app already showing that session,
  such as Ghostty, rather than always in iTerm2.
- When the computer cannot open a new Herdr session, New session and the session
  menu say why, such as a Herdr update or a version mismatch, instead of hiding it.
- History messages say what happened in plain words, such as "Some lines scrolled
  past unseen" and "Older lines stopped loading because the terminal kept changing".

- Talk to Claude Code and Codex from the command bar: their keys come first
  (Esc, arrows, Enter, ⇧Tab, 1–3, ^C), Return starts a new line, and an empty
  field's Send is Enter. A blocked agent's choices appear as large buttons.

- Give the terminal more of the screen: the session header shows the project,
  its status and a connection dot, and Reading view, search, text selection,
  terminal mouse and New session move into the session menu. Older history loads
  when you scroll to the top, a long press selects text, and Jump to live is a
  small corner button. The connection bar appears only while the terminal is
  paused.

- Load a session's output without tapping Retry output when its first screen
  arrives late, a transfer breaks or the connection pauses briefly. The phone asks
  again a few times before showing Output stopped.

- Keep the add buttons and the bottom of every screen above the Android
  navigation bar after going back from a session that had the keyboard open.

- Offer only new sessions that open in a terminal window on the computer: a new
  iTerm2 tab, then tmux and Herdr in iTerm2 or Ghostty. The options that started
  a tmux or Herdr session only the phone could see are gone, and the sheet shows
  the computer's reason when it refuses or closes a new session.

- Name sessions like Herdr's sidebar: the project (repository, folder or Herdr
  workspace) as the title, and the coding agent with its current task, or the
  folder relative to the home folder, underneath. Herdr groups show the workspace
  name. Task text is shown only in the live list and session menu.

- Type into a terminal through a command bar that opens by default, with a row of
  terminal keys above it that stays visible even when the keyboard leaves little
  room. Tab sends what you have typed so far and then Tab, so the shell can
  complete it. The phone keyboard no longer types into the terminal one key at a
  time; a physical keyboard still does.

- Add Live keys for vim, less, top and other full-screen programs: each key you
  type goes straight to the terminal, with Backspace and Enter working even on
  an empty field, and no autocorrect or predictions. Shellbell turns Live keys on
  by itself when a tmux session starts a full-screen program and off when it
  ends; tapping Live overrides that until the program changes.

- Offer Secret input when the terminal asks for a password or passphrase, and
  from the keys row at any time. The password is hidden while you type, sent
  once with Enter, and never saved to command history.

- Send just the key from the y and n reply chips, without Enter, so a prompt
  that reads one key does not get a stray Enter. Press Enter afterwards for a
  prompt that waits for a whole line.

- Keep text after a joined emoji with a skin tone, such as 👩🏽‍💻, on the row
  instead of cutting it off as if the emoji took four cells.

- Reconnect when the computer does not answer the first encrypted handshake within
  15 seconds, instead of staying on the connecting screen.

- Keep the connection and the open terminal when you leave Shellbell for less
  than five seconds, such as for a share sheet, a permission prompt or a quick
  app switch. After five seconds away the phone still closes its connections.

- Keep Use relay temporarily in effect until the connection closes or the phone
  changes network, so a direct route that works briefly and drops again does not
  pause the terminal and ask again.

- Keep the New session sheet open when the connection drops before the computer
  answers, and say so, so you can check the computer and try again. Shellbell
  never retries by itself, which could open two sessions.

- Leave out a session group's heading when it holds one session with the same
  name, such as HERDR · shellbell above shellbell.

- Show the Herdr, tmux or iTerm2 label on session rows only when the list mixes
  terminals.

- Let the session list scroll its last row clear of the floating + button.

- Stop covering session rows with a floating Terminal paused pill while the
  connection banner at the top of the list already says so.

- Show connection details with a chevron instead of a + that looked like New
  session.

- Call the key Enter everywhere, including the keys row and spoken labels for a
  Mac, and shorten the shell placeholder to Type a command so it fits beside the
  field's buttons on a narrow phone.

- Stop showing a second row of y, n, Enter and Esc under the keys row in a
  Claude Code or Codex session; a waiting agent still gets its large replies.

- Sign this phone's pairing key and require a computer that advertises key
  binding to sign its own, so someone who saw the QR and controls the relay path
  cannot substitute either key. While waiting for approval, show this phone's
  full fingerprint to compare with the computer; Settings shows it in full too.

- Add App Lock, on by default once a computer is paired. Shellbell asks for Face ID,
  Touch ID, a fingerprint or the device passcode at launch and after a chosen time
  away, hides terminals in the app switcher and refuses terminal input while locked.
  Turning it off requires a warning and the phone's own authentication.

- Ask for agreement to the Terms of Use before starting connections. Remember custom relay trust choices by address, and keep Terms and Privacy available in Settings.

- Update the private protocol dependency to 0.2.0; wire compatibility remains negotiated separately.

- Preserve loaded history and reading positions through stream recovery, and stop
  legacy history requests at the oldest retained row.
- Clarify direct typing and draft focus, retaining pending input per connection.
- Show owner-enabled terminal adapters and available desktop launch choices.
- Avoid redundant terminal repaints while scrolling and preserve the reading
  position when the renderer reloads.
- Notify reachable computers before closing an unpaired connection, including
  legacy pairings, while retaining durable revocation and local cleanup.
- Align Expo SDK packages and native build tools with recommended patch versions.

- Keep vertical history swipes working across the full terminal viewport after
  zooming in or out, including empty space below a smaller grid.

- Explain native terminal history read limits without an ineffective Retry
  action; keep already loaded history and live output available.
- Keep computer and session rows aligned and tappable when Android animations are disabled.

- Hide connection, history and selection toolbars while the software keyboard is
  open, keeping more terminal output visible without losing the draft or session.
- Adopt Expo's scene lifecycle for iOS 27 and compile Expo modules from source
  with the selected Xcode toolchain. Keep the app single-window.
- Keep native window and navigation backgrounds dark during adaptive display
  changes. Signed-candidate lifecycle, deep-link and notification qualification
  remains in the mobile QA checklist.
- Keep terminal notification links behind pairing and current-session checks
  during both cold launch and warm URL delivery.
- Use consistent settings controls and native monochrome keyboard icons. Improve
  touch targets, accessible labels and list spacing around system controls.
- Keep a visible route back to Computers and pass the selected session explicitly
  to native header actions.
- Keep all session actions reachable on Android, prevent duplicate requests and
  explain failed actions. Retry reconnects without starting a new pairing.
- Recover camera access through system Settings after permission denial, and give
  replacement toast messages their full reading interval.
- Keep a computer's notifications off when the switch is turned on and off again
  quickly, even if the earlier push token arrives last.
- Create only one phone identity on first launch when Settings opens before
  startup has finished saving it.
- Make Re-pair unpair the computer on this phone first, so scanning its QR code
  again completes pairing instead of asking you to unpair it.

### Minor Changes

- 6975e9e: Add one-use Shift, Ctrl and Alt controls to the terminal key bar, including Shift + arrows, Shift + Tab and modified letter buttons. Keep ordinary typing and keyboard focus in the native composer.
- 874b3ae: Add optional encrypted terminal mouse clicks for Herdr with a matching CLI/server
  version 0.9.3 or newer. Mobile Mouse mode accepts acknowledged live-cell taps,
  leaves history scrolling local, and disables input during connection pauses.
  The host checks the current pane grid, refuses takeover, releases control after
  each click and never replays a failed request.
- 279b85f: Move terminal interaction and loaded history into xterm.js. Add history search,
  touch selection, styled copy, exact encrypted terminal input and host-native
  paste. Remove native raw-input text diffing and hide phone keyboard accessories
  when a physical keyboard is attached. Older hosts retain command composition.

### Patch Changes

- 3a94500: Reject oversized clipboard and raw input before sending any associated Enter or deletion keys. Check the complete encoded message, including multibyte text, and show a local size error.
- Updated dependencies [3a94500]
- Updated dependencies [874b3ae]
- Updated dependencies [279b85f]
  - @shellbell/protocol@0.1.0

## Earlier 1.0.0 internal candidates

### Major Changes

- c5d0005: Prepare the shared Android and iOS launch release train as 1.0.0. Beta candidates
  use the same numeric marketing version with fresh platform build numbers and
  TestFlight or Play testing channels. Stable promotion requires qualification of
  the launch contract; the version bump does not publish or upload an app.

### Patch Changes

- 93cba0f: Read the mobile native version and both relay runtime version responses from
  their component package metadata. Keep the Cloudflare relay, Node relay and
  shared relay core on one release version.
- 9084eb1: Enable direct WebRTC negotiation in normal mobile connections. Pause terminal input and streaming until a direct route commits, including after direct loss; relay terminal traffic requires an explicit temporary choice. Keep relay signaling and notification enrollment available while the terminal is paused. Show the committed route and connection/retry progress in the app.
  
  Preserve keyboard visibility when tapping or scrolling terminal quick keys so the first tap reaches the key.
- 892bdf7: Keep bottom status rows from terminal applications visible in Live mode even
  when their cursor is higher on the screen. Preserve history reading positions
  and align short occupied grids above the input bar through viewport changes.
- Deliver internal mobile candidates through CI after the source passes checks.
  Reserve native counters from store history, verify artifact versions and store
  assignment, retain build diagnostics, and tag the exact source after both uploads.
- 1d43043: Reconnect paired terminal sessions when the phone switches between Wi-Fi and
  cellular. Pause attempts without a network, show offline state separately from
  computer and relay outages, and preserve unsent drafts without automatic replay.
- 9084eb1: Enable R8 code shrinking, optimization and obfuscation, plus unused-resource shrinking, in Android release builds. Preserve these settings across native regeneration and use the optimizing Android defaults.
  
  Run iOS prebuild and CocoaPods outside Fastlane's Ruby bundle while retaining
  native release configuration.
  
  Include the notification extension bundle name required by App Store validation.
  
  Check the accepted TestFlight build's encryption compliance and internal testing
  state before group assignment, with instructions to resolve blockers on that build.
  Allow an explicit encryption-documentation classification for local internal
  uploads; leaving it unset requires resolving the declaration in App Store Connect.
- 9084eb1: Move Settings to a header gear, add light branding and native version/build information,
  and remove the donation link. Explain automatic terminal scaling and disable manual
  font controls while it is active. Show supported terminal apps in a session picker
  with connection guidance, avoiding Android's native alert button limit.
  
  Advertise installed terminal backends separately from connected ones. A phone can
  launch iTerm2, start tmux's first session, or start Herdr's headless server and first
  workspace. Keep startup requests bounded and preserve existing target validation.
- 1d466c2: Keep screens above system navigation when the keyboard is closed. Add optional
  WebGL rendering with DOM fallback and native web-link opening. Provide explicit
  local build-and-upload commands for internal Play and TestFlight distribution.
- Updated dependencies [9084eb1]
- Updated dependencies [9084eb1]
  - @shellbell/protocol@0.0.2
