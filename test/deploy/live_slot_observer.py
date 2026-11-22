from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ssl
import sys


class PeerAddressHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = self.client_address[0].encode("ascii")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


host, port, certificate, private_key = sys.argv[1:]
server = ThreadingHTTPServer((host, int(port)), PeerAddressHandler)
tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
tls.load_cert_chain(certificate, private_key)
server.socket = tls.wrap_socket(server.socket, server_side=True)
server.serve_forever()
