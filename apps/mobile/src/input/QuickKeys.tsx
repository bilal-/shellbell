import type { HostPlatform, NamedKey } from "@shellbell/protocol";
import { useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  Text,
  View,
  type ViewStyle,
} from "react-native";
import { tokens } from "../theme/tokens";
import { AppIcon, type AppIconName } from "../ui/AppIcon";
import { keyPresentation, type PresentedKey } from "./keyPresentation";
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

/** The keys that answer a waiting agent lead the row, in this order. */
const WAITING_KEYS = ["esc", "up", "down", "enter"] as const;

export interface InputModeToggle {
  active: boolean;
  onToggle: () => void;
}

/** Esc and ^C: amber, quiet enough to read as "careful" rather than "danger". */
export const WARNING_KEY_COLOR = tokens.accents.amber;
const WARNING_KEY_BORDER = `${tokens.accents.amber}59`;

const keyStyle = (
  height: number,
  dim: boolean,
  selected = false,
  minWidth = 44,
  warning = false,
): ViewStyle => ({
  minWidth,
  height,
  paddingHorizontal: 10,
  borderRadius: tokens.radius.sm,
  borderWidth: 1,
  borderColor: selected ? tokens.accents.emerald : warning ? WARNING_KEY_BORDER : tokens.border,
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

export const EDGE_FADE_WIDTH = 32;
const EDGE_FADE_STEPS = 8;

/**
 * The keys row's right edge fades into the bar while more keys lie beyond it, so the cut-off key
 * reads as "scroll for more". Stacked translucent slices stand in for a gradient, which would
 * need a native dependency.
 */
function EdgeFade() {
  return (
    <View
      testID="keys-edge-fade"
      pointerEvents="none"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        position: "absolute",
        top: 0,
        bottom: 0,
        right: 0,
        width: EDGE_FADE_WIDTH,
        flexDirection: "row",
      }}
    >
      {Array.from({ length: EDGE_FADE_STEPS }, (_, step) => (
        <View
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed, never reordered slices.
          key={step}
          style={{
            flex: 1,
            backgroundColor: tokens.surface,
            opacity: ((step + 1) / EDGE_FADE_STEPS) * 0.92,
          }}
        />
      ))}
    </View>
  );
}

