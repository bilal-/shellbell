// Explicit simulator/emulator entry point. Normal builds use expo-router/entry.
// Install Expo's runtime globals before the fixture imports protocol/stream code.
import "expo";
import "../src/bootstrap/crypto";
import "./seed";
import "expo-router/entry";
