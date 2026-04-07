# qwen3_vl_embedding_client.py
import logging
import requests
from typing import Dict, Any, List, Optional

logger = logging.getLogger(__name__)


class Qwen3VLEmbeddingClient:
    """HTTP client for the Qwen3VL embedding service (remote mode)."""

    def __init__(self, api_base: str):
        self.api_url = api_base.rstrip("/") + "/embed"

    def embed(self, inputs: List[Dict[str, Any]]) -> List[List[float]]:
        """Embed a batch of inputs (text or image).

        Args:
            inputs: List of dicts, each with optional keys 'text', 'image',
                    'instruction'. Example: [{"image": "/path/to/img.png"}]

        Returns:
            List of embedding vectors (list of floats).
        """
        try:
            response = requests.post(self.api_url, json={"inputs": inputs})
            response.raise_for_status()
            result = response.json()
            return result.get("embeddings", [])
        except requests.exceptions.RequestException as e:
            logger.error("Error calling embedding service: %s", e)
            if hasattr(e, "response") and e.response:
                logger.error("Server Response: %s", e.response.text)
            raise e

    def embed_single(self, input_dict: Dict[str, Any]) -> List[float]:
        """Convenience method to embed a single input.

        Returns:
            A single embedding vector.
        """
        embeddings = self.embed([input_dict])
        if not embeddings:
            raise RuntimeError("Embedding service returned empty result")
        return embeddings[0]


# ---------------------------------------------------------------------------
# Adapter + factory
# ---------------------------------------------------------------------------

class Qwen3VLEmbedderAdapter:
    """Adapts ``Qwen3VLEmbeddingClient`` to the :class:`Embedder` protocol."""

    def __init__(self, api_base: str):
        self._api_base = api_base
        self._impl = None

    def _get_impl(self):
        if self._impl is None:
            self._impl = Qwen3VLEmbeddingClient(api_base=self._api_base)
        return self._impl

    def embed_pages(self, image_paths: List[str]) -> List[List[float]]:
        inputs = [{"image": p} for p in image_paths]
        return self._get_impl().embed(inputs)

    def embed_query(self, query: str) -> List[float]:
        return self._get_impl().embed_single({
            "text": query,
            "instruction": (
                "Given a search query, retrieve relevant candidates "
                "that answer the query."
            ),
        })


def create_embedder(config) -> Optional["Qwen3VLEmbedderAdapter"]:
    """Factory: build a :class:`Qwen3VLEmbedderAdapter` from *config*, or ``None``."""
    base = config.embedding_api_base
    if not base:
        return None
    return Qwen3VLEmbedderAdapter(base)
