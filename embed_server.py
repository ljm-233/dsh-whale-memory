#!/usr/bin/env python3
"""本地嵌入 HTTP 服务：BGE-small-zh-v1.5 (int8 ONNX)。

常驻进程，模型只加载一次。监听 127.0.0.1:8377。

  POST /embed  {"texts": ["..."]}
    → {"vectors": [[...]], "dims": 512}
  GET  /health → {"ok": true, "dims": 512}

零外部依赖（除 pylibs 里的 onnxruntime/numpy）。
"""
import json
import os
import sys
import threading
import unicodedata
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

MODEL_DIR = "/usr/share/miyu/models/bge-small-zh-v1.5-int8"
MAX_LEN = 512
PORT = int(os.environ.get("EMBED_PORT", "8377"))

_lock = threading.Lock()
_sess = None
_vocab = None
_norm = None


def load():
    global _sess, _vocab, _norm
    import onnxruntime as ort

    with open(os.path.join(MODEL_DIR, "tokenizer.json"), encoding="utf-8") as f:
        tok = json.load(f)
    _vocab = tok["model"]["vocab"]
    _norm = tok.get("normalizer") or {}

    opts = ort.SessionOptions()
    opts.log_severity_level = 3          # 只报 error，屏蔽 telemetry 噪声
    _sess = ort.InferenceSession(
        os.path.join(MODEL_DIR, "model.onnx"),
        sess_options=opts,
        providers=["CPUExecutionProvider"],
    )


def bert_normalize(text, cfg):
    s = unicodedata.normalize("NFD", text)
    if cfg.get("strip_accents"):
        s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = unicodedata.normalize("NFC", s)
    if cfg.get("lower_case", cfg.get("do_lower_case", True)):
        s = s.lower()
    s = "".join(c for c in s if not unicodedata.category(c).startswith("C"))
    return "".join(" " if c.isspace() else c for c in s).strip()


def wordpiece(token, vocab):
    if token in vocab:
        return [token]
    chars = list(token)
    out = []
    start = 0
    while start < len(chars):
        end = len(chars)
        cur = None
        while start < end:
            sub = "".join(chars[start:end])
            if start > 0:
                sub = "##" + sub
            if sub in vocab:
                cur = sub
                break
            end -= 1
        if cur is None:
            return ["[UNK]"]
        out.append(cur)
        start = end
    return out


def encode(text):
    s = bert_normalize(text, _norm)
    pieces = []
    for w in s.split():
        buf = []
        for ch in w:
            cp = ord(ch)
            is_cjk = 0x4E00 <= cp <= 0x9FFF or 0x3400 <= cp <= 0x4DBF
            is_punct = unicodedata.category(ch).startswith(("P", "S"))
            if is_cjk or is_punct:
                if buf:
                    pieces.append("".join(buf))
                    buf = []
                pieces.append(ch)
            else:
                buf.append(ch)
        if buf:
            pieces.append("".join(buf))

    tokens = []
    for piece in pieces:
        tokens.extend(wordpiece(piece, _vocab))

    ids = [_vocab.get("[CLS]", 101)]
    ids += [_vocab.get(t, _vocab.get("[UNK]", 100)) for t in tokens]
    ids.append(_vocab.get("[SEP]", 102))
    ids = ids[:MAX_LEN]
    mask = [1] * len(ids)
    types = [0] * len(ids)
    pad = MAX_LEN - len(ids)
    if pad > 0:
        ids += [0] * pad
        mask += [0] * pad
        types += [0] * pad
    return ids, mask, types


def embed(texts):
    import numpy as np

    out_vectors = []
    for text in texts:
        ids, mask, types = encode(text)
        feeds = {
            "input_ids": np.array([ids], dtype=np.int64),
            "attention_mask": np.array([mask], dtype=np.int64),
            "token_type_ids": np.array([types], dtype=np.int64),
        }
        raw = _sess.run(None, feeds)[0]
        vec = raw[0, 0, :]                    # CLS pooling
        n = np.linalg.norm(vec)
        if n > 0:
            vec = vec / n                     # L2 normalize
        out_vectors.append([round(float(x), 6) for x in vec])
    return out_vectors


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass                                   # 静默

    def _send(self, code, payload):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._send(200, {"ok": True, "dims": 512, "model": "bge-small-zh-v1.5-int8"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/embed":
            self._send(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("content-length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")
            texts = req.get("texts") or []
            if not texts:
                self._send(400, {"error": "no texts"})
                return
            with _lock:
                vectors = embed(texts)
            self._send(200, {"vectors": vectors, "dims": len(vectors[0])})
        except Exception as e:
            self._send(500, {"error": str(e)})


def main():
    load()
    print(f"embed service ready on 127.0.0.1:{PORT}", flush=True)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
