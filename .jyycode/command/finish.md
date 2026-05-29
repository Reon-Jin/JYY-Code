---
description: "Send a work summary email to reon_jin@outlook.com"
---

Review the current workspace and send a concise work summary email to reon_jin@outlook.com.

Include:
- What changed or what work was completed
- Current git status and notable changed files
- Tests or checks that were run, if visible in this session
- Any remaining risks or next steps
- Extra notes from the user: $ARGUMENTS

Use the send_message tool with:
- channel: email
- to: reon_jin@outlook.com
- subject: JYYCode finish: work summary

Keep the email body clear and practical. If the workspace has no git metadata, say that status/diff could not be collected and still send the report.
