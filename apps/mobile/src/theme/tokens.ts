export const tokens = {
  bg: "#000000",
  surface: "#0B0B0D",
  surface2: "#131317",
  border: "#1F1F26",
  text: "#E8E8ED",
  textMuted: "#7C7C89",
  textFaint: "#4A4A55",
  accents: {
    emerald: "#10B981",
    blue: "#3B82F6",
    amber: "#F59E0B",
    violet: "#A855F7",
    rose: "#F43F5E",
    cyan: "#06B6D4",
    lime: "#84CC16",
    orange: "#F97316",
  },
  terminal16: [
    "#1C1C1E",
    "#F87171",
    "#4ADE80",
    "#FBBF24",
    "#60A5FA",
    "#C084FC",
    "#22D3EE",
    "#D4D4D8",
    "#52525B",
    "#FCA5A5",
    "#86EFAC",
    "#FDE68A",
    "#93C5FD",
    "#D8B4FE",
    "#67E8F9",
    "#FFFFFF",
  ],
  radius: { sm: 8, md: 12, lg: 18 },
  space: [0, 4, 8, 12, 16, 24, 32],
} as const;

// Review I2: these must match the *embedded* font's real names, not the TTF filenames. iOS
// resolves a natively embedded font by its PostScript name (confirmed via `fc-scan
// --format '%{postscriptname}'`: this file's is `JetBrainsMonoNF-Regular`, not
// `JetBrainsMonoNerdFont-Regular`); the Android family names are `app.json`'s own choice (the
// `expo-font` plugin's `android.fonts` entries), picked to match 1:1 so one map serves both
// platforms.
export const FONT = {
  regular: "JetBrainsMonoNF-Regular",
  bold: "JetBrainsMonoNF-Bold",
  italic: "JetBrainsMonoNF-Italic",
  boldItalic: "JetBrainsMonoNF-BoldItalic",
} as const;
