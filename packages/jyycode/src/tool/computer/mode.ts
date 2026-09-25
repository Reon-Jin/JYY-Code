import type { Auth } from "@/auth"

export const JEV_CREDENTIAL_ID = "typesafe-jev"

export function jevApiKey(auth: Auth.Info | undefined): string | undefined {
  if (auth?.type !== "api") return undefined
  return auth.key.trim() || undefined
}

export function computerMode(auth: Auth.Info | undefined): "jev" | "legacy" {
  return jevApiKey(auth) ? "jev" : "legacy"
}

export function assertComputerAction(apiKey: string | undefined, action: string) {
  if (apiKey && action !== "choose" && action !== "observe") {
    throw new Error("Jev mode is active: use action=choose for desktop input")
  }
  if (!apiKey && action === "choose") {
    throw new Error("Jev API is not active: use legacy computer actions")
  }
}
