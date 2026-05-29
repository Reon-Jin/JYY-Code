const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://jyycode.ai" : `https://${stage}.jyycode.ai`,
  console: stage === "production" ? "https://jyycode.ai/auth" : `https://${stage}.jyycode.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/jyycode",
  discord: "https://jyycode.ai/discord",
  headerLinks: [
    { name: "app.header.home", url: "/" },
    { name: "app.header.docs", url: "/docs/" },
  ],
}
