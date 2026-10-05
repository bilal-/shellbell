import CoreImage.CIFilterBuiltins
import ShellbellCore
import SwiftUI

struct PairingView: View {
  @ObservedObject var model: ControllerModel
  let done: () -> Void
  var body: some View {
    VStack(spacing: 0) {
      HStack {
        Button(action: done) { Label("Devices", systemImage: "chevron.left") }
        Spacer()
      }.padding(.horizontal, 28).padding(.top, 24)
      ScrollView {
        VStack(spacing: 12) {
          ShellbellMark(size: 40)
          Text("Connect to Shellbell").font(.system(size: 24, weight: .semibold))
          Text("Open Shellbell on your phone and scan this code.")
            .foregroundStyle(.secondary).multilineTextAlignment(.center)
          Group {
            if let text = model.pairing["qrText"].string, let image = qr(text) {
              Image(nsImage: image).interpolation(.none).resizable()
                .frame(width: 224, height: 224).padding(16).background(.white)
                .accessibilityLabel("Shellbell pairing QR code")
            } else {
              VStack(spacing: 12) {
                Image(systemName: "qrcode").font(.system(size: 60)).foregroundStyle(.secondary)
                Text(model.busy ? "Preparing your code…" : "Generate a code to connect your phone.")
                  .multilineTextAlignment(.center)
                Button("Generate New Code") { model.openPairing() }
                  .disabled(!model.serviceAvailable || model.pairingOwned)
              }.frame(width: 256, height: 256)
            }
          }.frame(width: 256, height: 256)
          Text(
            model.pairing["expiresAt"].number.map {
              "Code expires at \(Date(timeIntervalSince1970: $0 / 1000).formatted(date: .omitted, time: .shortened))"
            } ?? " "
          ).font(.caption).foregroundStyle(.secondary).frame(height: 18)
          if model.consent != .null {
            VStack(spacing: 10) {
              Text("Allow \(model.consent["name"].string ?? "this phone")?").font(.headline)
              Text(model.consent["phoneFp"].string ?? "")
                .font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                .accessibilityLabel("Phone fingerprint")
              Text("Compare this fingerprint with the one on your phone before allowing it.")
                .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
              HStack {
                Button("Decline") { model.confirmPairing(accept: false) }
                Button("Allow Device") { model.confirmPairing(accept: true) }.buttonStyle(
                  .borderedProminent)
              }.disabled(!model.serviceAvailable)
            }
          } else {
            Label("Your terminal connection is end-to-end encrypted.", systemImage: "lock.shield")
              .font(.caption).foregroundStyle(.secondary)
          }
        }.frame(maxWidth: .infinity).padding(.horizontal, 28).padding(.vertical, 16)
      }
    }
  }
  private func qr(_ text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    guard let output = filter.outputImage,
      let cg = CIContext().createCGImage(output, from: output.extent)
    else { return nil }
    return NSImage(
      cgImage: cg, size: NSSize(width: output.extent.width, height: output.extent.height))
  }
}