export function QuickKeys({
  onKey,
  onText,
  onPaste,
  hostPlatform,
  agent = false,
  onGuide,
  secret,
  keyHeight = KEY_ROW_HEIGHT,
  disabled = false,
  waiting,
}: {
  onKey: (key: NamedKey) => void;
  onText?: (text: string) => boolean | undefined;
  onPaste: () => void;
  hostPlatform?: HostPlatform;
  /** The session runs a coding agent: its keys (Esc, menus, Shift-Tab, digits) come first. */
  agent?: boolean;
  onGuide?: () => void;
  /** Secret input: a hidden, unsaved line for password prompts. */
  secret?: InputModeToggle;
  keyHeight?: number;
  disabled?: boolean;
  /**
   * The session waits on the person: a label leads the row, then the keys that answer. The row
   * keeps its height, so the terminal above doesn't move. `label` is spoken in full.
   */
  waiting?: { label: string; accent: string };
}) {
  const [modifiers, setModifiers] = useState<KeyModifiers>({ ...NO_MODIFIERS });
  // Measured in refs; only crossing the "more to the right" line re-renders the row.
  const extent = useRef({ width: 0, content: 0, offset: 0 });
  const [moreRight, setMoreRight] = useState(false);
  const measure = (next: Partial<typeof extent.current>) => {
    extent.current = { ...extent.current, ...next };
    const { width, content, offset } = extent.current;
    const more = width > 0 && content - width - offset > 4;
    if (more !== moreRight) setMoreRight(more);
  };
  const chord = modifierLabel(modifiers);
  const { keys: allKeys, primary } = keyPresentation(hostPlatform, agent);
  // A character key types through `onText`; without it there is no way to send one.
  const sendable = (k: PresentedKey) => Boolean(onText) || k.key !== undefined;
  const usual = allKeys.filter(sendable);
  const leading = (k: PresentedKey) =>
    WAITING_KEYS.findIndex((name) => name === k.key) + 1 || WAITING_KEYS.length + 1;
  // A stable sort: only the answering keys move, and the rest keep their usual order.
  const presented = waiting ? [...usual].sort((a, b) => leading(a) - leading(b)) : usual;
  const scroll = useRef<ScrollView>(null);
  const isWaiting = Boolean(waiting);
  useEffect(() => {
    if (isWaiting) scroll.current?.scrollTo?.({ x: 0, animated: true });
  }, [isWaiting]);
  const primaryCount = allKeys.slice(0, primary).filter(sendable).length;
  const modified = (k: PresentedKey) =>
    k.key !== undefined
      ? modifiedKey(k.key, modifiers)
      : modifiedCharacter(k.text ?? "", modifiers);
  const send = (k: PresentedKey) => {
    if (!chord) {
      if (k.key !== undefined) onKey(k.key);
      else if (k.text) onText?.(k.text);
      return;
    }
    const bytes = modified(k);
    if (bytes === null || !onText) return;
    if (onText(bytes) !== false) setModifiers({ ...NO_MODIFIERS });
  };
  const keyButton = (k: PresentedKey) => {
    const additionalModifiers = {
      ...modifiers,
      control: modifiers.control && !k.key?.startsWith("ctrl-"),
    };
    const keyChord = modifierLabel(additionalModifiers);
    const prefix = [
      additionalModifiers.shift && "Shift",
      additionalModifiers.control && "Ctrl",
      additionalModifiers.alt && "Alt",
    ]
      .filter(Boolean)
      .join("+");
    const unsupported = Boolean(chord && modified(k) === null);
    const icon = k.key === undefined ? undefined : KEY_ICONS[k.key];
    const color = k.warning ? WARNING_KEY_COLOR : tokens.text;
    return (
      <Pressable
        key={k.id}
        accessibilityRole="button"
        accessibilityLabel={keyChord ? `${keyChord} ${k.accessibilityLabel}` : k.accessibilityLabel}
        accessibilityHint={
          unsupported ? "This key combination is unavailable" : "Sends this key to the terminal"
        }
        disabled={disabled || unsupported}
        accessibilityState={{ disabled: disabled || unsupported }}
        onPress={() => send(k)}
        style={keyStyle(keyHeight, disabled || unsupported, false, 44, k.warning)}
      >
        {icon ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            {prefix ? <Text style={{ color, fontSize: 13 }}>{prefix}+</Text> : null}
            <AppIcon name={icon} size={18} color={color} />
          </View>
        ) : (
          <Text style={{ color, fontSize: 13, fontWeight: k.warning ? "600" : "400" }}>
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
    <View>
      <ScrollView
        ref={scroll}
        horizontal
        keyboardShouldPersistTaps="always"
        keyboardDismissMode="none"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 2 }}
        onLayout={(event: LayoutChangeEvent) => measure({ width: event.nativeEvent.layout.width })}
        onContentSizeChange={(content: number) => measure({ content })}
        onScroll={(event: NativeSyntheticEvent<NativeScrollEvent>) =>
          measure({ offset: event.nativeEvent.contentOffset.x })
        }
        scrollEventThrottle={32}
      >
        {waiting ? (
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={waiting.label}
            accessibilityLiveRegion="polite"
            style={{
              height: keyHeight,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingLeft: 2,
              paddingRight: 4,
            }}
          >
            <View
              style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: waiting.accent }}
            />
            <Text style={{ color: waiting.accent, fontSize: 13, fontWeight: "700" }}>Waiting</Text>
          </View>
        ) : null}
        {presented.slice(0, primaryCount).map(keyButton)}
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
        {presented.slice(primaryCount).map(keyButton)}
        {onText && chord
          ? [..."abcdefghijklmnopqrstuvwxyz", " ", "[", "]", "\\", "^", "_", "?"].map(
              (character) => (
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
                    if (bytes !== null && onText(bytes) !== false)
                      setModifiers({ ...NO_MODIFIERS });
                  }}
                  style={keyStyle(keyHeight, disabled, false, 36)}
                >
                  <Text style={{ color: tokens.text, fontSize: 13 }}>
                    {character === " " ? "Space" : character.toUpperCase()}
                  </Text>
                </Pressable>
              ),
            )
          : null}
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
      {moreRight ? <EdgeFade /> : null}
    </View>
  );
}
