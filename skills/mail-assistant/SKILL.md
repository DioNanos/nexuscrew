---
name: mail-assistant
description: Use for mailbox discovery, email search and reading, priority triage, attachment review, folder organisation, reply drafting, explicit sending, or recurring mail checks through an available Gmail or IMAP/SMTP MCP connector. Select the user-facing language from the request and the draft language from the thread, while preserving read-before-write discipline and explicit confirmation for consequential mail actions.
---

# Mail Assistant

Use the mail tools already exposed by the current client. Discover folders,
sender identities and supported operations live; never assume provider-specific
folder names or account configuration.

## Select languages

Choose the language for digests, questions and explanations in this order:

1. the user's explicit language preference;
2. the language of the current request;
3. a reliable client or system locale;
4. English.

Write a reply draft in the language of the email thread unless the user asks
for another language. Preserve names, quoted text and required legal or
technical terms; do not translate them merely to match the interface language.

## Choose tools

1. Prefer an exposed Gmail connector for Gmail-hosted workflows.
2. Otherwise use an exposed IMAP/SMTP mail MCP such as `mcp-email-rs`.
3. Search narrowly before listing large folders, and fetch complete message
   bodies only when needed for classification, attachments or drafting.
4. If no mail tool is available, explain the missing capability. When this
   skill is packaged with NexusCrew, the optional companion is documented in
   `../../MCP_COMPANIONS.md`. Do not install or configure it without consent.

## Apply the safety boundary

- Reading and searching are allowed when the user asks to inspect mail.
- Treat moves, flags, drafts, folder changes and calendar/reminder creation as
  explicit mutations; perform only the mutation the user requested.
- Treat deletion and sending as consequential external actions. Confirm the
  exact targets and intended content immediately before acting unless the
  user's current request already gives unambiguous final authorization.
- Prefer recoverable archive or Trash moves over permanent deletion.
- Re-fetch message identifiers after moves; IMAP UIDs are folder-scoped and
  can change.
- Never expose credentials, authentication links or sensitive message content
  in logs, push notifications, TTS or unrelated summaries.
- Never infer an authorised sender identity. Use identities returned by the
  connector or explicitly supplied by the user.

## Triage and draft

1. Fetch the smallest useful set of messages.
2. Classify each item as urgent/action required, reply soon, waiting, or
   informational, using the user's own priorities when available.
3. Read attachments only when necessary and identify their type before
   downloading.
4. Present a compact digest with evidence from the messages and a proposed
   next action.
5. Draft only when requested. Preserve the user's tone, distinguish facts from
   assumptions and leave unresolved details visible.
6. Before sending, show or re-confirm recipients, subject, body and attachments.
7. Report only actions that the tool actually completed.

## Recurring checks

Create recurring monitoring only when explicitly requested. Use the
client-native scheduler or loop mechanism instead of manual polling, avoid
duplicate jobs, respect quiet hours, and remain silent on unchanged ticks when
the host workflow supports silent monitoring. A recurring authorization does
not automatically authorize sending or permanent deletion.
