#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  buildSemanticPacket,
  createCampaign,
  importReview,
  launchFresh,
  parkController,
  readController,
  startController,
  submitGlassCommand,
} from "./provider-custody.mjs";

const [root, command, ...args] = process.argv.slice(2);

function usage() {
  console.error(
    "usage: provider-custody-cli.mjs <root> " +
      "<init <json> | start | status | packet | launch-fresh <provider> <model> <effort> <readiness-json> | " +
      "park [reason] | import-review <json> | glass-submit <json>>",
  );
  process.exitCode = 2;
}

function jsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

if (!root || !command) {
  usage();
} else {
  let result;
  switch (command) {
    case "init":
      if (!args[0]) usage();
      else result = createCampaign(root, jsonFile(args[0]));
      break;
    case "start":
      result = startController(root);
      break;
    case "status":
      result = readController(root);
      break;
    case "packet":
      result = buildSemanticPacket(root);
      break;
    case "launch-fresh":
      if (!args[0] || !args[1] || !args[3]) usage();
      else {
        result = launchFresh(root, {
          provider: args[0],
          model: args[1],
          effort: args[2] || "",
          readiness: jsonFile(args[3]),
        });
      }
      break;
    case "park":
      result = parkController(root, { reason: args.join(" ") });
      break;
    case "import-review": {
      if (!args[0]) {
        usage();
        break;
      }
      const input = jsonFile(args[0]);
      result = importReview(root, {
        ...input,
        prompt: readFileSync(input.promptPath, "utf8"),
        verdict: readFileSync(input.verdictPath, "utf8"),
      });
      break;
    }
    case "glass-submit":
      if (!args[0]) usage();
      else result = submitGlassCommand(root, jsonFile(args[0]));
      break;
    default:
      usage();
  }
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
}
