// Owner-enabled plugins are trusted local code, outside the packaged import closure.
export async function importTerminalPlugin(url) {
  const source = new URL(url);
  if (source.protocol !== "file:" || source.host || source.search || source.hash)
    throw new Error("Terminal plugin must use a plain local file URL");
  return import(source.href);
}
