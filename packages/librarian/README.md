# @northkeep/librarian

Local-model work on memories through a loopback Ollama: extraction of memory
candidates from imported conversations (with a heuristic fallback), dedupe,
import orchestration, cached embeddings for search by meaning, and the
review and consolidation passes, where the model gets bounded data packs,
no tools and no vault writes.
