#!/usr/bin/env python3
"""Serve the verified static export locally, including the former preview URL."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

BASE = '/horizon'
LEGACY = '/gaussian-splatting-daily'
ROOT = Path(__file__).resolve().parents[1]


class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        self.serve_request()

    def do_HEAD(self):
        self.serve_request(head=True)

    def serve_request(self, head=False):
        parsed = urlsplit(self.path)
        path = parsed.path
        if path in ('/', BASE, LEGACY) or path.startswith(LEGACY + '/'):
            target = BASE + (path[len(LEGACY):] if path.startswith(LEGACY) else '/')
            if target == BASE:
                target += '/'
            self.send_response(307)
            self.send_header('Location', urlunsplit(('', '', target, parsed.query, parsed.fragment)))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if not path.startswith(BASE + '/'):
            self.send_error(404)
            return
        self.path = urlunsplit(('', '', path[len(BASE):], parsed.query, parsed.fragment))
        if head:
            super().do_HEAD()
        else:
            super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def log_message(self, format, *args):
        if len(args) > 1 and str(args[1]) not in ('200', '304'):
            super().log_message(format, *args)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=4337)
    parser.add_argument('--directory', type=Path, default=ROOT / 'site/out')
    args = parser.parse_args()
    if not (args.directory / 'index.html').is_file():
        parser.error('Build and verify the static export before previewing it')
    server = ThreadingHTTPServer(('127.0.0.1', args.port), partial(Handler, directory=str(args.directory)))
    print(f'Previewing {args.directory} at http://127.0.0.1:{args.port}{BASE}/', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
