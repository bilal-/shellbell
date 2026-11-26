const { NgModule } = require("@angular/core");
const { TerminalDecorator } = require("tabby-terminal");
const { TerminalTabComponent } = require("tabby-local");
const { WindowBridge } = require("./bridge.cjs");

class ShellbellDecorator extends TerminalDecorator {
  constructor() {
    super();
    this.bridge = new WindowBridge();
  }
  attach(tab) {
    if (
      process.env.SHELLBELL_TABBY_DIR &&
      tab instanceof TerminalTabComponent &&
      typeof tab.frontend?.xterm?.onWriteParsed === "function"
    )
      this.bridge.attach(tab);
  }
  detach(tab) {
    this.bridge.detach(tab);
    super.detach(tab);
  }
}
class ShellbellModule {}
NgModule({
  providers: [
    { provide: TerminalDecorator, multi: true, useFactory: () => new ShellbellDecorator() },
  ],
})(ShellbellModule);
exports.default = ShellbellModule;
