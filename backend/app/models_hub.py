"""Model download + status management.

The app ships without the ~4GB of ModelScope weights it needs, so first run has
to fetch them. This module owns that: what the app needs, what is on disk, how
complete it is, and a background download with byte-level progress the settings
page can poll.

Completeness is checked against the remote file listing, not against "does the
directory exist". A half-downloaded model looks exactly like a finished one on
the filesystem — that trap once left punc's model.pt at 38MB of 1073MB and
silently wrecked punctuation on every transcript.
"""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

# Set by the app at import time so this module stays free of app-wide config.
#
# Two directories, not one. A packaged .app may carry models inside its bundle,
# which is read-only — downloads must never target it, and "delete" must never
# rmtree into it. Anything fetched at runtime goes to the per-user data dir, and
# that copy wins when both exist.
_read_dir: Path | None = None
_write_dir: Path | None = None


def configure(read_dir: Path, write_dir: Path) -> None:
    global _read_dir, _write_dir
    _read_dir = Path(read_dir)
    _write_dir = Path(write_dir)


def download_dir() -> Path:
    if _write_dir is None:
        raise RuntimeError("models_hub.configure() was never called")
    return _write_dir


def resolve_model_path(dir_name: str) -> Path:
    """Where this model actually lives: the downloaded copy if present, else the
    bundled one. Returns the download location when neither exists yet."""
    downloaded = download_dir() / dir_name
    if downloaded.is_dir() and any(downloaded.iterdir()):
        return downloaded
    if _read_dir is not None:
        bundled = _read_dir / dir_name
        if bundled.is_dir() and any(bundled.iterdir()):
            return bundled
    return downloaded


def model_path(key: str) -> Path:
    spec = SPEC_BY_KEY.get(key)
    if spec is None:
        raise KeyError(key)
    return resolve_model_path(spec.dir_name)


def is_bundled(path: Path) -> bool:
    return _read_dir is not None and _write_dir is not None and _read_dir != _write_dir and path.is_relative_to(_read_dir)


@dataclass(frozen=True)
class ModelSpec:
    key: str
    dir_name: str
    label: str
    purpose: str
    required: bool

    @property
    def model_id(self) -> str:
        return f"iic/{self.dir_name}"


# Order matters: this is the order the settings page lists them and the order a
# "download everything" run fetches them — cheap and required first, so the app
# becomes usable as early as possible.
MODEL_SPECS: tuple[ModelSpec, ...] = (
    ModelSpec("vad", "speech_fsmn_vad_zh-cn-16k-common-pytorch", "语音端点检测 (FSMN-VAD)", "把长录音切成句子", True),
    ModelSpec("voiceprint", "speech_campplus_sv_zh-cn_16k-common", "声纹 (CAM++)", "说话人分离与声纹匹配", True),
    ModelSpec("asr", "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch", "转写 (SeACo-Paraformer)", "中文语音转文字，支持热词", True),
    ModelSpec("punc", "punc_ct-transformer_cn-en-common-vocab471067-large", "标点 (CT-Transformer)", "给转写结果加标点", True),
    ModelSpec("emotion", "emotion2vec_plus_large", "声学情绪 (emotion2vec+)", "逐句情绪标注（可选，不下也能转写）", False),
)

SPEC_BY_KEY = {spec.key: spec for spec in MODEL_SPECS}


class DownloadCancelled(BaseException):
    """Raised out of the progress callback to unwind modelscope's download.

    Deliberately a BaseException: modelscope's per-file loop is wrapped in
    `except Exception: ...retry`, so an ordinary exception would be swallowed
    and the transfer would just restart with backoff instead of stopping.
    """


