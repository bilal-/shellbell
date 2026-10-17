import AppKit
import Combine
import ShellbellCore
import SwiftUI

/// One card per supported terminal: what works, what to do next, and at most one button.
struct TerminalsView: View {
  @ObservedObject var model: ControllerModel
  @State private var showOthers = false
  private let poll = Timer.publish(every: 2, on: .main, in: .common).autoconnect()

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 16) {
        Text("Terminals").font(.system(size: 24, weight: .semibold))
        Text(
          "Your phone shows the terminals Shellbell can reach on this Mac. Each one below says whether it's ready and what to do if it isn't."
        )
        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        content
        NewSessionsCard()
      }
      .padding(24).frame(maxWidth: 680, alignment: .leading)
    }
    .onAppear { model.loadTerminals() }
    .onReceive(poll) { _ in model.loadTerminals() }
  }

  @ViewBuilder private var content: some View {
    if model.terminalsUnsupported {
      Card {
        Text(
          "The Shellbell service running on this Mac is older than this app, so it can't describe your terminals. Restart the service from General, or update the headless service."
        )
      }
    } else if let terminals = model.terminals {
      let shown = terminals.filter { !$0.absent }
      let others = terminals.filter(\.absent)
      ForEach(shown) { TerminalCard(terminal: $0, model: model) }
      if !others.isEmpty {
        DisclosureGroup(isExpanded: $showOthers) {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(others) { TerminalCard(terminal: $0, model: model) }
          }.padding(.top, 8)
        } label: {
          Text("Other supported terminals").font(.headline)
        }
      }
    } else if ServiceControls(status: model.status).action == .start
      || model.status["local"]["kind"] != .string("verified")
    {
      Card {
        Text("Shellbell is stopped. Start it from General to check your terminals.")
      }
    } else {
      Card { Text("Checking…").foregroundStyle(.secondary) }
    }
  }
}

private struct TerminalCard: View {
  let terminal: TerminalSetup
  @ObservedObject var model: ControllerModel

  var body: some View {
    Card {
      HStack(alignment: .firstTextBaseline) {
        Image(systemName: symbol).foregroundStyle(tint).accessibilityHidden(true)
        Text(terminal.label).font(.headline)
        Spacer()
      }
      Text(terminal.status).fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel("\(terminal.label): \(terminal.status)")
      if let steps = terminal.steps {
        Text(steps).font(.callout).foregroundStyle(.secondary)
          .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      }
      if let action = terminal.action {
        button(action)
      }
    }
  }

  private var symbol: String {
    if terminal.ready { return "checkmark.circle.fill" }
    if terminal.waiting { return "hourglass" }
    return terminal.needsAttention ? "exclamationmark.circle.fill" : "circle"
  }
  private var tint: Color {
    terminal.ready ? .green : terminal.needsAttention ? .orange : .secondary
  }

  @ViewBuilder private func button(_ action: TerminalSetup.Action) -> some View {
    switch action {
    case .connectITerm:
      Button("Connect iTerm2") { model.connectTerminal("iterm2") }
        .disabled(terminal.waiting || !model.serviceAvailable)
    case .openITerm:
      Button("Open iTerm2") {
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.googlecode.iterm2") {
          NSWorkspace.shared.openApplication(at: url, configuration: .init())
        }
      }
    case .openAutomationSettings:
      Button("Open Automation Settings") {
        if let url = URL(
          string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation")
        {
          NSWorkspace.shared.open(url)
        }
      }
    }
  }
}

/// Where phone-opened sessions appear: always a visible window on this Mac, never in the background.
private struct NewSessionsCard: View {
  var body: some View {
    Card {
      Text("Opening new sessions from your phone").font(.headline)
      Text(
        "A session you open from your phone always appears in a window on this Mac, in iTerm2 or else Ghostty, so nothing runs where you can't see it. Ghostty and Terminal tabs appear on your phone only when tmux or Herdr runs inside them."
      )
      .font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
    }
  }
}

private struct Card<Content: View>: View {
  @ViewBuilder let content: Content
  var body: some View {
    VStack(alignment: .leading, spacing: 8) { content }
      .padding(14).frame(maxWidth: .infinity, alignment: .leading)
      .background(Color(nsColor: .windowBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
      .accessibilityElement(children: .contain)
  }
}
