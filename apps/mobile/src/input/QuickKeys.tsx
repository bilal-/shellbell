import type { HostPlatform, NamedKey } from "@shellbell/protocol";
import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { tokens } from "../theme/tokens";
import { AppIcon, type AppIconName } from "../ui/AppIcon";
import { keyPresentation } from "./keyPresentation";
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

export function QuickKeys({
  onKey,
  onText,
  onPaste,
  hostPlatform,
  onGuide,
  onKeyboard,
  onCompose,
  disabled = false,
}: {
  onKey: (key: NamedKey) => void;
  onText?: (text: string) => boolean | undefined;
  onPaste: () => void;
  hostPlatform?: HostPlatform;
  onGuide?: () => void;
  onKeyboard?: () => void;
  onCompose?: () => void;
  disabled?: boolean;
}) {
  const [modifiers, setModifiers] = useState<KeyModifiers>({ ...NO_MODIFIERS });
  const chord = modifierLabel(modifiers);
  const presented = keyPresentation(hostPlatform).keys;
  const arrows = ["left", "right", "up", "down"];
  const keys = onText
    ? [
        ...arrows.flatMap((name) => presented.filter((key) => key.key === name)),
        ...presented.filter((key) => !arrows.includes(key.key)),
      ]
    : presented;
  const send = (key: NamedKey) => {
    if (!chord) return onKey(key);
    const bytes = modifiedKey(key, modifiers);
    if (bytes === null || !onText) return;
    if (onText(bytes) !== false) setModifiers({ ...NO_MODIFIERS });
  };
  return (
    <ScrollView
      horizontal
      keyboardShouldPersistTaps="always"
      keyboardDismissMode="none"
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
    >
      {onKeyboard ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show terminal keyboard"
          onPress={onKeyboard}
          style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: "center" }}
        >
          <Text style={{ color: tokens.accents.emerald }}>Keyboard</Text>
        </Pressable>
      ) : null}
      {onCompose ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Compose a command before sending"
          onPress={onCompose}
          style={{ minHeight: 44, paddingHorizontal: 12, justifyContent: "center" }}
        >
          <Text style={{ color: tokens.text }}>Compose</Text>
        </Pressable>
      ) : null}
      {onGuide ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Key guide"
          accessibilityHint="Explains terminal keys without sending input"
          onPress={onGuide}
          style={{ height: 44, paddingHorizontal: 10, justifyContent: "center" }}
        >
          <Text style={{ color: tokens.textMuted, fontSize: 13 }}>Key guide</Text>
        </Pressable>
      ) : null}
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
              style={{
                minWidth: 44,
                height: 44,
                paddingHorizontal: 10,
                borderRadius: tokens.radius.sm,
                borderWidth: 1,
                borderColor: modifiers[name] ? tokens.accents.emerald : tokens.border,
                backgroundColor: tokens.surface2,
                alignItems: "center",
                justifyContent: "center",
                opacity: disabled ? 0.4 : 1,
              }}
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
      {keys.map((k) => {
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
            accessibilityLabel={
              keyChord ? `${keyChord} ${k.accessibilityLabel}` : k.accessibilityLabel
            }
            accessibilityHint={
              unsupported ? "This key combination is unavailable" : "Sends this key to the terminal"
            }
            disabled={disabled || unsupported}
            accessibilityState={{ disabled: disabled || unsupported }}
            onPress={() => send(k.key)}
            style={{
              minWidth: 44,
              height: 44,
              paddingHorizontal: 10,
              borderRadius: tokens.radius.sm,
              borderWidth: 1,
              borderColor: tokens.border,
              backgroundColor: tokens.surface2,
              alignItems: "center",
              justifyContent: "center",
              opacity: disabled || unsupported ? 0.4 : 1,
            }}
          >
            {icon ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                {prefix ? (
                  <Text style={{ color: tokens.text, fontSize: 13 }}>{prefix}+</Text>
                ) : null}
                <AppIcon name={icon} size={18} />
              </View>
            ) : (
              <Text style={{ color: tokens.text, fontSize: 13 }}>
                {prefix ? `${prefix}+${k.label}` : k.label}
              </Text>
            )}
          </Pressable>
        );
      })}
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
              style={{
                minWidth: 36,
                height: 44,
                paddingHorizontal: 10,
                borderRadius: tokens.radius.sm,
                borderWidth: 1,
                borderColor: tokens.border,
                backgroundColor: tokens.surface2,
                alignItems: "center",
                justifyContent: "center",
                opacity: disabled ? 0.4 : 1,
              }}
            >
              <Text style={{ color: tokens.text, fontSize: 13 }}>
                {character === " " ? "Space" : character.toUpperCase()}
              </Text>
            </Pressable>
          ))
        : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Paste to terminal"
        accessibilityHint="Sends clipboard text to the terminal"
        disabled={disabled}
        accessibilityState={{ disabled }}
        onPress={onPaste}
        style={{
          minWidth: 36,
          height: 44,
          paddingHorizontal: 10,
          borderRadius: tokens.radius.sm,
          borderWidth: 1,
          borderColor: tokens.border,
          backgroundColor: tokens.surface2,
          alignItems: "center",
          justifyContent: "center",
          opacity: disabled ? 0.4 : 1,
        }}
      >
        <Text style={{ color: tokens.text, fontSize: 13 }}>Paste</Text>
      </Pressable>
    </ScrollView>
  );
}
