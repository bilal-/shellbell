import { useEffect, useRef, useState } from "react";
import { Platform, TextInput } from "react-native";
import { FONT, tokens } from "../theme/tokens";
import { liveKeysIme } from "./imeProps";
import {
  LIVE_BACKSPACE,
  LIVE_BACKSPACE_ECHO_MS,
  LIVE_BUFFER_LIMIT,
  LIVE_IDLE_RESET_MS,
  liveKeysDiff,
} from "./liveKeys";

/**
 * A native field whose edits become terminal keystrokes. It only ever holds the last few
 * characters typed: each change is read against that small buffer, and the buffer is emptied after
 * a pause or once it reaches `LIVE_BUFFER_LIMIT`. Backspace on an empty field changes no text, so
 * the key event is what sends DEL then; a key event that only echoes a deleting change is ignored.
 */
export function LiveKeysField({
  onBytes,
  autoFocus,
  editable,
  height,
  onFocusChange,
}: {
  onBytes: (data: string) => void;
  autoFocus: boolean;
  editable: boolean;
  height: number;
  onFocusChange?: (focused: boolean) => void;
}) {
  const ime = liveKeysIme(Platform.OS);
  const [value, setValue] = useState("");
  const buffer = useRef("");
  const lastDelete = useRef(Number.NEGATIVE_INFINITY);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearIdle = () => {
    if (idle.current !== null) clearTimeout(idle.current);
    idle.current = null;
  };
  const reset = () => {
    clearIdle();
    buffer.current = "";
    setValue("");
  };
  useEffect(
    () => () => {
      if (idle.current !== null) clearTimeout(idle.current);
    },
    [],
  );
  return (
    <TextInput
      accessibilityLabel="Live keys input"
      accessibilityHint="Each key you type goes straight to the terminal"
      autoFocus={autoFocus}
      editable={editable}
      value={value}
      onChangeText={(next) => {
        const bytes = liveKeysDiff(buffer.current, next);
        if (bytes.startsWith(LIVE_BACKSPACE)) lastDelete.current = Date.now();
        buffer.current = next;
        setValue(next);
        onBytes(bytes);
        if (Array.from(next).length >= LIVE_BUFFER_LIMIT) reset();
        else {
          clearIdle();
          idle.current = setTimeout(reset, LIVE_IDLE_RESET_MS);
        }
      }}
      onKeyPress={({ nativeEvent }) => {
        if (nativeEvent.key !== "Backspace" || buffer.current !== "") return;
        // The key event of the deletion that just emptied the field; later presses are new keys.
        const echo = Date.now() - lastDelete.current < LIVE_BACKSPACE_ECHO_MS;
        lastDelete.current = 0;
        if (echo) return;
        onBytes(LIVE_BACKSPACE);
      }}
      onSubmitEditing={() => {
        onBytes("\r");
        reset();
      }}
      onFocus={() => onFocusChange?.(true)}
      onBlur={() => onFocusChange?.(false)}
      blurOnSubmit={false}
      submitBehavior="submit"
      disableFullscreenUI
      placeholder="Typing goes straight to the terminal"
      placeholderTextColor={tokens.textFaint}
      autoCorrect={ime.autoCorrect}
      autoCapitalize={ime.autoCapitalize}
      spellCheck={ime.spellCheck}
      autoComplete={ime.autoComplete}
      textContentType="none"
      importantForAutofill="no"
      keyboardType={ime.keyboardType}
      returnKeyType="default"
      style={{
        flex: 1,
        color: tokens.text,
        fontFamily: FONT.regular,
        paddingVertical: 10,
        paddingHorizontal: 8,
        fontSize: 15,
        height,
        textAlignVertical: "center",
      }}
    />
  );
}
