# Reddify reverse proxy: official Caddy with the Reddify Caddyfiles baked in (read-only root filesystem).
# Caddyfile      = HTTPS (Caddy's internal CA for LAN/IP use, or an e-mail address for Let's Encrypt)
# Caddyfile.http = plain HTTP behind your own TLS reverse proxy (CADDY_CONFIG=Caddyfile.http)
FROM caddy:2.11-alpine
COPY Caddyfile Caddyfile.http /etc/caddy/
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
