import type { HostPlatform, NamedKey } from "@shellbell/protocol";
import { useState } from "react";
import { Pressable, ScrollView, Text, View, type ViewStyle } from "react-native";
import { tokens } from "../theme/tokens";
import { AppIcon, type AppIconName } from "../ui/AppIcon";
import { keyPresentation } from "./keyPresentation";
import { PRIMARY_KEY_COUNT } from "./keys";
import { KEY_ROW_HEIGHT } from "./layout";
import {
  type KeyModifiers,
  modifiedCharacter,
  modifiedKey,
  modifierLabel,
  NO_MODIFIERS,
} from "./modifiers";

const KEY_ICONS: Partial<Record<NamedKey, AppIconName>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  backspace: "backspace",
};

export interface InputModeToggle {
  active: boolean;
  onToggle: () => void;
}

const keyStyle = (height: number, dim: boolean, selected = false, minWidth = 44): ViewStyle => ({
  minWidth,
  height,
  paddingHorizontal: 10,
  borderRadius: tokens.radius.sm,
  borderWidth: 1,
  borderColor: selected ? tokens.accents.emerald : tokens.border,
  backgroundColor: tokens.surface2,
  alignItems: "center",
  justifyContent: "center",
  opacity: dim ? 0.4 : 1,
});

function Divider({ height }: { height: number }) {
  return (
    <View
      accessible={false}
      importantForAccessibility="no"
      style={{
        width: 1,
        height: Math.round(height * 0.55),
        alignSelf: "center",
        backgroundColor: tokens.border,
      }}
    />
  );
}

