import type { PropsWithChildren } from "react";
import { Modal, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { tokens } from "../theme/tokens";

/**
 * The app's bottom sheet: a dimmed backdrop that dismisses on tap, and one rounded card. Callers
 * own visibility and must close it when App Lock hides the app (`useCloseWhenHidden`).
 */
export function Sheet({
  visible,
  onClose,
  onDismiss,
  dismissLabel,
  accessibilityLabel,
  children,
}: PropsWithChildren<{
  visible: boolean;
  onClose: () => void;
  /** iOS only: the sheet has finished animating out, so another modal may now be presented. */
  onDismiss?: () => void;
  dismissLabel: string;
  accessibilityLabel?: string;
}>) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
      onDismiss={onDismiss}
      accessibilityLabel={accessibilityLabel}
      supportedOrientations={["portrait", "landscape-left", "landscape-right"]}
    >
      <View
        style={{
          flex: 1,
          justifyContent: "flex-end",
          alignItems: "center",
          paddingLeft: Math.max(16, insets.left ?? 0),
          paddingRight: Math.max(16, insets.right ?? 0),
          paddingTop: Math.max(16, insets.top),
          paddingBottom: Math.max(16, insets.bottom),
          backgroundColor: "rgba(0,0,0,0.65)",
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={dismissLabel}
          onPress={onClose}
          style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            width: "100%",
            maxWidth: 560,
            maxHeight: "90%",
            borderRadius: tokens.radius.lg,
            borderWidth: 1,
            borderColor: tokens.border,
            backgroundColor: tokens.surface2,
            padding: 20,
            gap: 12,
          }}
        >
          {children}
        </View>
      </View>
    </Modal>
  );
}
