"""Read-only loopback interface; never proxies media or arbitrary paths."""

import csv
import io
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .analysis import creator_reference, export_bundle, filter_records, summarize
from .data import canonical

WEB = Path(__file__).parent / "web"
CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; "
       "img-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'")


def safe_cell(value):
    text = "" if value is None else str(value)
    return "'" + text if text.lstrip().startswith(("=", "+", "-", "@")) or text.startswith(("\t", "\r", "\n")) else text


def csv_export(rows):
    fields = ("id", "post_id", "creator", "url", "published_at", "views", "video_play_count", "likes",
              "num_comments", "engagement_per_view", "duration", "product_type", "caption_cue",
              "metric_observed_at", "metric_collected_at", "availability", "evidence_type")
    stream = io.StringIO(newline="")
    writer = csv.writer(stream)
    writer.writerow(fields)
    writer.writerows([safe_cell(row[k]) for k in fields] for row in rows)
    return stream.getvalue().encode("utf-8-sig")


def handler_for(source, records):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args):
            pass

        def reply(self, status, content, kind="application/json; charset=utf-8", filename=None):
            self.send_response(status)
            for key, value in (("Content-Type", kind), ("Cache-Control", "no-store"),
                               ("Content-Security-Policy", CSP), ("X-Content-Type-Options", "nosniff"),
                               ("Referrer-Policy", "no-referrer"), ("Cross-Origin-Resource-Policy", "same-origin"),
                               ("Content-Length", str(len(content)))):
                self.send_header(key, value)
            if filename:
                self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.end_headers()
            self.wfile.write(content)

        def do_GET(self):
            hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            origins = {"http://" + h for h in hosts}
            if (self.headers.get("Host") not in hosts or self.headers.get("Origin", "") not in origins | {""}
                    or self.headers.get("Sec-Fetch-Site") == "cross-site"):
                return self.reply(403, b'{"error":"loopback same-origin requests only"}')
            parsed = urlsplit(self.path)
            try:
                if len(self.path) > 3000:
                    raise ValueError("query too long")
                path, query = parsed.path, parse_qs(parsed.query, keep_blank_values=True, max_num_fields=15)
                assets = {"/": ("lab.html", "text/html"), "/lab.css": ("lab.css", "text/css"),
                          "/lab.js": ("lab.js", "text/javascript")}
                if path in assets:
                    name, mime = assets[path]
                    return self.reply(200, (WEB / name).read_bytes(), mime + "; charset=utf-8")
                if path == "/api/overview":
                    result = {"source": source, "all_records": summarize(records),
                              "reels": summarize([r for r in records if r["product_type"] == "clips"])}
                elif path.startswith("/api/record/"):
                    row = next((r for r in records if r["id"] == path.removeprefix("/api/record/")), None)
                    if row is None:
                        return self.reply(404, b'{"error":"record not found"}')
                    result = {"record": row, "creator_reference": creator_reference(row, records), "source": source}
                elif path in ("/api/catalog", "/api/export.json", "/api/export.csv"):
                    selected = filter_records(records, query)
                    if path == "/api/export.json":
                        return self.reply(200, canonical(export_bundle(source, records, query)).encode(), filename="quant-lab-research.json")
                    if path == "/api/export.csv":
                        return self.reply(200, csv_export(selected), "text/csv; charset=utf-8", "quant-lab-records.csv")
                    page = int(query.get("page", ["1"])[0])
                    if not 1 <= page <= 1000:
                        raise ValueError("invalid page")
                    result = {"items": selected[(page - 1) * 24:page * 24], "total": len(selected),
                              "page": page, "pages": (len(selected) + 23) // 24, "summary": summarize(selected)}
                else:
                    return self.reply(404, b'{"error":"route not found"}')
                return self.reply(200, canonical(result).encode())
            except (TypeError, ValueError):
                return self.reply(400, b'{"error":"invalid filter or request"}')

        def do_POST(self):
            self.reply(405, b'{"error":"read-only service"}')

        do_PUT = do_POST
        do_PATCH = do_POST
        do_DELETE = do_POST
    return Handler


def create_server(source, records, port):
    return ThreadingHTTPServer(("127.0.0.1", port), handler_for(source, records))
