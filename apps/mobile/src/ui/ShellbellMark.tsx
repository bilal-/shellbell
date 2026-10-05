import { Image } from "react-native";
import { tokens } from "../theme/tokens";

export function ShellbellMark({ size = 44 }: { size?: number }) {
  return (
    <Image
      source={require("../../assets/icon.png")}
      accessible={false}
      style={{ width: size, height: size, borderRadius: tokens.radius.sm }}
    />
  );
}
