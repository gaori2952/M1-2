"""Firestore adapter. Writes are delayed until all transaction reads finish."""

import json
import time
from copy import deepcopy
from functools import cached_property
from threading import RLock
from uuid import uuid4

from fastapi import HTTPException
from firebase_admin import auth, credentials, firestore, initialize_app
from google.cloud.firestore_v1.base_query import FieldFilter


class Firebase:
    def __init__(self, settings):
        self.settings = settings

    @cached_property
    def app(self):
        if not self.settings.firebase_service_account_json:
            raise HTTPException(503, "Firebase 서버 설정이 필요합니다.")
        cert = credentials.Certificate(json.loads(self.settings.firebase_service_account_json))
        return initialize_app(cert, name="content-" + uuid4().hex)

    def verify(self, token):
        return auth.verify_id_token(token, app=self.app, check_revoked=True)

    @cached_property
    def db(self):
        return firestore.client(app=self.app)


class FirestoreUnit:
    def __init__(self, db, transaction=None):
        self.db = db
        self.transaction = transaction
        self.writes = []

    def get(self, collection, key):
        snap = (
            self.db.collection(collection)
            .document(key)
            .get(transaction=self.transaction, retry=None, timeout=15)
        )
        return snap.to_dict() if snap.exists else None

    def list(self, collection, uid):
        # shortcut: owner-scoped scans suit a personal library; add indexed pagination before 10k documents.
        query = (
            self.db.collection(collection)
            .where(filter=FieldFilter("owner_uid", "==", uid))
            .limit(10001)
        )
        docs = [
            s.to_dict() for s in query.stream(transaction=self.transaction, retry=None, timeout=15)
        ]
        if len(docs) > 10000:
            raise HTTPException(
                413,
                "자료가 10,000개를 초과합니다. 기간별 저장소 쿼리 확장이 필요합니다.",
            )
        return docs

    def set(self, collection, key, value):
        ref = self.db.collection(collection).document(key)
        if self.transaction is None:
            ref.set(value)
        else:
            self.writes.append(("set", ref, value))

    def delete(self, collection, key):
        ref = self.db.collection(collection).document(key)
        if self.transaction is None:
            ref.delete()
        else:
            self.writes.append(("delete", ref, None))


class FirestoreStore:
    def __init__(self, firebase):
        self.firebase = firebase
        self._cache = {}
        self._lock = RLock()

    def _read(self, kind, args):
        # Owner/path-scoped copies avoid repeated scans and shared mutation between services.
        key = (kind, *args)
        with self._lock:
            cached = self._cache.get(key)
            if cached and cached[0] > time.monotonic():
                return deepcopy(cached[1])
            value = getattr(FirestoreUnit(self.firebase.db), kind)(*args)
            if len(self._cache) >= 128:
                self._cache.clear()
            ttl = 900 if args[0] == "data" else 60
            self._cache[key] = (time.monotonic() + ttl, deepcopy(value))
            return value

    def get(self, *args):
        return self._read("get", args)

    def list(self, *args):
        return self._read("list", args)

    def atomic(self, fn):
        @firestore.transactional
        def run(transaction):
            unit = FirestoreUnit(self.firebase.db, transaction)
            result = fn(unit)
            for op, ref, value in unit.writes:
                if op == "set":
                    transaction.set(ref, value)
                else:
                    transaction.delete(ref)
            return result

        with self._lock:
            self._cache.clear()
            try:
                return run(self.firebase.db.transaction())
            finally:
                self._cache.clear()
