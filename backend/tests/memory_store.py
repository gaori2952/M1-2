"""Test-only atomic store; never imported by the deployed app."""

from copy import deepcopy
from threading import RLock


class MemoryStore:
    def __init__(self):
        self.docs = {}
        self.lock = RLock()

    def get(self, collection, key):
        return deepcopy(self.docs.get((collection, key)))

    def list(self, collection, uid):
        return [
            deepcopy(v)
            for (c, _), v in self.docs.items()
            if c == collection and v.get("owner_uid") == uid
        ]

    def set(self, collection, key, value):
        self.docs[(collection, key)] = deepcopy(value)

    def delete(self, collection, key):
        self.docs.pop((collection, key), None)

    def atomic(self, fn):
        with self.lock:
            old = deepcopy(self.docs)
            try:
                return fn(self)
            except Exception:
                self.docs = old
                raise
