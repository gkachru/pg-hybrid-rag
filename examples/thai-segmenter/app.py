"""Thai word-segmentation sidecar for pg-hybrid-rag.

Tokenizes Thai with attacut (a neural tokenizer) via the maintained PyThaiNLP, and returns
space-joined tokens. Space-insertion only: the original non-whitespace characters are preserved
in order (no normalization — that is the library's Normalizer's job, which runs first).

SECURITY: this service is UNAUTHENTICATED and does not bound request size — it runs CPU-bound
inference per text with no payload limit or concurrency cap. It is meant to run on a private
network (e.g. the compose network) reachable only by your app, NOT exposed publicly. Before any
public exposure add auth, request-size/array-length limits, and a concurrency/timeout guard.
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from pydantic import BaseModel
from pythainlp.tokenize import word_tokenize


def segment_text(text: str) -> str:
    tokens = word_tokenize(text, engine="attacut")
    return " ".join(token for token in tokens if token.strip())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    # attacut loads its model lazily on first call. Warm it up during startup so /health only
    # becomes reachable once the model is ready — this gates the compose healthcheck.
    segment_text("สวัสดีครับ")
    yield


app = FastAPI(lifespan=lifespan)


class SegmentRequest(BaseModel):
    texts: list[str]


class SegmentResponse(BaseModel):
    segmented: list[str]


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/segment", response_model=SegmentResponse)
def segment(request: SegmentRequest) -> SegmentResponse:
    return SegmentResponse(segmented=[segment_text(t) for t in request.texts])
