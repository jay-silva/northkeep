# NorthKeep for Cursor

NorthKeep is a local-first memory vault. This plugin connects Cursor to the hosted connector, which serves only the scopes you have marked Shared.

The connector address is `https://mcp.northkeep.ai/mcp`. Cursor signs in with OAuth. NorthKeep shows a one-time pairing code in **Connect**, then **Cloud**. There is no API key to paste into this folder.

The previous address, `https://northkeep-connector-server.vercel.app/mcp`, keeps working for connections that already use it.

## What the tools do

Read-only: `memory_retrieve`, `memory_list`, `search`, `fetch`, `project_list`, `project_get`.

Writes that do not delete: `memory_remember`, `project_create`, `project_update`.

Destructive: `memory_forget`.

Setup, sharing, and how to revoke access are at [northkeep.ai/docs](https://northkeep.ai/docs). Security notes are at [northkeep.ai/security](https://northkeep.ai/security). Questions: support@northkeep.ai.

## This folder

The plugin lives at `integrations/cursor-plugin/` so it can move into its own repository later. A Cursor Marketplace submission expects `.cursor-plugin/plugin.json` at the root of the repository you submit. To publish, use this directory as that repository root. Do not submit the NorthKeep application repository itself unless the listing is pointed at this directory.

Nothing in this directory is a secret. Do not add tokens here.
