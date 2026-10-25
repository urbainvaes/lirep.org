"""Bounded validation shared by study writes and legacy-row reads."""

import chess

MAX_TREE_NODES = 10_000
MAX_TREE_DEPTH = 256
MAX_NODE_ID = 2**53 - 1  # IDs also travel through JavaScript.


class InvalidTree(ValueError):
    pass


def validate_tree(tree: dict, side: str | None = None) -> None:
    """Check every shape before references, then walk all nodes from the root.

    With a side, also replay legal moves and enforce one prepared-side move.
    Without it, perform structural checks only (e.g. before fingerprinting).
    """
    def bad(reason: str) -> None:
        raise InvalidTree(f"invalid tree: {reason}")

    def node_id(value: object) -> bool:
        return type(value) is int and 0 <= value <= MAX_NODE_ID

    if not isinstance(tree, dict):
        bad("must be an object")
    nodes = tree.get("nodes")
    root = tree.get("rootId")
    next_id = tree.get("nextId")
    if not isinstance(nodes, dict) or not 1 <= len(nodes) <= MAX_TREE_NODES:
        bad(f"nodes must contain 1 to {MAX_TREE_NODES} entries")
    if not node_id(root) or str(root) not in nodes:
        bad("rootId must identify a node")
    if not node_id(next_id):
        bad("nextId must be a nonnegative safe integer")
    max_id = -1
    edges = 0
    child_sets: dict[str, set[int]] = {}
    for key, node in nodes.items():
        if not isinstance(node, dict):
            bad(f"node {key} is not an object")
        if not {"id", "parentId", "san", "children"}.issubset(node):
            bad(f"node {key} is missing required fields")
        ident = node.get("id")
        if not node_id(ident) or str(ident) != key:
            bad(f"node {key} has a mismatched or missing id")
        max_id = max(max_id, ident)
        parent = node.get("parentId")
        if (ident == root) != (parent is None) or (parent is not None and not node_id(parent)):
            bad(f"node {key} has an invalid parentId")
        san = node.get("san")
        if ident == root:
            if san is not None:
                bad("root san must be null")
        elif not isinstance(san, str) or not 1 <= len(san) <= 64:
            bad(f"node {key} must have a SAN move")
        children = node.get("children")
        if not isinstance(children, list) or len(children) > MAX_TREE_NODES or any(not node_id(c) for c in children):
            bad(f"node {key} has a malformed children list")
        child_sets[key] = set(children)
        if len(child_sets[key]) != len(children):
            bad(f"node {key} has duplicate children")
        edges += len(children)
    if next_id <= max_id:
        bad("nextId must be greater than every existing node id")
    if edges != len(nodes) - 1:
        bad("a tree must have exactly one edge per non-root node")

    # All values are known to have the right shape before dereferencing them.
    for key, node in nodes.items():
        parent = node["parentId"]
        if parent is not None and (str(parent) not in nodes or node["id"] not in child_sets[str(parent)]):
            bad(f"node {key} is missing from its parent's children")
        for child in node["children"]:
            if str(child) not in nodes or nodes[str(child)]["parentId"] != node["id"]:
                bad(f"node {key} has an unknown or inconsistent child")

    if side is not None and side not in ("white", "black"):
        bad("unknown study side")
    visited: set[int] = set()
    stack = [(root, 0, chess.Board() if side is not None else None)]
    while stack:
        ident, depth, board = stack.pop()
        if ident in visited:
            bad("cycle or repeated node")
        if depth > MAX_TREE_DEPTH:
            bad(f"depth exceeds {MAX_TREE_DEPTH} plies")
        visited.add(ident)
        children = nodes[str(ident)]["children"]
        if board is not None and (board.turn == chess.WHITE) == (side == "white") and len(children) > 1:
            bad(f"node {ident} has more than one prepared-side move")
        for child in children:
            after = None
            if board is not None:
                after = board.copy(stack=False)
                try:
                    after.push_san(nodes[str(child)]["san"])
                except ValueError:
                    bad(f"node {child} has an illegal SAN move")
                # python-chess also accepts the non-chess null move as SAN.
                if after.peek() == chess.Move.null():
                    bad(f"node {child} has a null move")
            stack.append((child, depth + 1, after))
    if len(visited) != len(nodes):
        bad("unreachable nodes or disconnected cycle")
