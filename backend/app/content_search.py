import re
import unicodedata

from fastapi import HTTPException


def query_terms(query):
    words = set(re.findall(r"\w+", unicodedata.normalize("NFKC", query).casefold()))
    terms = {w for w in words if len(w) > 1}
    for word in words:
        if not re.fullmatch(r"[가-힣]+", word):
            continue
        for ending in (
            "으로부터",
            "에서의",
            "으로",
            "에서",
            "에게",
            "에는",
            "은",
            "는",
            "을",
            "를",
            "이",
            "가",
            "와",
            "과",
            "의",
            "에",
            "로",
        ):
            if word.endswith(ending) and len(word) - len(ending) >= 2:
                terms.add(word[: -len(ending)])
                break
    return terms


def select_contents(query, contents, selected_ids, limit=5):
    by_id = {c["id"]: c for c in contents}
    if selected_ids:
        if any(k not in by_id for k in selected_ids):
            raise HTTPException(404, "선택한 원고를 찾을 수 없습니다.")
        return [by_id[k] for k in dict.fromkeys(selected_ids)][:limit]

    def normalize(s):
        return unicodedata.normalize("NFKC", s).casefold()

    words = query_terms(query)

    def score(c):
        return sum(
            5 * (w in normalize(c["title"]))
            + 3 * (w in normalize(" ".join(c["tags"])))
            + (w in normalize(c["text"]))
            for w in words
            if len(w) > 1
        )

    return sorted([c for c in contents if score(c) > 0], key=lambda c: (-score(c), c["id"]))[:limit]