@dataclass
class DownloadJob:
    key: str
    # queued → running once it wins the single-download lock. Showing four
    # models as "downloading" when three are waiting their turn is a lie.
    status: str = "queued"  # queued | running | done | failed | cancelled
    downloaded_bytes: int = 0
    total_bytes: int = 0
    current_file: str = ""
    error: str = ""
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    cancel_requested: bool = False

    def payload(self) -> dict[str, Any]:
        # `downloaded_bytes` counts only what this run transferred, which is the
        # right basis for speed but not for progress: a resumed job skips files
        # it already has. Completion is measured off the disk instead, in
        # model_status(), where the manifest total is known.
        elapsed = (self.finished_at or time.time()) - self.started_at
        return {
            "status": self.status,
            "transferred_bytes": self.downloaded_bytes,
            "current_file": self.current_file,
            "speed_bps": int(self.downloaded_bytes / elapsed) if elapsed > 0.5 else 0,
            "error": self.error,
        }


_jobs: dict[str, DownloadJob] = {}
_jobs_lock = threading.Lock()
_queue_lock = threading.Lock()  # one download at a time; parallel just fights for bandwidth

_manifest_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_MANIFEST_TTL = 3600.0


def remote_manifest(spec: ModelSpec, refresh: bool = False) -> list[dict[str, Any]] | None:
    """Files and sizes for a model, or None when the hub is unreachable."""
    cached = _manifest_cache.get(spec.key)
    if cached and not refresh and time.time() - cached[0] < _MANIFEST_TTL:
        return cached[1]
    try:
        from modelscope.hub.api import HubApi

        entries = HubApi().get_model_files(model_id=spec.model_id, recursive=True)
    except Exception:
        return cached[1] if cached else None
    blobs = [
        {"path": item["Path"], "size": int(item.get("Size") or 0)}
        for item in entries
        if item.get("Type") != "tree"
    ]
    _manifest_cache[spec.key] = (time.time(), blobs)
    return blobs


def _local_bytes(path: Path) -> int:
    if not path.is_dir():
        return 0
    return sum(item.stat().st_size for item in path.rglob("*") if item.is_file())


def model_status(spec: ModelSpec, refresh: bool = False) -> dict[str, Any]:
    target = resolve_model_path(spec.dir_name)
    manifest = remote_manifest(spec, refresh=refresh)
    with _jobs_lock:
        job = _jobs.get(spec.key)
    local_total = _local_bytes(target)

    payload: dict[str, Any] = {
        "key": spec.key,
        "model_id": spec.model_id,
        "label": spec.label,
        "purpose": spec.purpose,
        "required": spec.required,
        "path": str(target),
        "bundled": is_bundled(target),
        "local_bytes": local_total,
        "total_bytes": sum(item["size"] for item in manifest) if manifest else 0,
        "verified": manifest is not None,
        "missing_files": [],
    }

    def with_progress(base: dict[str, Any]) -> dict[str, Any]:
        total = payload["total_bytes"]
        return {
            **base,
            "downloaded_bytes": local_total,
            "total_bytes": total,
            "percent": round(min(100.0, 100 * local_total / total), 1) if total else 0.0,
        }

    if job and job.status == "queued":
        payload["status"] = "queued"
        payload["progress"] = with_progress(job.payload())
        return payload
    if job and job.status == "running":
        payload["status"] = "downloading"
        payload["progress"] = with_progress(job.payload())
        return payload
    if job and job.status in {"failed", "cancelled"}:
        payload["progress"] = with_progress(job.payload())

    if not target.is_dir() or local_total == 0:
        payload["status"] = "missing"
        return payload

    if manifest is None:
        # Offline: trust what is on disk rather than blocking a working install.
        payload["status"] = "ready"
        return payload

    incomplete = []
    for item in manifest:
        local_file = target / item["path"]
        if not local_file.is_file():
            incomplete.append(item["path"])
        elif item["size"] and local_file.stat().st_size != item["size"]:
            incomplete.append(item["path"])
    payload["missing_files"] = incomplete[:20]
    payload["status"] = "ready" if not incomplete else "partial"
    return payload


