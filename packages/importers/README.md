# @northkeep/importers

Parsers that turn outside history into import input: a ChatGPT export
(`parseChatgptExport`), a Claude export (`parseClaudeExport`), and the reply
to the paste prompt (`PASTE_PROMPT`, `parsePasteFile`). Parsing only; no
network and no vault writes. Used by @northkeep/librarian, the CLI and the
web app.
