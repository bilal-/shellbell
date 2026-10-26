// Android builds leave expo-symbols out (see `expo.autolinking.android.exclude` in package.json):
// app icons there are Nerd Font glyphs (src/ui/AppIcon.android.tsx). Expo Router's unused native
// tabs still import it, and the real package would pull its 1 MB Material Symbols font into the
// bundle, so Metro resolves it here instead. Nothing in the app renders these.
function SymbolView() {
  return null;
}
async function unstable_getMaterialSymbolSourceAsync() {
  return null;
}
module.exports = { SymbolView, unstable_getMaterialSymbolSourceAsync };
