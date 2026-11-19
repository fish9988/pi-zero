import { PI_NATIVE_SLASH_COMMANDS, mergePiSlashCommands } from "./index.js";

export function examplePiSlashList() {
  return mergePiSlashCommands([
    { name: "deploy", description: "Run deployment skill", source: "skill" },
  ]).slice(0, PI_NATIVE_SLASH_COMMANDS.length + 1);
}