def all_status(refresh: bool = False) -> dict[str, Any]:
    items = [model_status(spec, refresh=refresh) for spec in MODEL_SPECS]
    required = [item for item in items if item["required"]]
    return {
        "models": items,
        "ready": all(item["status"] == "ready" for item in required),
        "required_missing": [item["key"] for item in required if item["status"] != "ready"],
        "total_bytes": sum(item["total_bytes"] for item in items),
        "local_bytes": sum(item["local_bytes"] for item in items),
        # Drives the settings page's poll interval, so queued counts as active.
        "downloading": [item["key"] for item in items if item["status"] in {"downloading", "queued"}],
    }


def _progress_callback_class(job: DownloadJob) -> type:
    from modelscope.hub.callback import ProgressCallback

    class _JobCallback(ProgressCallback):  # constructed by modelscope, per file
        def __init__(self, filename: str, file_size: int) -> None:
            super().__init__(filename, file_size)
            job.current_file = filename

        def update(self, size: int) -> None:
            if job.cancel_requested:
                # modelscope has no cancel hook; unwinding from the callback is
                # the only way out. Partial files stay put and resume later.
                raise DownloadCancelled(job.key)
            job.downloaded_bytes += int(size)

        def end(self) -> None:
            job.current_file = ""

    return _JobCallback


def _run_download(spec: ModelSpec, job: DownloadJob) -> None:
    # Always the writable dir, never the bundle.
    target = download_dir() / spec.dir_name
    try:
        with _queue_lock:
            if job.cancel_requested:
                raise DownloadCancelled(job.key)
            job.status = "running"
            job.started_at = time.time()
            manifest = remote_manifest(spec, refresh=True)
            job.total_bytes = sum(item["size"] for item in manifest) if manifest else 0

            from modelscope.hub.snapshot_download import snapshot_download

            target.parent.mkdir(parents=True, exist_ok=True)
            snapshot_download(
                spec.model_id,
                local_dir=str(target),
                progress_callbacks=[_progress_callback_class(job)],
            )
        job.status = "done"
    except DownloadCancelled:
        job.status = "cancelled"
    except Exception as exc:
        job.status = "failed"
        job.error = f"{type(exc).__name__}: {exc}"
    finally:
        job.finished_at = time.time()


def start_download(key: str) -> dict[str, Any]:
    spec = SPEC_BY_KEY.get(key)
    if spec is None:
        raise KeyError(key)
    with _jobs_lock:
        existing = _jobs.get(key)
        if existing and existing.status in {"queued", "running"}:
            return existing.payload()
        job = DownloadJob(key=key)
        _jobs[key] = job
    threading.Thread(target=_run_download, args=(spec, job), name=f"model-dl-{key}", daemon=True).start()
    return job.payload()


def start_download_all(include_optional: bool = False) -> list[str]:
    """Queue every model that is not ready. They share one lock, so they run
    one after another in registry order rather than all at once."""
    started: list[str] = []
    for spec in MODEL_SPECS:
        if not spec.required and not include_optional:
            continue
        if model_status(spec)["status"] in {"ready", "downloading", "queued"}:
            continue
        start_download(spec.key)
        started.append(spec.key)
    return started


def cancel_download(key: str) -> bool:
    with _jobs_lock:
        job = _jobs.get(key)
        if not job or job.status not in {"queued", "running"}:
            return False
        job.cancel_requested = True
    return True


def delete_model(key: str) -> dict[str, Any]:
    import shutil

    spec = SPEC_BY_KEY.get(key)
    if spec is None:
        raise KeyError(key)
    target = resolve_model_path(spec.dir_name)
    if is_bundled(target):
        raise RuntimeError("model ships inside the app bundle and cannot be deleted")
    with _jobs_lock:
        job = _jobs.get(key)
        if job and job.status in {"queued", "running"}:
            raise RuntimeError("model is downloading; cancel it first")
        _jobs.pop(key, None)
    if target.is_dir():
        shutil.rmtree(target)
    return model_status(spec)


def missing_required_labels() -> list[str]:
    return [
        spec.label
        for spec in MODEL_SPECS
        if spec.required and model_status(spec)["status"] != "ready"
    ]
