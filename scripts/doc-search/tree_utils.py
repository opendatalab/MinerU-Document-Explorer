"""Tree utilities: outline resolution, navigation, and index conversion."""

import logging
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

__all__ = [
    "resolve_outline",
    "find_node",
    "prune_tree",
    "convert_indices_to_0based",
]


# ---------------------------------------------------------------------------
# Internal helpers (used by extract_native_outline in pdf_utils)
# ---------------------------------------------------------------------------

def _toc_to_tree(toc: list, num_pages: int) -> list:
    """Convert PyMuPDF flat TOC [[level, title, page_num], ...] to nested tree.

    Output nodes have:
      - title: str
      - start_page: int (0-indexed)
      - end_page: int (0-indexed)
      - node_id: str (auto-generated, "0001" style)
      - nodes: list (children)
    """
    if not toc:
        return []

    # Build flat node list
    flat_nodes = []
    for level, title, page_num in toc:
        flat_nodes.append({
            "level": level,
            "title": title,
            "start_page": max(0, page_num - 1),  # 0-indexed
            "nodes": [],
        })

    # Stack-based nesting: stack entries are (level, node_dict)
    root: list = []
    stack: list = [(0, {"nodes": root})]  # sentinel root

    for node in flat_nodes:
        level = node.pop("level")
        # Pop stack until parent level is found
        while len(stack) > 1 and stack[-1][0] >= level:
            stack.pop()
        stack[-1][1]["nodes"].append(node)
        stack.append((level, node))

    # Compute end_page for each node and assign node_ids
    _assign_end_pages(root, num_pages - 1)
    _assign_node_ids(root)

    return root


def _assign_end_pages(nodes: list, doc_last_page: int) -> None:
    """Recursively assign end_page to each node.

    end_page = next sibling's start_page - 1 (or parent's end_page for last child).
    """
    for i, node in enumerate(nodes):
        # Default end_page: next sibling start - 1, or doc_last_page
        if i + 1 < len(nodes):
            node["end_page"] = max(node["start_page"], nodes[i + 1]["start_page"] - 1)
        else:
            node["end_page"] = doc_last_page

        # Recurse into children with this node's end_page as boundary
        if node.get("nodes"):
            _assign_end_pages(node["nodes"], node["end_page"])


def _assign_node_ids(nodes: list, counter: list = None) -> None:
    """Assign sequential node_id strings like '0001', '0002', ..."""
    if counter is None:
        counter = [0]
    for node in nodes:
        node["node_id"] = f"{counter[0]:04d}"
        counter[0] += 1
        if node.get("nodes"):
            _assign_node_ids(node["nodes"], counter)


# ---------------------------------------------------------------------------
# Public tree operations
# ---------------------------------------------------------------------------

def resolve_outline(
    tree_index: Optional[Dict],
    native_outline: Optional[List],
    doc_id: str,
    doc_name: str,
    num_pages: int,
    max_depth: int = 2,
    root_node: str = "",
) -> Dict:
    """Resolve the best available document outline with fallback and pruning.

    Shared by both the core layer and the client layer to avoid logic
    duplication.  Chooses tree_index > native_outline > none, applies
    subtree selection via *root_node*, and prunes to *max_depth*.

    Returns a dict with keys: doc_id, doc_name, num_pages, outline,
    outline_source, warnings.
    """
    warnings: List[str] = []
    source = "pageindex"

    if tree_index is not None:
        structure = tree_index.get("structure", [])
    elif native_outline is not None and len(native_outline) > 0:
        structure = native_outline
        source = "native_pdf_bookmarks"
        warnings.append(
            "PageIndex outline is unavailable; showing native PDF bookmarks instead. "
            "Native bookmarks may be coarse-grained and lack summaries."
        )
    else:
        return {
            "doc_id": doc_id,
            "doc_name": doc_name,
            "num_pages": num_pages,
            "outline": [],
            "outline_source": "none",
            "warnings": [
                "No outline available. Neither PageIndex nor native PDF bookmarks exist. "
                "Use search_semantic or search_keyword to locate content."
            ],
        }

    # Find subtree if root_node is specified
    if root_node:
        subtree = find_node(structure, root_node)
        if subtree is None:
            raise ValueError(f"node_id '{root_node}' not found in outline")
        structure = [subtree]

    # Prune to max_depth
    pruned = prune_tree(structure, max_depth)

    return {
        "doc_id": doc_id,
        "doc_name": doc_name,
        "num_pages": num_pages,
        "outline": pruned,
        "outline_source": source,
        "warnings": warnings,
    }


def find_node(nodes: list, target_id: str) -> Optional[Dict]:
    """Recursively find a node by node_id."""
    for node in nodes:
        if node.get("node_id") == target_id:
            return node
        children = node.get("nodes", [])
        result = find_node(children, target_id)
        if result is not None:
            return result
    return None


def prune_tree(nodes: list, max_depth: int, current_depth: int = 1) -> list:
    """Return a copy of the tree pruned to max_depth levels."""
    if not nodes:
        return []

    result = []
    for node in nodes:
        pruned_node = {k: v for k, v in node.items() if k != "nodes"}
        children = node.get("nodes", [])

        if current_depth < max_depth and children:
            pruned_node["children"] = prune_tree(children, max_depth, current_depth + 1)
        elif children:
            pruned_node["has_children"] = True

        result.append(pruned_node)
    return result


def convert_indices_to_0based(nodes: list) -> None:
    """Recursively convert start_index/end_index from 1-indexed to 0-indexed (in place)."""
    for node in nodes:
        if "start_index" in node:
            node["start_page"] = node.pop("start_index") - 1
        if "end_index" in node:
            node["end_page"] = node.pop("end_index") - 1
        if "nodes" in node:
            convert_indices_to_0based(node["nodes"])
