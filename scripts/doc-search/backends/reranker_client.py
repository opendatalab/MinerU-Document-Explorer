# qwen3_vl_reranker_client.py
import logging
import requests
from typing import Dict, Any, List, Optional

from doc_search.pdf_utils import local_image_to_data_url

logger = logging.getLogger(__name__)


class Qwen3VLReranker:
    def __init__(self, model_name_or_path: str, **kwargs):
        """
        Initialize the Reranker Client (Remote Mode).
        """
        self.api_url = model_name_or_path
        if not self.api_url.endswith("/rerank"):
             self.api_url = self.api_url + "/rerank"

    def process(self, inputs: Dict[str, Any], timeout: float = None) -> List[float]:
        """
        Send inputs to the remote vLLM service and retrieve relevance scores.

        Args:
            inputs: Dictionary containing 'instruction', 'query', and 'documents'.
            timeout: HTTP request timeout in seconds. None means no timeout.

        Returns:
            List[float]: A list of relevance scores corresponding to the documents.
        """
        try:
            response = requests.post(self.api_url, json=inputs, timeout=timeout)
            response.raise_for_status()

            result = response.json()
            scores = result.get("scores", [])
            return scores

        except requests.exceptions.Timeout:
            from doc_search.models import OperationTimeoutError
            raise OperationTimeoutError(
                operation="reranker",
                reason="Reranker service request timed out",
                timeout=timeout,
            )
        except requests.exceptions.RequestException as e:
            logger.error("Error calling remote service: %s", e)
            if hasattr(e, 'response') and e.response:
                logger.error("Server Response: %s", e.response.text)
            raise e


# ---------------------------------------------------------------------------
# Adapter + factory
# ---------------------------------------------------------------------------

class Qwen3VLRerankerAdapter:
    """Adapts ``Qwen3VLReranker`` to the :class:`Reranker` protocol."""

    def __init__(self, api_base: str):
        self._api_base = api_base
        self._impl = None

    def _get_impl(self):
        if self._impl is None:
            self._impl = Qwen3VLReranker(model_name_or_path=self._api_base)
        return self._impl

    def rerank(self, query: str, image_paths: List[str],
               timeout: float = None) -> List[float]:
        inputs = {
            "instruction": (
                "Given a search query, retrieve relevant candidates "
                "that answer the query."
            ),
            "query": {"text": query},
            "documents": [
                {"image": local_image_to_data_url(p, max_long_edge=1280)}
                for p in image_paths
            ],
            "fps": 1.0,
        }
        return self._get_impl().process(inputs, timeout=timeout)


def create_reranker(config) -> Optional["Qwen3VLRerankerAdapter"]:
    """Factory: build a :class:`Qwen3VLRerankerAdapter` from *config*, or ``None``."""
    base = config.reranker_api_base
    if not base:
        return None
    return Qwen3VLRerankerAdapter(base)
