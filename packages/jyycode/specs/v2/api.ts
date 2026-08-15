// @ts-nocheck

import { JYYCode } from "@jyycode-ai/core"
import { ReadTool } from "@jyycode-ai/core/tools"

const jyycode = JYYCode.make({})

jyycode.tool.add(ReadTool)

jyycode.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute() {},
})

jyycode.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

jyycode.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await jyycode.session.create({
  agent: "build",
})

jyycode.subscribe((event) => {
  console.log(event)
})

await jyycode.session.prompt({
  sessionID,
  text: "hey what is up",
})

await jyycode.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await jyycode.session.wait()

console.log(await jyycode.session.messages(sessionID))
