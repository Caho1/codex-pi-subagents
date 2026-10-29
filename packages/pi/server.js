#!/usr/bin/env node
import { registerHooks } from "node:module";

let sdkURL = process.env.PI_SUBAGENTS_SDK_URL;
if (!sdkURL) {
  try {
    sdkURL = import.meta.resolve("@earendil-works/pi-coding-agent");
  } catch {
    throw new Error("Pi SDK is unavailable. Install @earendil-works/pi-coding-agent or start this service from Pi.");
  }
}

const distURL = new URL("./dist/", import.meta.url).href;
const sdkPackages = new Set(["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core"]);
// 只重定向服务自身的 SDK 导入，保留 Pi 和用户扩展各自的模块解析。
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(distURL) && sdkPackages.has(specifier)) {
      return nextResolve(specifier, { ...context, parentURL: sdkURL });
    }
    return nextResolve(specifier, context);
  },
});
await import("./dist/main.js");
