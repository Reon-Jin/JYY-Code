import yargs from "yargs"
import { TuiThreadCommand } from "./cli/cmd/tui/thread"
import { InstallationVersion } from "@jyycode-ai/core/installation/version"
import { hideBin } from "yargs/helpers"
import { Log } from "./node"
import { LLMTrace } from "@/dev/llm-trace"

Log.init({
  print: false,
})
LLMTrace.init()

yargs(hideBin(process.argv))
  .parserConfiguration({ "populate--": true })
  .scriptName("jyycode")
  .wrap(100)
  .help("help", "show help")
  .alias("help", "h")
  .version("version", "show version number", InstallationVersion)
  .alias("version", "v")
  .option("print-logs", {
    describe: "print logs to stderr",
    type: "boolean",
  })
  .option("log-level", {
    describe: "log level",
    type: "string",
    choices: ["DEBUG", "INFO", "WARN", "ERROR"],
  })
  .option("pure", {
    describe: "run without external plugins",
    type: "boolean",
  })
  .command(TuiThreadCommand)
  .parse()
