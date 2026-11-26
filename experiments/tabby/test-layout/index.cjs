// Only installed in the disposable smoke profile. Place the two fixture processes in one split.
const { NgModule } = require("@angular/core");
const { TerminalDecorator } = require("tabby-terminal");
const { TerminalTabComponent } = require("tabby-local");
class FixtureLayout extends TerminalDecorator {
  attach(tab) {
    const pair = process.env.SHELLBELL_TABBY_FIXTURES?.split(",");
    if (pair?.length !== 2 || !(tab instanceof TerminalTabComponent)) return;
    const args = tab.profile.options?.args || [];
    const marker = args.at(-1);
    if (args.at(-2) !== process.env.SHELLBELL_TABBY_FIXTURE_PATH || !pair.includes(marker)) return;
    if (!this.tabs) this.tabs = new Map();
    this.tabs.set(marker, tab);
    if (this.tabs.size !== 2 || this.started) return;
    this.started = true;
    const first = this.tabs.get(pair[0]),
      second = this.tabs.get(pair[1]);
    const group = first.topmostParent;
    setImmediate(async () => {
      await group.addTab(second, first, "r");
      first.app.selectTab(group);
      group.focus(second);
    });
  }
}
class LayoutModule {}
NgModule({
  providers: [{ provide: TerminalDecorator, multi: true, useFactory: () => new FixtureLayout() }],
})(LayoutModule);
exports.default = LayoutModule;
