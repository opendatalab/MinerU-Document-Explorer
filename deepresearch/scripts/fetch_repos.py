#!/usr/bin/env python3
"""
DeepResearch 2.0 — GitHub 仓库 README 抓取

读取主题 yml 的 repos 数组（owner/repo），抓取 README + 仓库元信息为 Markdown
写入 deepresearch/sources/repos/。无需 token；触发 rate limit 时会跳过该项。

Usage:
  python3 deepresearch/scripts/fetch_repos.py \
      --topic deepresearch/topics/document-parsing.yml \
      --output deepresearch/sources/repos
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import yaml  # type: ignore
except ImportError:
    yaml = None  # type: ignore  # 延迟报错；--help 不需要


GITHUB_API = "https://api.github.com"
USER_AGENT = "deepresearch/2.0"
RATE_LIMIT_SECONDS = 1.5


def _gh_get(path: str, accept: str = "application/vnd.github+json") -> dict | list:
    url = f"{GITHUB_API}{path}"
    headers = {"User-Agent": USER_AGENT, "Accept": accept}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read().decode("utf-8")
    return json.loads(body)


def _slug(repo: str) -> str:
    return repo.replace("/", "__")


def fetch_one(repo: str, note: str | None, out_dir: Path) -> dict:
    print(f"  fetch {repo}", file=sys.stderr)
    info = _gh_get(f"/repos/{repo}")
    if not isinstance(info, dict):
        raise RuntimeError(f"unexpected response for {repo}")

    try:
        readme = _gh_get(f"/repos/{repo}/readme")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            readme = {"content": "", "encoding": "base64"}
        else:
            raise

    if isinstance(readme, dict) and readme.get("content"):
        if readme.get("encoding") == "base64":
            try:
                content = base64.b64decode(readme["content"]).decode("utf-8", errors="replace")
            except Exception:  # pragma: no cover
                content = ""
        else:
            content = str(readme.get("content", ""))
    else:
        content = ""

    title = info.get("full_name") or repo
    description = info.get("description") or ""
    stars = info.get("stargazers_count")
    homepage = info.get("homepage") or ""
    url = info.get("html_url") or f"https://github.com/{repo}"
    license_name = ((info.get("license") or {}) if isinstance(info.get("license"), dict) else {}).get("spdx_id", "")
    pushed = info.get("pushed_at", "")

    front = (
        f"---\n"
        f"title: {title}\n"
        f"source_url: {url}\n"
        f"source_kind: repo\n"
        f"stars: {stars}\n"
        f"license: {license_name}\n"
        f"pushed_at: {pushed}\n"
        f"homepage: {homepage}\n"
        f"---\n\n"
    )
    body = (
        f"# {title}\n\n"
        f"> {description}\n\n"
        f"- URL: {url}\n"
        f"- ⭐ Stars: {stars}\n"
        f"- License: {license_name or '未知'}\n"
        f"- Last push: {pushed}\n"
        + (f"- 备注：{note}\n" if note else "")
        + "\n---\n\n"
        + content
    )

    out_path = out_dir / f"{_slug(repo)}.md"
    out_path.write_text(front + body)
    return {
        "repo": repo,
        "title": title,
        "stars": stars,
        "url": url,
        "license": license_name,
        "path": str(out_path),
        "source_kind": "repo",
        "trust_level": "high" if (stars or 0) >= 1000 else "normal",
    }


def main() -> None:
    ap = argparse.ArgumentParser(description="抓取 GitHub README")
    ap.add_argument("--topic", required=True)
    ap.add_argument("--output", default="deepresearch/sources/repos")
    args = ap.parse_args()

    cfg = yaml.safe_load(Path(args.topic).read_text()) if yaml else None
    if cfg is None:
        print("ERROR: pyyaml 未安装。请执行: pip install pyyaml", file=sys.stderr)
        sys.exit(1)
    repos = cfg.get("repos") or []
    if not repos:
        print("没有 repos 条目，跳过。", file=sys.stderr)
        return

    out_dir = Path(args.output)
    out_dir.mkdir(parents=True, exist_ok=True)

    items: list[dict] = []
    errors: list[dict] = []
    for i, e in enumerate(repos, 1):
        if isinstance(e, dict):
            r = e.get("repo")
            note = e.get("note")
        else:
            r = str(e)
            note = None
        if not r or not re.match(r"^[\w.\-]+/[\w.\-]+$", r):
            continue
        print(f"[{i}/{len(repos)}]", file=sys.stderr)
        try:
            items.append(fetch_one(r, note, out_dir))
        except Exception as exc:  # pragma: no cover
            print(f"    FAILED {r}: {exc}", file=sys.stderr)
            errors.append({"repo": r, "error": str(exc)})
        time.sleep(RATE_LIMIT_SECONDS)

    meta = {"items": items, "errors": errors}
    (out_dir / "metadata.json").write_text(json.dumps(meta, indent=2, ensure_ascii=False))
    print(json.dumps({"repos": len(items), "errors": len(errors), "output": str(out_dir)}))


if __name__ == "__main__":
    main()
