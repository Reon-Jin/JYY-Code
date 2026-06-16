#!/usr/bin/env node

const fs = require("fs")
const path = require("path")

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: node script/set-release-version.cjs <semver>")
  process.exit(1)
}

const files = ["package.json", "packages/jyycode/package.json"]

for (const file of files) {
  const absolute = path.resolve(file)
  const pkg = JSON.parse(fs.readFileSync(absolute, "utf8"))
  pkg.version = version
  fs.writeFileSync(absolute, `${JSON.stringify(pkg, null, 2)}\n`)
  console.log(`set ${file} to ${version}`)
}
