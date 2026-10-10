import { Image } from "react-native";

/** The splash artwork, on black like `app.json`'s native splash, so the two read as one screen. */
export function SplashMark({ size = 200 }: { size?: number }) {
  return (
    <Image
      source={require("../../assets/splash-icon.png")}
      accessible={false}
      style={{ width: size, height: size }}
    />
  );
}