export function QuickKeys({
  onKey,
  onText,
  onPaste,
  hostPlatform,
  onGuide,
  live,
  secret,
  keyHeight = KEY_ROW_HEIGHT,
  disabled = false,
}: {
  onKey: (key: NamedKey) => void;
  onText?: (text: string) => boolean | undefined;
  onPaste: () => void;
  hostPlatform?: HostPlatform;
  onGuide?: () => void;
  /** Live keys: every keystroke goes straight to the terminal. */
  live?: InputModeToggle;
  /** Secret input: a hidden, unsaved line for password prompts. */
  secret?: InputModeToggle;
  keyHeight?: number;
  disabled?: boolean;
}) {
  const [modifiers, setModifiers] = useState<KeyModifiers>({ ...NO_MODIFIERS });
  const chord = modifierLabel(modifiers);
  const presented = keyPresentation(hostPlatform).keys;
  const send = (key: NamedKey) => {
    if (!chord) return onKey(key);
    const bytes = modifiedKey(key, modifiers);
    if (bytes === null || !onText) return;
    if (onText(bytes) !== false) setModifiers({ ...NO_MODIFIERS });
  };
  const keyButton = (k: (typeof presented)[number]) => {
    const additionalModifiers = {
      ...modifiers,
      control: modifiers.control && !k.key.startsWith("ctrl-"),
    };
    const keyChord = modifierLabel(additionalModifiers);
    const prefix = [
      additionalModifiers.shift && "Shift",
      additionalModifiers.control && "Ctrl",
      additionalModifiers.alt && "Alt",
    ]
      .filter(Boolean)
      .join("+");
    const unsupported = Boolean(chord && modifiedKey(k.key, modifiers) === null);
    const icon = KEY_ICONS[k.key];
    return (
      <Pressable
        key={k.key}
        accessibilityRole="button"
        accessibilityLabel={keyChord ? `${keyChord} ${k.accessibilityLabel}` : k.accessibilityLabel}
        accessibilityHint={
          unsupported ? "This key combination is unavailable" : "Sends this key to the terminal"
        }
        disabled={disabled || unsupported}
        accessibilityState={{ disabled: disabled || unsupported }}
        onPress={() => send(k.key)}
        style={keyStyle(keyHeight, disabled || unsupported)}
      >
        {icon ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            {prefix ? <Text style={{ color: tokens.text, fontSize: 13 }}>{prefix}+</Text> : null}
            <AppIcon name={icon} size={18} />
          </View>
        ) : (
          <Text style={{ color: tokens.text, fontSize: 13 }}>
            {prefix ? `${prefix}+${k.label}` : k.label}
          </Text>
        )}
      </Pressable>
    );
  };
  const modeToggle = (
    mode: InputModeToggle,
    label: string,
    accessibilityLabel: string,
    hint: string,
    icon?: AppIconName,
  ) => (
    <Pressable
      key={accessibilityLabel}
      accessibilityRole="switch"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={hint}
      accessibilityState={{ disabled, checked: mode.active }}
      disabled={disabled}
      onPress={mode.onToggle}
      style={{ ...keyStyle(keyHeight, disabled, mode.active), flexDirection: "row", gap: 6 }}
    >
      {icon ? (
        <AppIcon
          name={icon}
          size={14}
          color={mode.active ? tokens.accents.emerald : tokens.textMuted}
        />
      ) : (
        <View
          style={{
            width: 6,
            height: 6,
            borderRadius: 3,
            backgroundColor: mode.active ? tokens.accents.emerald : tokens.textFaint,
          }}
        />
      )}
      <Text
        style={{
          color: mode.active ? tokens.accents.emerald : tokens.text,
          fontSize: 13,
          fontWeight: "600",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      keyboardDismissMode="none"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {live
        ? modeToggle(
            live,
            "Live",
            "Live keys",
            "Sends each key straight to the terminal, for vim, less and other full-screen programs",
          )
        : null}
      {presented.slice(0, PRIMARY_KEY_COUNT).map(keyButton)}
      {onText ? <Divider height={keyHeight} /> : null}
      {onText
        ? (
            [
              ["shift", "Shift"],
              ["control", "Ctrl"],
              ["alt", "Alt"],
            ] as const
          ).map(([name, label]) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={`${name === "control" ? "Control" : label} modifier`}
              accessibilityHint="Applies to the next terminal key or character button"
              accessibilityState={{ disabled, selected: modifiers[name] }}
              disabled={disabled}
              onPress={() => setModifiers((current) => ({ ...current, [name]: !current[name] }))}
              style={keyStyle(keyHeight, disabled, modifiers[name])}
            >
              <Text
                style={{
                  color: modifiers[name] ? tokens.accents.emerald : tokens.text,
                  fontSize: 13,
                }}
              >
                {label}
              </Text>
            </Pressable>
          ))
        : null}
      {onText && chord
        ? [..."abcdefghijklmnopqrstuvwxyz", " ", "[", "]", "\\", "^", "_", "?"].map((character) => (
            <Pressable
              key={`character:${character}`}
              accessibilityRole="button"
              accessibilityLabel={`Send ${chord} ${character === " " ? "Space" : character.toUpperCase()}`}
              accessibilityHint="Sends this character combination to the terminal"
              disabled={disabled || modifiedCharacter(character, modifiers) === null}
              accessibilityState={{
                disabled: disabled || modifiedCharacter(character, modifiers) === null,
              }}
              onPress={() => {
                const bytes = modifiedCharacter(character, modifiers);
                if (bytes !== null && onText(bytes) !== false) setModifiers({ ...NO_MODIFIERS });
              }}
              style={keyStyle(keyHeight, disabled, false, 36)}
            >
              <Text style={{ color: tokens.text, fontSize: 13 }}>
                {character === " " ? "Space" : character.toUpperCase()}
              </Text>
            </Pressable>
          ))
        : null}
      {presented.slice(PRIMARY_KEY_COUNT).map(keyButton)}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Paste to terminal"
        accessibilityHint="Sends clipboard text to the terminal"
        disabled={disabled}
        accessibilityState={{ disabled }}
        onPress={onPaste}
        style={keyStyle(keyHeight, disabled, false, 36)}
      >
        <Text style={{ color: tokens.text, fontSize: 13 }}>Paste</Text>
      </Pressable>
      {secret
        ? modeToggle(
            secret,
            "Secret",
            "Secret input",
            "Types a password without showing it or saving it to command history",
            "lock",
          )
        : null}
      {onGuide ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Key guide"
          accessibilityHint="Explains terminal keys and input modes without sending input"
          onPress={onGuide}
          style={{ height: keyHeight, paddingHorizontal: 10, justifyContent: "center" }}
        >
          <Text style={{ color: tokens.textMuted, fontSize: 13 }}>Key guide</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}
