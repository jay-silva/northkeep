# @northkeep/mcp-server

The local MCP server (`northkeep-mcp`) that AI apps connect to over stdio. It
serves the memory tools (`memory_retrieve`, `memory_remember`, `memory_list`,
`memory_edit`, `memory_forget`) and the project tools (`project_list`,
`project_get`, `project_create`, `project_update`, `project_resume`,
`project_checkpoint`, `project_wrap`, `project_board`), can mask what it returns
at a chosen redaction tier (`NORTHKEEP_REDACT_TIER`; none when unset), and keeps
a content-free call log.
It also holds master-key storage (keychain or key file) and background sync.
