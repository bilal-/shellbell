import type { ConfigContext } from "expo/config";
import { mobileConfig } from "./config";

export default ({ config }: ConfigContext) => mobileConfig(config, process.env);
